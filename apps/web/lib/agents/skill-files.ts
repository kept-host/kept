/**
 * The skill repo's generated files (E09 task 010, Q1): `skill/` in this repo,
 * mirrored to the public `kept-host/skill`. Every file here that carries agent
 * copy or a URL is a pure function of `@kept/shared`'s agent copy (D12) and the
 * prod origin, so `scripts/build-skill.ts` writes them and
 * `lib/agents/skill-drift.test.ts` fails when the checked-in files drift.
 *
 * `README.md`, `AGENTS.md`, `LICENSE`, `hermes/`, the CI workflow and
 * `skills/kept/scripts/publish.sh` are hand-written and live only in `skill/`.
 */
import { SKILL_NAME, SKILL_REPO, mcpUrl, skillMarkdown, skillsIndex } from "@kept/shared";

/**
 * The origin the published skill talks to. The skill ships to every user, so it
 * is always prod, and `publish.sh` has no override: nothing an agent reads names
 * another origin.
 */
export const SKILL_BUILD_BASE = "https://kept.host";

/** The skill repo's version — the plugins, `server.json` and Codex all read it. */
export const SKILL_VERSION = "1.0.0";

/** The MCP Registry schema `server.json` names; vendored at `lib/agents/fixtures/server.schema.json`. */
export const MCP_REGISTRY_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** The MCP Registry name (reverse DNS of kept.host; proven by a DNS TXT record, Arun's step). */
export const MCP_REGISTRY_NAME = "host.kept/kept";

const REPO_URL = `https://github.com/${SKILL_REPO}`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every generated file, by its path under `skill/`. */
export function skillFiles(base: string): Record<string, string> {
  const description = skillsIndex(base).skills[0]!.description;
  const mcp = mcpUrl(base);
  const author = { name: "kept", url: base };
  return {
    [`skills/${SKILL_NAME}/SKILL.md`]: skillMarkdown(base),

    // MCP Registry (PRD §5.6): the remote server, keyless, with the optional key header.
    "server.json": json({
      $schema: MCP_REGISTRY_SCHEMA,
      name: MCP_REGISTRY_NAME,
      title: "kept",
      description,
      version: SKILL_VERSION,
      websiteUrl: `${base}/agents`,
      repository: { url: REPO_URL, source: "github" },
      remotes: [
        {
          type: "streamable-http",
          url: mcp,
          headers: [
            {
              name: "Authorization",
              description: "Optional. Bearer <your kept API key> publishes into your account; without it, pages are drafts with a claim link.",
              isRequired: false,
              isSecret: true,
            },
          ],
        },
      ],
    }),

    // Agent Plugins MCP config — Codex and Cursor read it.
    "mcp.json": json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [SKILL_NAME]: { type: "streamable-http", url: mcp } },
    }),

    // Claude Code reads `.mcp.json` at the plugin root.
    ".mcp.json": json({ mcpServers: { [SKILL_NAME]: { type: "http", url: mcp } } }),

    // Codex (D3): the skill and the MCP server; a Git marketplace until self-serve listing opens.
    ".codex-plugin/plugin.json": json({
      name: SKILL_NAME,
      version: SKILL_VERSION,
      description,
      author,
      homepage: `${base}/agents`,
      repository: REPO_URL,
      license: "MIT",
      skills: "./skills/",
      mcpServers: "./mcp.json",
    }),
    ".agents/plugins/marketplace.json": json({
      name: SKILL_NAME,
      interface: { displayName: "kept" },
      plugins: [
        {
          name: SKILL_NAME,
          source: { source: "local", path: "./" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),

    // Cursor Marketplace (D3): reviewed submission; open source required.
    ".cursor-plugin/plugin.json": json({
      name: SKILL_NAME,
      version: SKILL_VERSION,
      description,
      author: { name: author.name },
      homepage: `${base}/agents`,
      repository: REPO_URL,
      license: "MIT",
      keywords: ["hosting", "publish", "static-site", "html"],
      skills: "./skills/",
      mcpServers: "./mcp.json",
    }),

    // Claude Code (D3): `/plugin marketplace add kept-host/skill`, then `/plugin install kept@kept`.
    ".claude-plugin/plugin.json": json({
      name: SKILL_NAME,
      version: SKILL_VERSION,
      description,
      author: { name: author.name, url: author.url },
      homepage: `${base}/agents`,
      repository: REPO_URL,
      license: "MIT",
    }),
    ".claude-plugin/marketplace.json": json({
      name: SKILL_NAME,
      owner: { name: author.name },
      plugins: [{ name: SKILL_NAME, source: "./", description }],
    }),
  };
}
