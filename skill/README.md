# kept skill

Publish HTML pages and static sites to [kept](https://kept.host) from any coding agent and get a public link. No account needed: the agent hands you a live link and a claim link, and the page is a draft until you open the claim link and keep it.

Setup for every agent, with copy buttons: <https://kept.host/agents>.

## Install

```sh
# Codex, Claude Code, Cursor, OpenCode, Gemini CLI and every other skills.sh agent
npx skills add kept-host/skill --skill kept -g

# No npm: copies the skill into each agent found in your home directory (no sudo)
curl -fsSL https://kept.host/install.sh | sh
```

Then ask your agent: *"Make a one-page site about tide pools and publish it with kept."*

### As a plugin (skill + MCP server)

```sh
# Codex
codex plugin marketplace add kept-host/skill

# Claude Code
/plugin marketplace add kept-host/skill
/plugin install kept@kept
```

Cursor: install **kept** from the Cursor Marketplace.

### MCP only

The MCP server is `https://kept.host/mcp` (Streamable HTTP, no sign-in):

```sh
codex mcp add kept --url https://kept.host/mcp
claude mcp add --transport http kept https://kept.host/mcp
```

### Hermes

```sh
hermes skills install well-known:https://kept.host/.well-known/skills/kept
```

See [`hermes/`](hermes/README.md).

## Publish into your account

Create a free API key in kept's Settings and export it as `KEPT_API_KEY`, or let the agent sign you in:

```sh
skills/kept/scripts/publish.sh login you@example.com     # kept emails a 6-digit code
skills/kept/scripts/publish.sh login --code 123456       # saves a key in ~/.kept/credentials (0600)
```

With a key, pages go straight into the account: kept if a slot is free, else a draft.

## `publish.sh`

```
publish.sh [flags] <file-or-folder>
publish.sh --replace <manage_token|slug> [flags] <path>   # a page published without a key
publish.sh --page <slug> [flags] <path>                   # a page in your account
publish.sh delete <manage_token|slug>  |  delete --page <slug>
publish.sh login <email>  |  login --code <code>
```

Flags: `--title`, `--model`, `--tool`, `--prompt`, `--readme`, `--source-url`, `--remix-of`, `--spa`. A folder is zipped (`zip`, or Python's `zipfile`) and needs `index.html` at its root. Needs bash and curl.

| Exit | Meaning |
|---|---|
| 0 | Published (or replaced, deleted, signed in) |
| 2 | Your input: a bad flag, a missing file, `missing_index`, `page_too_large` / `site_too_large`, any other 4xx |
| 3 | `rate_limited`, or `publishing_paused` (kept paused publishing during an incident): the script prints how long to wait |
| 4 | Network, or kept answered 5xx |

The script never prints an API key. Tokens of pages published without a key are kept in `~/.kept/drafts.json` (0600).

## Source

This repository is a mirror. The source is `skill/` in the kept monorepo, where `SKILL.md`, `server.json` and the plugin manifests are generated from kept's agent copy and checked for drift. Change them there.

MIT licensed.
