#!/usr/bin/env node
/**
 * setup-biome — bring a JS/TS project onto Biome from any starting state.
 *
 * Detects the package manager, installs/upgrades @biomejs/biome, initializes
 * or schema-migrates biome.json, ports eslint and prettier configuration, and
 * applies safe defaults (vcs integration, files.ignoreUnknown, assist with
 * import organization). Never deletes dependencies or files.
 *
 * Usage:
 *   node setup-biome.mjs [--cwd <dir>] [--skip-install] [--skip-eslint] [--skip-prettier]
 *
 * Machine-readable summary: the JSON block after ===SETUP-RESULT===.
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { values: opt } = parseArgs({
	options: {
		cwd: { type: "string" },
		"skip-install": { type: "boolean", default: false },
		"skip-eslint": { type: "boolean", default: false },
		"skip-prettier": { type: "boolean", default: false },
	},
	strict: false,
});

const cwd = path.resolve(opt.cwd || process.cwd());
const IS_WIN = process.platform === "win32";

const result = {
	cwd,
	packageManager: null,
	biomeVersion: null,
	upgraded: false,
	initialized: false,
	schemaMigrated: false,
	eslintPorted: false,
	prettierPorted: false,
	config: null,
	notes: [],
	suggestedRemovals: [],
};

const log = (m = "") => console.log(m);
const note = (m) => {
	result.notes.push(m);
	log(`  note: ${m}`);
};
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
	return {
		ok: r.status === 0,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error ? String(r.error) : ""),
	};
}

let PKG;
try {
	PKG = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
} catch {
	fail(
		`no readable package.json in ${cwd} — initialize the project first (npm init -y / pnpm init / yarn init)`,
	);
}

const INSTALL_ARGS = {
	npm: ["install", "-D"],
	pnpm: ["add", "-D"],
	yarn: ["add", "-D"],
	bun: ["add", "-d"],
};
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
result.packageManager = pm;
const biome = (...a) =>
	run(EXEC_PREFIX[pm][0], [...EXEC_PREFIX[pm].slice(1), ...a]);

function reloadPkg() {
	try {
		PKG = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
	} catch {}
}
function installedBiome() {
	return (
		PKG.devDependencies?.["@biomejs/biome"] ??
		PKG.dependencies?.["@biomejs/biome"] ??
		null
	);
}
function latestBiome() {
	const r = run("npm", ["view", "@biomejs/biome", "version"]);
	return r.ok ? (r.out.split(/\r?\n/).pop() || "").trim() : null;
}
function cmpVersion(a, b) {
	const pa = a.replace(/^[\^~>?=|]*v?/, "").split(/[^\d.]/)[0].split(".").map(Number);
	const pb = b.replace(/^[\^~>?=|]*v?/, "").split(/[^\d.]/)[0].split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

const CONFIG_FILES = ["biome.json", "biome.jsonc"];
function configPath() {
	for (const f of CONFIG_FILES) {
		const p = path.join(cwd, f);
		if (fs.existsSync(p)) return p;
	}
	return null;
}
function configText() {
	const p = configPath();
	return p ? fs.readFileSync(p, "utf8") : null;
}
function looksLikeV1(text) {
	if (/\/schemas\/1\./.test(text)) return true;
	try {
		return Object.hasOwn(JSON.parse(text), "organizeImports");
	} catch {
		return true; // unparseable (e.g. JSONC) — let biome migrate decide
	}
}

const ESLINT_FLAT = [
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	"eslint.config.mts",
	"eslint.config.cts",
];
const ESLINT_LEGACY = [
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yaml",
	".eslintrc.yml",
];
const PRETTIER_FILES = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.toml",
];
const OTHER_LINTERS = [
	".oxlintrc.json",
	".stylelintrc",
	".stylelintrc.json",
	".stylelintrc.js",
	".stylelintrc.cjs",
	".stylelintrc.yaml",
];

function findExisting(names) {
	for (const f of names) if (fs.existsSync(path.join(cwd, f))) return f;
	return null;
}

function indentOf(text) {
	return /^\{\r?\n\t/.test(text) ? "\t" : "  ";
}
function writeConfig(cfg) {
	const p = configPath();
	fs.writeFileSync(
		p,
		`${JSON.stringify(cfg, null, indentOf(configText() ?? ""))}\n`,
	);
}

function applyBaseline() {
	const p = configPath();
	if (!p) return note("no biome config to apply defaults to");
	if (path.basename(p) === "biome.jsonc") {
		return note(
			"biome.jsonc found — scripts do not rewrite JSONC; enable assist/vcs/files defaults manually",
		);
	}
	let cfg;
	try {
		cfg = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch (e) {
		return note(`could not parse biome.json: ${e.message}`);
	}
	const hasGit = fs.existsSync(path.join(cwd, ".git"));
	if (hasGit) {
		cfg.vcs = {
			...cfg.vcs,
			enabled: cfg.vcs?.enabled ?? true,
			clientKind: cfg.vcs?.clientKind ?? "git",
			useIgnoreFile: cfg.vcs?.useIgnoreFile ?? true,
		};
	}
	cfg.files = { ...cfg.files, ignoreUnknown: true };
	cfg.assist = {
		...cfg.assist,
		enabled: true,
		actions: {
			...cfg.assist?.actions,
			source: {
				...cfg.assist?.actions?.source,
				organizeImports: cfg.assist?.actions?.source?.organizeImports ?? "on",
			},
		},
	};
	writeConfig(cfg);
}

const PRETTIER_MAP = {
	printWidth: { path: ["formatter", "lineWidth"] },
	tabWidth: { path: ["formatter", "indentWidth"] },
	useTabs: { path: ["formatter", "indentStyle"], map: (v) => (v ? "tab" : "space") },
	semi: {
		path: ["javascript", "formatter", "semicolons"],
		map: (v) => (v ? "always" : "asNeeded"),
	},
	singleQuote: {
		path: ["javascript", "formatter", "quoteStyle"],
		map: (v) => (v ? "single" : "double"),
	},
	jsxSingleQuote: {
		path: ["javascript", "formatter", "jsxQuoteStyle"],
		map: (v) => (v ? "single" : "double"),
	},
	trailingComma: { path: ["javascript", "formatter", "trailingCommas"] },
	bracketSpacing: { path: ["javascript", "formatter", "bracketSpacing"] },
	bracketSameLine: { path: ["javascript", "formatter", "bracketSameLine"] },
	arrowParens: {
		path: ["javascript", "formatter", "arrowParentheses"],
		map: (v) => (v === "avoid" ? "asNeeded" : "always"),
	},
};
const NO_EQUIVALENT = [
	"quoteProps",
	"proseWrap",
	"endOfLine",
	"htmlWhitespaceSensitivity",
	"singleAttributePerLine",
	"embeddedLanguageFormatting",
];

function applyPrettierFallback(prettierCfg) {
	const p = configPath();
	if (!p || path.basename(p) === "biome.jsonc") {
		throw new Error("biome.json (not .jsonc) is required for the manual port");
	}
	const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
	const unmapped = [];
	for (const [key, value] of Object.entries(prettierCfg || {})) {
		const m = PRETTIER_MAP[key];
		if (!m) {
			unmapped.push(`${key} (${NO_EQUIVALENT.includes(key) ? "no biome equivalent" : "unrecognized"})`);
			continue;
		}
		let o = cfg;
		for (const k of m.path.slice(0, -1)) {
			o[k] = typeof o[k] === "object" && o[k] !== null ? o[k] : {};
			o = o[k];
		}
		o[m.path[m.path.length - 1]] = m.map ? m.map(value) : value;
	}
	writeConfig(cfg);
	if (unmapped.length) note(`prettier options not portable: ${unmapped.join(", ")}`);
}

// ---------------------------------------------------------------- main ---

log(`setup-biome — ${cwd}`);
log(`package manager: ${pm}`);

// 1. install / upgrade
let installed = installedBiome();
const latest = latestBiome();
if (!installed && !opt["skip-install"]) {
	log("[1] installing @biomejs/biome@latest...");
	const r = run(pm, [...INSTALL_ARGS[pm], "@biomejs/biome@latest"]);
	if (!r.ok && !biome("--version").ok) fail(`install failed:\n${r.out}`);
	if (!r.ok) note("install command did not exit cleanly, but biome runs — continuing");
	reloadPkg();
	installed = installedBiome();
	result.biomeVersion = installed;
	log(`    installed ${installed}`);
} else if (installed && latest && cmpVersion(installed, latest) < 0 && !opt["skip-install"]) {
	log(`[1] upgrading @biomejs/biome ${installed} -> ${latest}...`);
	const r = run(pm, [...INSTALL_ARGS[pm], "@biomejs/biome@latest"]);
	if (!r.ok) {
		if (biome("--version").ok) {
			note("upgrade command did not exit cleanly, but biome runs — continuing");
			reloadPkg();
			installed = installedBiome();
			result.upgraded = true;
			result.biomeVersion = installed;
		} else {
			note(`upgrade failed, continuing on ${installed}:\n${r.out}`);
		}
	} else {
		reloadPkg();
		installed = installedBiome();
		result.upgraded = true;
		result.biomeVersion = installed;
	}
} else {
	log(
		`[1] biome ${installed ?? "(not in package.json)"}${latest ? `, latest ${latest}` : ""} — nothing to install`,
	);
	result.biomeVersion = installed;
}
if (!installed && opt["skip-install"]) {
	note("install skipped and biome absent from package.json — npx will fetch it on demand");
}

// 2. init
if (!configPath()) {
	log("[2] no biome config found — biome init...");
	const r = biome("init");
	if (!r.ok) fail(`biome init failed:\n${r.out}`);
	result.initialized = true;
} else {
	log(`[2] config found: ${path.basename(configPath())}`);
}
result.config = configPath() ? path.basename(configPath()) : null;

// 3. schema migration
const text0 = configText();
if (text0 && (result.upgraded || looksLikeV1(text0))) {
	log("[3] migrating config to current schema (biome migrate --write)...");
	const r = biome("migrate", "--write");
	if (!r.ok) note(`schema migration reported issues:\n${r.out}`);
	else result.schemaMigrated = true;
} else {
	log("[3] config schema is current — no migration needed");
}

// 4. eslint port
if (!opt["skip-eslint"]) {
	const flat = findExisting(ESLINT_FLAT);
	const legacy = findExisting(ESLINT_LEGACY);
	const inlineFile = PKG.eslintConfig ? ".biome-eslintrc.tmp.json" : null;

	if (!flat && !legacy && !inlineFile) {
		log("[4] no eslint config found — nothing to port");
	} else {
		log("[4] porting eslint config (migrate eslint --write --include-inspired)...");
		let r = biome("migrate", "eslint", "--write", "--include-inspired");
		if (!r.ok && legacy) {
			note("auto-detection failed, retrying with --eslint-config-path");
			r = biome("migrate", "eslint", "--write", "--include-inspired", "--eslint-config-path", legacy);
		}
		if (!r.ok && inlineFile) {
			fs.writeFileSync(path.join(cwd, inlineFile), JSON.stringify(PKG.eslintConfig, null, 2));
			r = biome("migrate", "eslint", "--write", "--include-inspired", "--eslint-config-path", inlineFile);
			fs.rmSync(path.join(cwd, inlineFile), { force: true });
		}
		if (r.ok) {
			result.eslintPorted = true;
			log("    eslint rules imported into biome.json");
			const interesting = r.out
				.split(/\r?\n/)
				.filter((l) => /inspired|unsupported|couldn|skipped|migrated/i.test(l))
				.slice(0, 10);
			if (interesting.length) log(`    ${interesting.join("\n    ")}`);
		} else {
			note(
				`eslint migration failed — port rules manually (references/rule-mapping.md):\n${r.out.split(/\r?\n/).slice(-8).join("\n")}`,
			);
		}
	}
} else {
	log("[4] eslint port skipped");
}

// 5. prettier port
if (!opt["skip-prettier"]) {
	const file = findExisting(PRETTIER_FILES);
	const inlineFile = PKG.prettier ? ".biome-prettierrc.tmp.json" : null;

	if (!file && !inlineFile) {
		log("[5] no prettier config found — nothing to port");
	} else {
		log("[5] porting prettier config (migrate prettier --write)...");
		let r = biome("migrate", "prettier", "--write");
		if (!r.ok && file) {
			note("auto-detection failed, retrying with --prettier-path");
			r = biome("migrate", "prettier", "--write", "--prettier-path", file);
		}
		if (!r.ok && inlineFile) {
			fs.writeFileSync(path.join(cwd, inlineFile), JSON.stringify(PKG.prettier, null, 2));
			r = biome("migrate", "prettier", "--write", "--prettier-path", inlineFile);
			fs.rmSync(path.join(cwd, inlineFile), { force: true });
		}
		if (r.ok) {
			result.prettierPorted = true;
			log("    prettier settings imported into biome.json");
		} else {
			const jsonable =
				!file || file === ".prettierrc" || file.endsWith(".json") || (inlineFile && !file);
			let done = false;
			if (jsonable) {
				try {
					const raw = file
						? fs.readFileSync(path.join(cwd, file), "utf8")
						: JSON.stringify(PKG.prettier);
					applyPrettierFallback(JSON.parse(raw));
					result.prettierPorted = true;
					done = true;
					note("ported prettier options manually (biome migrate prettier unavailable or failed)");
				} catch (e) {
					note(`manual prettier port failed: ${e.message}`);
				}
			}
			if (!done) {
				note(
					`prettier migration failed — port manually (references/rule-mapping.md):\n${r.out.split(/\r?\n/).slice(-8).join("\n")}`,
				);
			}
		}
	}
} else {
	log("[5] prettier port skipped");
}

// other linters: report only
for (const f of OTHER_LINTERS) {
	if (fs.existsSync(path.join(cwd, f))) {
		note(
			`found ${f} — not portable to biome; review and remove after migration (stylelint covers CSS linting Biome does not)`,
		);
	}
}

// 6. safe defaults
log("[6] applying safe defaults (vcs, files.ignoreUnknown, assist)...");
applyBaseline();

// 7. removal suggestions + summary
reloadPkg();
const depNames = Object.keys({ ...PKG.devDependencies, ...PKG.dependencies });
const eslintConfigExists =
	Boolean(findExisting([...ESLINT_FLAT, ...ESLINT_LEGACY])) || Boolean(PKG.eslintConfig);
const removable = depNames.filter((d) => {
	const eslintSide = /^(eslint|eslint-plugin-|eslint-config-|@eslint\/|@typescript-eslint\/)/.test(d);
	const prettierSide = /^(prettier|@prettier\/)/.test(d);
	return (
		(eslintSide && (result.eslintPorted || !eslintConfigExists)) ||
		(prettierSide && result.prettierPorted)
	);
});
if (removable.length) {
	result.suggestedRemovals = removable;
	log("\nafter biome is green and tests/build pass, remove the old tooling:");
	log(`  ${pm} remove ${removable.join(" ")}`);
	log("  ...and delete the old eslint/prettier config files listed above.");
}

log("\nnext steps:");
log(`  1. node <skill-dir>/scripts/fine-tune-biome.mjs --cwd "${cwd}"`);
log(`  2. node <skill-dir>/scripts/fine-tune-biome.mjs --cwd "${cwd}" --write`);
log(`  3. ${EXEC_PREFIX[pm].join(" ")} check .`);
log(`  4. ${EXEC_PREFIX[pm].join(" ")} check --write .`);

log("\n===SETUP-RESULT===");
log(JSON.stringify(result, null, 2));
