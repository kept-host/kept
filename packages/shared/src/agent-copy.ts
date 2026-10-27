// @kept/shared — every word kept says to an agent (E09 D12). The prompt a
// human pastes, the MCP tool descriptions, the skill's `SKILL.md`, the per-agent
// setup steps on `/agents`, `/install.sh`, `/llms.txt` and the Hermes skills
// index are all built here, so the server, the docs and the skill cannot drift.
// `lib/agents/copy-single-source.test.ts` fails if this copy appears anywhere
// else; the skill repo's `SKILL.md` is generated from `skillMarkdown`.
//
// Everything that names a URL takes `base` — the landing origin
// (`https://kept.host` in prod, `https://kept-dev.xyz` on dev) — from the
// caller's configuration. No origin is hard-coded here.
//
// D11: kept builds for coding agents and Claude chat (a custom connector off the
// same MCP server). There is no ChatGPT app, connector, card or copy — this
// comment is the one place the name appears.

import { DRAFT_TTL_DAYS } from "./constants";
import { limitsFor } from "./plans";

/** The public skill repo (Q1: source in this monorepo's `skill/`, mirrored there). */
export const SKILL_REPO = "kept-host/skill";

/** The skill's name — its folder in every agent's skills directory. */
export const SKILL_NAME = "kept";

/** The skills.sh install — Codex, Claude Code, Cursor, OpenCode, Gemini CLI and more. */
export const SKILL_INSTALL_COMMAND = `npx skills add ${SKILL_REPO} --skill ${SKILL_NAME} -g`;

/** Where `/install.sh` downloads `SKILL.md` and `scripts/publish.sh` from. */
export const SKILL_SOURCE_URL = `https://raw.githubusercontent.com/${SKILL_REPO}/main/skills/${SKILL_NAME}`;

/** The env var the skill, the MCP setups and the REST examples read a key from. */
export const API_KEY_ENV = "KEPT_API_KEY";

export function mcpUrl(base: string): string {
  return `${base}/mcp`;
}

/** The no-npm install: `/install.sh` piped to `sh`. */
export function installCommand(base: string): string {
  return `curl -fsSL ${base}/install.sh | sh`;
}

const MB = 1024 * 1024;

/** The free-plan numbers the copy quotes — never literals. */
function freeLimits() {
  const free = limitsFor("free");
  return {
    keptPages: free.keptPages,
    siteMb: Math.round(free.siteBytes / MB),
    siteFiles: free.siteFiles,
    fileMb: Math.round(free.fileBytes / MB),
  };
}

// --- The prompt (PRD §5.5) ---------------------------------------------------

/** The one line a human pastes into any agent. The landing (E13) copies this. */
export function agentPrompt(base: string): string {
  return (
    "Publish this with kept (free, no account). If you have shell access, run: " +
    `\`${SKILL_INSTALL_COMMAND}\`, then use the kept skill. Otherwise POST the HTML ` +
    `as JSON {"html": "…"} to ${base}/api/publish. Give me the live link and the claim link.`
  );
}

// --- MCP tool descriptions (PRD §5.3; Q2: the keyless token is `manage_token`) -

const DRAFT_NOTE = `A draft serves for ${DRAFT_TTL_DAYS} days unless the human keeps it.`;

export const MCP_TOOL_DESCRIPTIONS = {
  keyless: {
    publish_page:
      "Publish an HTML page or a static site to kept and get a public link. Pass `html` for one page, " +
      "or `files` (path + content, `index.html` at the root) for a site; set `spa` for client-routed apps. " +
      "Optional provenance: title, model, tool, prompt, readme, source_url. Returns live_url, claim_url, " +
      `manage_token, expires_at and expires_in. ${DRAFT_NOTE} Always show the human both links; keep ` +
      "manage_token to change or delete the page later instead of publishing again.",
    replace_page:
      "Replace the content of a page you published, keeping its URL. Pass its `manage_token` and new " +
      "`html` or `files`. Use this to iterate instead of publishing a new page.",
    get_page:
      "Read a page you published by its `manage_token`: its live_url, claim_url, expiry, whether it has " +
      "been kept, and its provenance.",
    delete_page:
      "Stop serving a page you published, by its `manage_token`. The link stops working. Only when the " +
      "human asks.",
  },
  keyed: {
    publish_page:
      "Publish an HTML page or a static site into the human's kept account. Pass `html` for one page, " +
      "or `files` (path + content, `index.html` at the root) for a site; set `spa` for client-routed apps. " +
      "Optional provenance: title, model, tool, prompt, readme, source_url. Returns live_url, studio_url, " +
      "slug, kept and expires_at. The page is kept if the account has a free slot, else it lands as a " +
      `draft (kept: false). ${DRAFT_NOTE}`,
    replace_page:
      "Replace the content of a page in the account, keeping its URL. Pass its `page` (the slug) and new " +
      "`html` or `files`. Use this to iterate instead of publishing a new page.",
    list_pages:
      "List the account's pages, newest first. Pass `cursor` from the previous answer's next_cursor to " +
      "page through.",
    get_page: "Read one page in the account by its `page` (the slug): links, kept or draft, provenance.",
    delete_page:
      "Stop serving a page in the account, by its `page` (the slug). The link stops working. Only when " +
      "the human asks.",
  },
} as const;

