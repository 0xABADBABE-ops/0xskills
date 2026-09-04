# 0xskills

Agent skills I use, published so they install anywhere:

    npx skills add 0xabadbabe-ops/0xskills

or one directly:

    npx skills add 0xabadbabe-ops/0xskills --skill biome

Each skill lives in its own folder under `skills/`. A skill is a SKILL.md plus whatever scripts it needs — the scripts do the mechanical work, the SKILL.md tells the agent what to check afterwards.

## biome

Sets up Biome in a project: installs it, inits or migrates the config, ports eslint and prettier settings (`biome migrate eslint --write --include-inspired` under the hood), then tunes the result to the stack — lint domains, generated-code exclusions, assist actions, npm scripts, editor settings. Dry-run first, validates with `biome check` after writing, rolls back if the config breaks. npm, pnpm, yarn and bun supported.
