# AGENTS.md

This repository is the kept skill: `skills/kept/SKILL.md` (what the agent reads) and `skills/kept/scripts/publish.sh` (what it runs).

## If you are an agent using kept

Read `skills/kept/SKILL.md` and run `skills/kept/scripts/publish.sh <file-or-folder>`. Always show the user both links it prints: the live link and the claim link.

## If you are changing this repository

- It is a mirror of `skill/` in the kept monorepo. `SKILL.md`, `server.json`, `mcp.json`, `.mcp.json` and the plugin manifests (`.codex-plugin/`, `.cursor-plugin/`, `.claude-plugin/`, `.agents/plugins/`) are generated there from kept's agent copy (`pnpm --filter @kept/web exec tsx scripts/build-skill.ts`). Do not edit them by hand.
- `publish.sh` is bash + curl only: no jq, no Node. It must pass `shellcheck` and keep its exit codes (0 ok, 2 input, 3 rate limited or paused, 4 network or server). It never prints an API key.
- CI (`.github/workflows/ci.yml`) runs shellcheck, the `npx skills add` install on Linux and macOS, and one live publish to kept's dev environment.