// --- SKILL.md (PRD §5.1) -----------------------------------------------------

/** The skill's `SKILL.md`, frontmatter included. `skill/skills/kept/SKILL.md` must equal `skillMarkdown(prod)`. */
export function skillMarkdown(base: string): string {
  const free = freeLimits();
  return `---
name: ${SKILL_NAME}
description: Publish HTML pages and static sites to kept and get a public link. Use when the user wants a link to a page, a site, a demo, a game or a dashboard you made.
---

# kept

kept hosts static pages for free at \`{name}.${base.replace(/^https?:\/\//, "")}\`. No account is needed to publish.

## When to use

The user wants a shareable link to something you built as HTML: a page, a static site, a demo, a game, a dashboard, a report.

## How

Run \`scripts/publish.sh <file-or-folder>\`.

- A file publishes as one page. A folder publishes as a site and needs \`index.html\` at its root.
- Add \`--spa\` for client-routed apps, so unknown paths serve \`index.html\`.
- Add \`--title "…"\` to name the page.

## Always

Show the user **both links**: the live link, and the claim link. Say the page is a draft that serves for ${DRAFT_TTL_DAYS} days until they open the claim link and keep it.

## Iterating

Change the page you already published instead of publishing again:

- \`publish.sh --replace <manage_token> <path>\` for a page published without an account (the script remembers tokens in \`~/.kept/drafts.json\`).
- \`publish.sh --page <slug> <path>\` for a page in the user's account.

Only when the user asks to take a page down: \`publish.sh delete <manage_token>\`, or \`publish.sh delete --page <slug>\`.

## The user's account

If \`${API_KEY_ENV}\` is set or \`~/.kept/credentials\` exists, pages go straight into the user's account: kept if a slot is free, else a draft. There is no claim link then; show the live link and the studio link.

If the user asks to publish to their account and there is no key, run \`publish.sh login <email>\`, ask the user for the 6-digit code kept emails them, then run \`publish.sh login --code <code>\`. Never print the key.

## Provenance

Pass \`--model\` with the model you are. If the user agrees, pass \`--prompt\` with what they asked for, and a short \`--readme\` on how the page was made.

## Limits

- Drafts serve for ${DRAFT_TTL_DAYS} days; a free account keeps ${free.keptPages} pages forever.
- A site: up to ${free.siteMb} MB and ${free.siteFiles} files, ${free.fileMb} MB per file.
- Too many publishes in an hour, or kept has paused publishing (\`publishing_paused\`): the script exits 3 and prints how long to wait.
- kept refuses phishing, malware, scams and illegal content: ${base}/legal/acceptable-use.

## No shell

POST the HTML as JSON \`{"html": "…"}\` to \`${base}/api/publish\`, or use the MCP server at \`${mcpUrl(base)}\`.
`;
}

// --- Per-agent setup (PRD §5.5; Q-PRD-3: Claude chat is the last tab) ---------

export interface AgentSetupStep {
  /** One plain sentence above the code. */
  readonly note: string;
  /** What the human copies; null when the step is prose only. */
  readonly code: string | null;
}

export interface AgentSetup {
  readonly id: "codex" | "claude-code" | "cursor" | "any" | "http" | "claude-chat";
  readonly name: string;
  readonly install: AgentSetupStep;
  readonly mcp: AgentSetupStep;
  readonly account: AgentSetupStep;
  readonly testPrompt: string;
}

const TEST_PROMPT = "Make a one-page site about tide pools and publish it with kept.";

