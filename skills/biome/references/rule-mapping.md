# Manual config porting — eslint/prettier → Biome

Used when `biome migrate` cannot execute a config (JS configs with plugin logic, unsupported formats) or when leftovers need mapping by hand. Verify any rule with `biome explain <rule>` — the full catalog lives at https://biomejs.dev/linter/rules/.

## Prettier → Biome

| Prettier | Biome | Notes |
|---|---|---|
| `printWidth` (80) | `formatter.lineWidth` | |
| `tabWidth` (2) | `formatter.indentWidth` | |
| `useTabs` (false) | `formatter.indentStyle`: `"tab"` / `"space"` | |
| `semi` (true) | `javascript.formatter.semicolons`: `"always"` / `"asNeeded"` | |
| `singleQuote` (false) | `javascript.formatter.quoteStyle` | |
| `jsxSingleQuote` (false) | `javascript.formatter.jsxQuoteStyle` | |
| `trailingComma` ("all") | `javascript.formatter.trailingCommas`: `"all"` / `"es5"` / `"none"` | |
| `bracketSpacing` (true) | `javascript.formatter.bracketSpacing` | |
| `bracketSameLine` (false) | `javascript.formatter.bracketSameLine` | |
| `arrowParens` ("always") | `javascript.formatter.arrowParentheses`: `"always"` / `"asNeeded"` | `"avoid"` → `"asNeeded"` |
| `quoteProps`, `proseWrap`, `endOfLine`, `htmlWhitespaceSensitivity`, `singleAttributePerLine`, plugins | — | no Biome equivalent; accept the divergence |

CSS/JSON formatting inherits `formatter.lineWidth`, `indentStyle`, `indentWidth`. `.prettierignore` → rely on `vcs.useIgnoreFile: true` plus `files.includes` negations.

Note: `biome migrate prettier` (2.5.x) writes `quoteStyle: "single"` and `semicolons: "asNeeded"` into `javascript.formatter` even when the prettier config left them at prettier defaults (double quotes, semicolons). If the project relied on prettier defaults, set `quoteStyle: "double"` / `semicolons: "always"` after migrating.

## ESLint → Biome

Core rules:

| ESLint | Biome | Notes |
|---|---|---|
| `no-unused-vars` | `correctness/noUnusedVariables` | prefix `_` to exempt; `argsIgnorePattern` has no option |
| `no-console` | `suspicious/noConsole` | |
| `no-debugger` | `suspicious/noDebugger` | |
| `prefer-const` | `style/useConst` | |
| `no-var` | `style/noVar` | |
| `no-template-curly-in-string` | `suspicious/noTemplateCurlyInString` | |
| `no-undef` | — | no JS undefined-variable check; use TypeScript, or declare via `javascript.globals` |

typescript-eslint:

| typescript-eslint | Biome | Notes |
|---|---|---|
| `no-explicit-any` | `suspicious/noExplicitAny` | |
| `no-non-null-assertion` | `style/noNonNullAssertion` | |
| `consistent-type-imports` | `style/useImportType` | |
| `no-unused-vars` | `correctness/noUnusedVariables` | same as core |
| `no-floating-promises` | nursery `noFloatingPromises` (recent Biome) | check availability with `biome explain` |

React / hooks / a11y:

| ESLint | Biome | Notes |
|---|---|---|
| `react-hooks/rules-of-hooks` | `correctness/useHooks` | |
| `react-hooks/exhaustive-deps` | `correctness/useExhaustiveDependencies` | |
| `react/jsx-key` | `correctness/useJsxKeyInIterable` | |
| `jsx-a11y/alt-text` | `a11y/useAltText` | |
| `jsx-a11y/no-autofocus` | `a11y/noAutofocus` | |
| `jsx-a11y/...` (most rules) | `a11y/*` | naming is close but not identical — check the catalog |

Import plugin:

| ESLint | Biome | Notes |
|---|---|---|
| `import/no-duplicates` | Biome flags duplicate imports natively | |
| `import/order` | assist `source.organizeImports` | enforced by organizing, not by lint severity |
| `import/no-unresolved` | — | resolution is not Biome's job; TypeScript covers it |

When a rule has no equivalent, decide explicitly: drop it, approximate with the closest Biome rule, or keep a minimal eslint setup just for that plugin — in that case Biome handles formatting and its own lint set, eslint runs lint-only alongside.
