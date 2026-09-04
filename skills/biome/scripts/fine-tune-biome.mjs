#!/usr/bin/env node
/**
 * fine-tune-biome — adapt biome.json (and the tooling around it) to the project.
 *
 * Detects frameworks, test runners, and generated code; plans and optionally
 * applies: lint domains, generated-file exclusions, assist actions, npm
 * scripts, and VS Code integration. Validates the result with biome check and
 * rolls back if the config is broken.
 *
 * Usage:
 *   node fine-tune-biome.mjs [--cwd <dir>] [--write] [--strict] [--aggressive-assist] [--vscode]
 *
 * Dry-run by default; the planned biome.json is printed for review.
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { values: opt } = parseArgs({
	options: {
		cwd: { type: "string" },
		write: { type: "boolean", default: false },
		strict: { type: "boolean", default: false },
		"aggressive-assist": { type: "boolean", default: false },
		vscode: { type: "boolean", default: false },
	},
	strict: false,
});

const cwd = path.resolve(opt.cwd || process.cwd());
const IS_WIN = process.platform === "win32";

const log = (m = "") => console.log(m);
const fail = (m) => {
	console.error(`error: ${m}`);
	process.exit(1);
};

function quoteArg(s) {
	if (IS_WIN) {
		return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, "")}"` : s;
	}
	return /[\s"']/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
function run(cmd, args) {
	const r = spawnSync([cmd, ...args].map(quoteArg).join(" "), {
		shell: true,
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 300_000,
	});
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

let PKG;
try {
	PKG = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
} catch {
	fail(`no readable package.json in ${cwd}`);
}

const CONFIG_FILES = ["biome.json", "biome.jsonc"];
let CONFIG_PATH = null;
for (const f of CONFIG_FILES) {
	const p = path.join(cwd, f);
	if (fs.existsSync(p)) CONFIG_PATH = p;
}
if (!CONFIG_PATH) {
	fail("no biome.json found — run scripts/setup-biome.mjs first");
}
if (path.basename(CONFIG_PATH) === "biome.jsonc") {
	fail("biome.jsonc is not rewritten by this script — convert to biome.json or apply changes manually");
}

const beforeText = fs.readFileSync(CONFIG_PATH, "utf8");
let before;
try {
	before = JSON.parse(beforeText);
} catch (e) {
	fail(`could not parse biome.json: ${e.message}`);
}
const beforePkgText = fs.readFileSync(path.join(cwd, "package.json"), "utf8");

const EXEC_PREFIX = {
	npm: ["npx", "--yes", "biome"],
	pnpm: ["pnpm", "exec", "biome"],
	yarn: ["yarn", "biome"],
	bun: ["bunx", "biome"],
};
function detectPM() {
	const has = (f) => fs.existsSync(path.join(cwd, f));
	if (has("bun.lockb") || has("bun.lock")) return "bun";
	if (has("pnpm-lock.yaml")) return "pnpm";
	if (has("yarn.lock")) return "yarn";
	return "npm";
}
const pm = detectPM();
const biome = (...a) => run(EXEC_PREFIX[pm][0], [...EXEC_PREFIX[pm].slice(1), ...a]);
const biomeInstalled = Boolean(
	PKG.devDependencies?.["@biomejs/biome"] || PKG.dependencies?.["@biomejs/biome"],
);

// --- detection -----------------------------------------------------------

const FRAMEWORK_DOMAINS = [
	["react", ["react", "react-dom", "next", "remix", "@remix-run/react", "gatsby", "react-native", "expo"]],
	["solid", ["solid-js"]],
	["qwik", ["@builder.io/qwik"]],
	["astro", ["astro"]],
	["test", ["vitest", "jest", "mocha", "@playwright/test", "ava", "tap", "@testing-library/react", "@testing-library/vue", "@testing-library/jest-dom"]],
	["cucumber", ["@cucumber/cucumber"]],
];
const deps = Object.keys({ ...PKG.dependencies, ...PKG.devDependencies });
const domains = FRAMEWORK_DOMAINS.filter(([, ds]) => ds.some((d) => deps.includes(d))).map(([n]) => n);

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", "coverage",
	".next", ".turbo", ".cache", ".output", "vendor", "bower_components", ".yarn",
]);
const GENERATED_DIRS = new Set(["generated", "__generated__", "__codegen__"]);
const excludes = new Set();
const exts = new Set();
let hasTests = false;
let budget = 20000;

function walk(dir, depth) {
	if (budget <= 0 || depth > 6) return;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			if (GENERATED_DIRS.has(e.name)) {
				excludes.add(`!**/${e.name}/**`);
				continue;
			}
			walk(p, depth + 1);
		} else {
			budget--;
			const dot = e.name.lastIndexOf(".");
			const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
			if (ext) exts.add(ext);
			if (/\.(test|spec)\.[a-z]+$/i.test(e.name)) hasTests = true;
			if (/(^|[-.])generated\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(e.name)) {
				excludes.add(`!**/${e.name}`);
			} else if (/\.generated\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(e.name)) {
				excludes.add(`!**/*.generated.${ext.slice(1)}`);
			}
		}
	}
}
walk(cwd, 0);
if (hasTests && !domains.includes("test")) domains.push("test");

// --- planning ------------------------------------------------------------

function indentOf(text) {
	return /^\{\r?\n\t/.test(text) ? "\t" : "  ";
}

function buildConfig(feats) {
	const cfg = structuredClone(before);
	const changes = [];
	const hasGit = fs.existsSync(path.join(cwd, ".git"));
	if (hasGit && cfg.vcs?.useIgnoreFile !== true) {
		cfg.vcs = {
			...cfg.vcs,
			enabled: cfg.vcs?.enabled ?? true,
			clientKind: cfg.vcs?.clientKind ?? "git",
			useIgnoreFile: cfg.vcs?.useIgnoreFile ?? true,
		};
		changes.push("vcs: respect .gitignore");
	}
	if (cfg.files?.ignoreUnknown !== true) {
		cfg.files = { ...cfg.files, ignoreUnknown: true };
		changes.push("files.ignoreUnknown: skip unknown file types");
	}
	if (excludes.size) {
		const inc = new Set(cfg.files?.includes ?? ["**"]);
		for (const e of excludes) inc.add(e);
		cfg.files = { ...cfg.files, includes: [...inc] };
		changes.push(`files.includes: exclude generated code (${[...excludes].join(", ")})`);
	}
	const source = { ...(cfg.assist?.actions?.source) };
	if (source.organizeImports !== "on") source.organizeImports = "on";
	if (feats.aggressive) {
		source.useSortedKeys ??= "on";
		source.useSortedAttributes ??= "on";
	}
	cfg.assist = {
		...cfg.assist,
		enabled: true,
		actions: { ...cfg.assist?.actions, source },
	};
	changes.push(
		`assist: enabled, organizeImports${feats.aggressive ? " + useSortedKeys + useSortedAttributes" : ""}`,
	);
	if (feats.domains && domains.length) {
		cfg.linter = { ...cfg.linter, enabled: cfg.linter?.enabled ?? true };
		const dom = { ...(cfg.linter?.domains ?? {}) };
		for (const d of domains) dom[d] ??= "all";
		cfg.linter.domains = dom;
		changes.push(`linter.domains: ${domains.join(", ")}`);
	}
	if (feats.strict) {
		cfg.linter = { ...cfg.linter, enabled: cfg.linter?.enabled ?? true };
		const rules = { ...(cfg.linter.rules ?? {}) };
		rules.correctness = { ...rules.correctness, noUnusedVariables: rules.correctness?.noUnusedVariables ?? "error" };
		rules.style = { ...rules.style, useImportType: rules.style?.useImportType ?? "error" };
		cfg.linter.rules = rules;
		changes.push("strict: correctness/noUnusedVariables=error, style/useImportType=error");
	}
	return { cfg, changes };
}

function buildPkg() {
	const p = structuredClone(PKG);
	const changes = [];
	p.scripts ??= {};
	if (!p.scripts.format) {
		p.scripts.format = "biome format --write .";
		changes.push('scripts.format = "biome format --write ."');
	}
	if (!p.scripts.lint) {
		p.scripts.lint = "biome check .";
		changes.push('scripts.lint = "biome check ."');
	} else if (/\beslint\b/.test(p.scripts.lint)) {
		p.scripts.lint = "biome check .";
		changes.push('scripts.lint = "biome check ." (was eslint)');
	}
	if (!p.scripts["lint:fix"]) {
		p.scripts["lint:fix"] = "biome check --write --unsafe .";
		changes.push('scripts.lint:fix = "biome check --write --unsafe ."');
	}
	return { p, changes };
}

function buildVscode() {
	const settingsPath = path.join(cwd, ".vscode", "settings.json");
	let s = {};
	try {
		s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {}
	const changes = [];
	s["editor.defaultFormatter"] ??= "biomejs.biome";
	if (s["editor.formatOnSave"] !== true) {
		s["editor.formatOnSave"] = true;
		changes.push(".vscode/settings.json: defaultFormatter + formatOnSave");
	}
	const coas = { ...(s["editor.codeActionsOnSave"] ?? {}) };
	if (!coas["source.organizeImports.biome"]) changes.push(".vscode/settings.json: organizeImports/quickfix/fixAll on save");
	coas["source.organizeImports.biome"] ??= "explicit";
	coas["quickfix.biome"] ??= "explicit";
	coas["source.fixAll.biome"] ??= "explicit";
	s["editor.codeActionsOnSave"] = coas;

	const extPath = path.join(cwd, ".vscode", "extensions.json");
	let e = { recommendations: [] };
	try {
		e = JSON.parse(fs.readFileSync(extPath, "utf8"));
	} catch {}
	e.recommendations = [...new Set([...(e.recommendations ?? []), "biomejs.biome"])];
	return { s, e, changes };
}

// --- main ----------------------------------------------------------------

log(`fine-tune-biome — ${cwd}`);
log(`package manager: ${pm} (${biomeInstalled ? "biome installed" : "biome NOT installed"})`);
log(`file types: ${[...exts].sort().join(" ") || "(none)"}`);
log(`domains: ${domains.length ? domains.join(", ") : "(none detected)"}`);
if (excludes.size) log(`generated code excluded: ${[...excludes].join(", ")}`);

const feats = { aggressive: opt["aggressive-assist"], strict: opt.strict, domains: true };
const { cfg: planned, changes } = buildConfig(feats);
const { p: plannedPkg, changes: pkgChanges } = buildPkg();
const vs = opt.vscode ? buildVscode() : null;

log("\nplanned changes:");
for (const c of changes) log(`  biome.json — ${c}`);
for (const c of pkgChanges) log(`  package.json — ${c}`);
if (vs) for (const c of vs.changes) log(`  ${c}`);
if (opt.strict) log("  biome.json — strict rules enabled (--strict)");
if (opt["aggressive-assist"]) log("  biome.json — aggressive assist actions (--aggressive-assist)");

if (!opt.write) {
	log("\ndry run — planned biome.json:");
	log(JSON.stringify(planned, null, 2));
	log('\nrerun with --write to apply');
	process.exit(0);
}

function writeAll(cfg, p, v) {
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, indentOf(beforeText))}\n`);
	fs.writeFileSync(
		path.join(cwd, "package.json"),
		`${JSON.stringify(p, null, indentOf(beforePkgText))}\n`,
	);
	if (v) {
		fs.mkdirSync(path.join(cwd, ".vscode"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".vscode", "settings.json"), `${JSON.stringify(v.s, null, 2)}\n`);
		fs.writeFileSync(path.join(cwd, ".vscode", "extensions.json"), `${JSON.stringify(v.e, null, 2)}\n`);
	}
}

function configIsValid() {
	if (!biomeInstalled) return null; // cannot validate
	const fmt = biome("format", "--write", path.basename(CONFIG_PATH));
	if (!fmt.ok) return false;
	const chk = biome("check", ".");
	// normal diagnostics reference source files; a mention of biome.json means the config itself is broken
	return !/biome\.json/.test(chk.out);
}

const attempts = [
	{ aggressive: feats.aggressive, strict: feats.strict, domains: true, label: "full plan" },
	{ aggressive: false, strict: feats.strict, domains: true, label: "without aggressive assist" },
	{ aggressive: false, strict: false, domains: true, label: "without strict rules" },
	{ aggressive: false, strict: false, domains: false, label: "without domains" },
];

let applied = null;
let appliedChanges = changes;
if (!biomeInstalled) {
	log("\nbiome not installed — writing without validation (run setup-biome.mjs first next time)");
	const built = buildConfig(attempts[0]);
	writeAll(built.cfg, plannedPkg, vs);
	appliedChanges = built.changes;
	applied = { label: attempts[0].label, validated: false };
} else {
	for (const a of attempts) {
		const built = buildConfig(a);
		writeAll(built.cfg, plannedPkg, vs);
		const valid = configIsValid();
		if (valid === true) {
			applied = { label: a.label, validated: true };
			appliedChanges = built.changes;
			break;
		}
		log(`config rejected (${a.label}) — trying a reduced plan`);
		fs.writeFileSync(CONFIG_PATH, beforeText);
		fs.writeFileSync(path.join(cwd, "package.json"), beforePkgText);
	}
}

if (!applied) {
	fail("all plans produced a broken config — original files restored; inspect with `biome check .`");
}

log(`\napplied: ${applied.label}${applied.validated ? " (validated with biome check)" : " (not validated)"}`);
log("planned package.json scripts:");
log(JSON.stringify(plannedPkg.scripts, null, 2));

log("\n===TUNE-RESULT===");
log(
	JSON.stringify(
		{
			cwd,
			packageManager: pm,
			domains,
			excludes: [...excludes],
			scripts: plannedPkg.scripts,
			vscode: Boolean(vs),
			applied: applied.label,
			validated: applied.validated,
			changes: [...appliedChanges, ...pkgChanges, ...(vs?.changes ?? [])],
		},
		null,
		2,
	),
);
log("\nnext steps:");
log(`  1. ${EXEC_PREFIX[pm].join(" ")} check .`);
log(`  2. ${EXEC_PREFIX[pm].join(" ")} check --write .`);
log("  3. review the diff, fix the remainder by hand");
