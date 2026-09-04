---
name: biome
description: Install, init, migrate, and tune Biome (formatter + linter + import organizer) in any JS/TS project. This skill should be used when the user asks to "set up biome", "install biome", "init biome", "migrate to biome", "replace eslint with biome", "replace prettier with biome", "port eslint config to biome", "update or tune biome config", "migrate old biome config", or when biome.json, biome check/format/lint/ci need setting up, fixing, or adapting to a stack.
---

# Biome setup, migration, and tuning

One tool replaces ESLint, Prettier, and import sorting: one binary, one `biome.json`. This skill brings a project onto Biome from any starting state — no Biome at all, an old v1 config, or an existing eslint/prettier setup — then adapts the config to the project's stack.

## Workflow

Execute in order; if a step fails, read the script output before retrying — it names the exact cause.

1. Run the setup script:

   ```
   node <skill-dir>/scripts/setup-biome.mjs --cwd <project>
   ```

   It detects the package manager (npm/pnpm/yarn/bun), installs `@biomejs/biome@latest` if missing, upgrades and schema-migrates old configs (`biome migrate --write`), ports eslint config (`biome migrate eslint --write --include-inspired`, flat and legacy), ports prettier config (`biome migrate prettier --write`, with a manual fallback for JSON configs), and applies safe defaults (vcs integration via `.gitignore`, `files.ignoreUnknown`, assist with import organization). It prints a `===SETUP-RESULT===` JSON summary — read it before continuing.

2. Run the fine-tune script in dry-run mode:

   ```
   node <skill-dir>/scripts/fine-tune-biome.mjs --cwd <project>
   ```

   It detects frameworks (react/solid/qwik/astro), test runners, and generated code, then plans: lint domains, generated-file exclusions, assist actions, npm scripts (`lint` / `format` / `lint:fix`), and VS Code integration. Review the plan against the project's reality — the agent owns the judgment, the script only proposes.

3. Apply it: rerun with `--write`. Optional flags: `--strict` (stricter rules), `--aggressive-assist` (sorted keys/attributes actions), `--vscode` (editor settings). The script validates the resulting config with `biome check .` and rolls back if the config is broken.

4. Apply code fixes and review:
   - `<pm-exec> biome check .` — see everything (formatting, lint, assist).
   - `<pm-exec> biome check --write .` — safe fixes. Review the diff.
   - `<pm-exec> biome check --write --unsafe .` — optional; unsafe fixes change semantics (`type="button"`, template literals, optional chaining). Review carefully.
   - Fix the remainder by hand; re-run `biome check .` until clean.

5. Retire the old tools: confirm with the user first, then run the exact `<pm> remove ...` line printed in the setup summary and delete the old eslint/prettier config files. Only after `biome check .` is green and tests/build still pass.

6. Wire CI as a read-only gate: `biome ci .` — add `--error-on-warnings` for stricter gating, `--changed` for PR scope (requires vcs integration), `--reporter=github` for GitHub Actions annotations.

`<pm-exec>` per package manager: `npx biome` / `pnpm exec biome` / `yarn biome` / `bunx biome`.

## Scripts

Both are dependency-free Node (>= 18) and safe to run repeatedly.

| Script | Flags |
|---|---|
| `scripts/setup-biome.mjs` | `--cwd <dir>`, `--skip-install`, `--skip-eslint`, `--skip-prettier` |
| `scripts/fine-tune-biome.mjs` | `--cwd <dir>`, `--write`, `--strict`, `--aggressive-assist`, `--vscode` |

The scripts only rewrite `biome.json` (never `biome.jsonc`) and add npm scripts that do not exist yet; the only value they ever replace is a `lint` script that still invokes eslint.

## Cases the scripts do not fully automate

Handle these directly:

- **biome.jsonc** — scripts read but never rewrite JSONC. Convert to biome.json first, or apply the planned changes by hand.
- **JS-based eslint configs with plugin logic** — `migrate eslint` imports flat/legacy configs but cannot resolve arbitrary plugin presets; unresolvable plugins are skipped and reported. Map the important rules manually via `references/rule-mapping.md` (typescript-eslint, react-hooks, jsx-a11y all have Biome equivalents).
- **Prettier options with no Biome equivalent** — `quoteProps`, `proseWrap`, `endOfLine`, plugin-based options. Accept Biome's behavior or note the divergence to the user.
- **Monorepos** — run setup + fine-tune at the root; add per-package passes only where packages carry their own configs.
- **Other linters** — the setup script reports oxlint/stylelint configs when found. Nothing is portable mechanically: stylelint has no Biome equivalent for CSS linting (keep it if it matters); oxlint rules overlap Biome heavily (usually safe to drop after review).

## Verification

Done means: `biome check .` exits 0 with no diagnostics; the diff after any `--write --unsafe` pass has been reviewed; tests and build still pass; CI (if present) runs `biome ci .`. For config trouble, `biome rage` prints the loaded configuration and daemon logs.

## References

`references/rule-mapping.md` — prettier → biome option table and eslint/typescript-eslint/react-hooks → biome rule mapping, for manual ports when `biome migrate` cannot execute a config.