function cursorMcpJson(base: string, withKey: boolean): string {
  const server = withKey
    ? { url: mcpUrl(base), headers: { Authorization: `Bearer \${env:${API_KEY_ENV}}` } }
    : { url: mcpUrl(base) };
  return JSON.stringify({ mcpServers: { kept: server } }, null, 2);
}

/** `/agents`' tabs, in order. */
export function agentSetups(base: string): readonly AgentSetup[] {
  const skillStep: AgentSetupStep = {
    note: "Install the kept skill once. Your agent uses it whenever you ask for a link.",
    code: SKILL_INSTALL_COMMAND,
  };
  const keyNote =
    `Create a key in Settings (${base}/settings) and export it as ${API_KEY_ENV}, ` +
    "or ask your agent to publish to your account: the skill signs you in with an emailed code.";
  return [
    {
      id: "codex",
      name: "Codex",
      install: skillStep,
      mcp: { note: "Or add kept as an MCP server.", code: `codex mcp add kept --url ${mcpUrl(base)}` },
      account: {
        note: keyNote,
        code: `codex mcp add kept --url ${mcpUrl(base)} --bearer-token-env-var ${API_KEY_ENV}`,
      },
      testPrompt: TEST_PROMPT,
    },
    {
      id: "claude-code",
      name: "Claude Code",
      install: skillStep,
      mcp: {
        note: "Or add kept as an MCP server.",
        code: `claude mcp add --transport http kept ${mcpUrl(base)}`,
      },
      account: {
        note: keyNote,
        code: `claude mcp add --transport http kept ${mcpUrl(base)} --header "Authorization: Bearer $${API_KEY_ENV}"`,
      },
      testPrompt: TEST_PROMPT,
    },
    {
      id: "cursor",
      name: "Cursor",
      install: skillStep,
      mcp: { note: "Or add kept to ~/.cursor/mcp.json.", code: cursorMcpJson(base, false) },
      account: { note: keyNote, code: cursorMcpJson(base, true) },
      testPrompt: TEST_PROMPT,
    },
    {
      id: "any",
      name: "Any agent",
      install: {
        note: "Install the skill into every agent on this machine. No npm needed; never uses sudo.",
        code: installCommand(base),
      },
      mcp: {
        note: "Any MCP client: a Streamable HTTP server, no sign-in.",
        code: mcpUrl(base),
      },
      account: { note: keyNote, code: `export ${API_KEY_ENV}=kpt_live_…` },
      testPrompt: agentPrompt(base),
    },
    {
      id: "http",
      name: "HTTP API",
      install: {
        note: "No install. POST the HTML; the answer has the live link and the claim link.",
        code:
          `curl -sS ${base}/api/publish -H 'Content-Type: application/json' ` +
          `-H 'X-Kept-Client: my-agent/api' -d '{"html": "<h1>Hello</h1>"}'`,
      },
      mcp: { note: "Or speak MCP over Streamable HTTP.", code: mcpUrl(base) },
      account: {
        note: `With a key, publish into your account: kept if a slot is free, else a draft.`,
        code:
          `curl -sS ${base}/api/v1/pages -H "Authorization: Bearer $${API_KEY_ENV}" ` +
          `-H 'Content-Type: application/json' -d '{"html": "<h1>Hello</h1>"}'`,
      },
      testPrompt: `Full reference: ${base}/llms.txt`,
    },
    {
      id: "claude-chat",
      name: "Claude chat",
      install: {
        note: "In Claude, open Settings → Connectors → Add custom connector, name it kept, and paste this URL. No sign-in.",
        code: mcpUrl(base),
      },
      mcp: { note: "The connector is kept's MCP server; nothing else to install.", code: null },
      account: {
        note: "Chat pages publish as drafts. Open the claim link Claude gives you to keep a page in your account.",
        code: null,
      },
      testPrompt: TEST_PROMPT,
    },
  ];
}

// --- Discovery files ---------------------------------------------------------

