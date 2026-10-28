# Agents: distribution and the skill mirror

E09 (`.agent/Tasks/prds/E09-agents.md` §5.6). How kept reaches coding agents, what is
live where, and the steps only Arun can take.

## Channels

| Channel | What it uses | How it ships | Status |
|---|---|---|---|
| skills.sh (`npx skills add kept-host/skill --skill kept -g`) | `skills/kept/` | Listed once people install it; ranked by installs | Waits on the `kept-host/skill` mirror |
| `curl -fsSL https://kept.host/install.sh \| sh` | `/install.sh` (apps/web) downloads from the mirror's `main` | Ships with the app | Built; works once the mirror exists |
| ClawHub | `skills/kept/` | `clawhub skill publish` (automatic scan) | Not submitted |
| Hermes | `/.well-known/skills/index.json`, `/skill.md` | Ships with the app; optional PR to `optional-skills/` (`skill/hermes/README.md`) | Built; PR not opened |
| Codex | `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `mcp.json` | Git marketplace: `codex plugin marketplace add kept-host/skill`; official listing when self-serve opens | Waits on the mirror |
| Cursor Marketplace | `.cursor-plugin/plugin.json`, `mcp.json` | Submit for review (~2 weeks; open source required) | Not submitted |
| Claude Code plugins | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.mcp.json` | `/plugin marketplace add kept-host/skill` | Waits on the mirror |
| MCP Registry | `server.json` (`host.kept/kept`) | `mcp-publisher publish` after a DNS TXT proof on `kept.host` | Not submitted |
| Smithery / Glama | `https://kept.host/mcp` | Paste the URL | Not submitted |
| Claude chat | `https://kept.host/mcp` as a custom connector, no sign-in | Documented on `/agents`; no directory submission (D11) | Built |

There is no ChatGPT app, connector or listing (D11).

## Errors an agent sees

The skill's `publish.sh`, the MCP tools (`isError: true` + the same body) and the HTTP API
share one flat body: `{ "error": "<code>", "message": "…", "retry_after_seconds"? }`.

| Code | HTTP | `publish.sh` exit | What the agent should do |
|---|---|---|---|
| `rate_limited` | 429 | 3 | Wait `retry_after_seconds` |
| `publishing_paused` | 503 | 3 | kept paused publishing during an incident (`KEPT_PUBLISH_PAUSED`); serving, deletes and keeps still work. Wait `retry_after_seconds` |
| `missing_index`, `invalid_path`, `site_too_large`, `page_too_large`, `too_many_files`, `file_too_large`, `file_type_not_allowed`, `invalid_file`, `invalid_archive`, `empty_page`, `invalid_request` | 400 / 413 / 422 | 2 | Fix the input |
| `unauthorized`, `not_found`, `not_allowed_in_status`, `key_limit_reached`, `invalid_code` (keyed and sign-in only) | 401 / 404 / 409 / 400 | 2 | Fix the key, the slug or the code |
| `internal_error`, `slug_unavailable` | 5xx | 4 | Retry later |
| network failure | — | 4 | Retry later |

## The skill source and its mirror (Q1)

The source is `skill/` in this repo, MIT licensed (the app is AGPL). `skills/kept/SKILL.md`,
`server.json`, `mcp.json`, `.mcp.json` and the plugin manifests are generated from
`packages/shared/src/agent-copy.ts` and `apps/web/lib/agents/skill-files.ts`:

```sh
pnpm --filter @kept/web exec tsx scripts/build-skill.ts
```

`apps/web/lib/agents/skill-drift.test.ts` fails when a checked-in file differs from what
the build writes, when `server.json` stops validating against the vendored MCP Registry
schema, or when `publish.sh` fails shellcheck. `README.md`, `AGENTS.md`, `LICENSE`,
`hermes/`, `.github/workflows/ci.yml` and `skills/kept/scripts/publish.sh` are hand-written.

**Mirroring:** `.github/workflows/mirror-skill.yml` pushes `skill/` (with its history,
via `git subtree split`) to the root of `kept-host/skill` on every push to `develop` that
touches `skill/**`, and on demand (Actions → Mirror skill → Run workflow). The mirror is
read-only: edit here, never there.

One-time setup (Arun):

1. Create the public repo `kept-host/skill`, empty (no README).
2. `ssh-keygen -t ed25519 -f skill_deploy -N "" -C kept-skill-mirror`.
3. `kept-host/skill` → Settings → Deploy keys → add `skill_deploy.pub`, **Allow write access**.
4. `kept-host/kept` → Settings → Secrets and variables → Actions → `SKILL_MIRROR_DEPLOY_KEY`
   = the contents of `skill_deploy` (the private half). Delete both local files.
5. Run the workflow once by hand. `kept-host/skill` → Settings → Secrets → Actions →
   `KEPT_DEV_API_KEY` for its own CI.
6. Protect the mirror's `main` (only the deploy key pushes); its README already points
   issues and PRs here.

At launch (E14) switch the workflow's branch from `develop` to `main`.

Fallback by hand:

```sh
git subtree split --prefix=skill -b skill-mirror
git push git@github.com:kept-host/skill.git skill-mirror:main
```

`/install.sh` downloads from `raw.githubusercontent.com/kept-host/skill/main/skills/kept`,
so the mirror's `main` is what every curl install gets.

## Human steps (Arun)

1. Create the public repo `kept-host/skill` and mirror `skill/` into it.
2. Set its repository secret `KEPT_DEV_API_KEY` (a key made in dev Settings) for the keyed CI step; the keyless step needs none.
3. After the dev tag: run the skill and the MCP server in Codex, Claude Code and Cursor ("publish ./demo with kept"); record the runs in the PR (AC2, AC5).
4. Post-merge: ClawHub, MCP Registry (`host.kept/kept`, DNS TXT on `kept.host`), Smithery / Glama, the Cursor plugin submission, the optional Hermes PR. Update the Status column above as each lands.
5. If Cloudflare bot protection is on for `kept.host`, add a skip rule for `/mcp` and `/install.sh`.
6. `MCP_SESSION_SECRET` on dev Railway; on prod in E14 (`docs/prod-release.md` §4.1).