/** `/llms.txt` — what an agent reading the site needs to publish. */
export function llmsTxt(base: string): string {
  const free = freeLimits();
  return `# kept

> Free, permanent static hosting for humans and AI agents. Publish HTML without an account and get a live link and a claim link; the human keeps the page by opening the claim link.

## Publish (no account)

POST ${base}/api/publish with JSON {"html": "…"} — or {"files": [{"path": "index.html", "content": "…"}], "spa": false} for a site.
Send X-Kept-Client: {agent}/api so kept can count which agents use it.
The answer: {"live_url", "claim_url", "slug", "anonToken", "expires_in", "expires_at", "deduped"}. Show the human both links.
Replace: POST ${base}/api/anon/{anonToken}/replace with the same body. Delete: DELETE ${base}/api/anon/{anonToken}.
A draft serves for ${DRAFT_TTL_DAYS} days unless the human keeps it.

## Publish into an account (API key)

Authorization: Bearer kpt_live_… on ${base}/api/v1/pages (POST, GET) and ${base}/api/v1/pages/{slug} (GET, PUT, DELETE).
The answer: {"live_url", "studio_url", "slug", "kept", "expires_at"}. Kept if a slot is free (${free.keptPages} on a free account), else a draft.

## Errors

Non-2xx answers are {"error": "<code>", "message": "…", "retry_after_seconds"?}. 429 rate_limited: wait retry_after_seconds.
503 publishing_paused: kept has paused publishing; serving, deletes and keeps still work. Wait retry_after_seconds.

## Other ways in

- Skill: ${SKILL_INSTALL_COMMAND} (or ${installCommand(base)}); SKILL.md at ${base}/skill.md
- MCP (Streamable HTTP): ${mcpUrl(base)}
- Setup per agent: ${base}/agents
- Limits: ${free.siteMb} MB and ${free.siteFiles} files per site, ${free.fileMb} MB per file
- Acceptable use: ${base}/legal/acceptable-use
`;
}

/** `/.well-known/skills/index.json` (Hermes): the skills this site offers. */
export function skillsIndex(base: string): {
  skills: { name: string; description: string; url: string }[];
} {
  return {
    skills: [
      {
        name: SKILL_NAME,
        description:
          "Publish HTML pages and static sites to kept and get a public link, with no account.",
        url: `${base}/skill.md`,
      },
    ],
  };
}

/**
 * The global skill folders `/install.sh` looks for (skills.sh's table): the
 * agent's home directory, and its skills directory under it unless `skills`
 * names another. Each is relative to `$HOME`; Codex is detected by its home
 * (honouring `$CODEX_HOME`) but reads user skills from `~/.agents/skills`
 * (developers.openai.com/codex/skills).
 */
const INSTALL_TARGETS = [
  { agent: "Claude Code", home: '"$HOME/.claude"' },
  { agent: "Codex", home: '"${CODEX_HOME:-$HOME/.codex}"', skills: '"$HOME/.agents/skills"' },
  { agent: "Cursor", home: '"$HOME/.cursor"' },
  { agent: "OpenCode", home: '"$HOME/.config/opencode"' },
  { agent: "Gemini CLI", home: '"$HOME/.gemini"' },
] as const satisfies readonly { agent: string; home: string; skills?: string }[];

/**
 * `/install.sh` — POSIX sh. Copies the skill into each detected agent's skills
 * folder and nothing else: no sudo, no shell profile, no MCP config (Q-PRD-2).
 * `source` is where `SKILL.md` and `scripts/publish.sh` are downloaded from.
 */
export function installScript(base: string, source: string = SKILL_SOURCE_URL): string {
  const targets = INSTALL_TARGETS.map((target) =>
    "skills" in target
      ? `install_into "${target.agent}" ${target.home} ${target.skills}`
      : `install_into "${target.agent}" ${target.home}`,
  ).join("\n");
  return `#!/bin/sh
# kept skill installer — ${base}/agents
# Copies the kept skill into the skills folder of every coding agent found in
# your home directory. Never uses sudo, never edits shell profiles or MCP configs.
set -eu

SOURCE="${source}"
installed=0

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    echo "kept: curl or wget is required." >&2
    exit 1
  fi
}

install_into() {
  agent="$1"
  home="$2"
  [ -d "$home" ] || return 0
  dir="\${3:-$home/skills}/${SKILL_NAME}"
  mkdir -p "$dir/scripts"
  download "$SOURCE/SKILL.md" "$dir/SKILL.md"
  download "$SOURCE/scripts/publish.sh" "$dir/scripts/publish.sh"
  chmod 755 "$dir/scripts/publish.sh"
  echo "kept: installed the skill for $agent in $dir"
  installed=$((installed + 1))
}

${targets}

if [ "$installed" -eq 0 ]; then
  echo "kept: no supported agent found in $HOME."
  echo "Install the skill with: ${SKILL_INSTALL_COMMAND}"
  exit 0
fi

echo "kept: done. Ask your agent to publish something with kept."
`;
}
