/**
 * The MCP tools (E09 D4, PRD §5.3) — thin adapters over the publish pipeline
 * (keyless) and `lib/agents/pages.ts` (keyed). No rule lives here: a tool turns
 * its arguments into the same JSON body `POST /api/publish` reads, hands it to
 * `readFileSet` (one validator), calls the service, and returns its body.
 *
 * TWO TOOL SETS. Keyless (no key): `publish_page`, `replace_page`, `get_page`,
 * `delete_page`, addressed by `manage_token` (Q2 — the value `POST
 * /api/publish` calls `anonToken`). Keyed (`Authorization: Bearer kpt_live_…`):
 * the same verbs plus `list_pages`, addressed by `page` (the slug), landing in
 * the key owner's account with `published_via = "mcp"`.
 *
 * ERRORS are `isError: true` with the flat `{ error, message,
 * retry_after_seconds? }` body (`PUBLISH_ERROR_CODES` / `KEYED_ERROR_CODES`)
 * as `structuredContent`, and the same JSON as text for clients that read only
 * `content`.
 *
 * ⚠️ NOTHING HERE LOGS: arguments carry HTML and manage tokens.
 */
import {
  MCP_TOOL_DESCRIPTIONS,
  AGENT_RATE_LIMITS,
  type KeyedError,
  type Plan,
} from "@kept/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { KeyCaller } from "../agents/keys";
import { keyedDelete, keyedGet, keyedList, keyedPublish, keyedReplace, type KeyedOutcome } from "../agents/pages";
import { getKeyedPageById } from "../db/queries/dashboard";
import { publishPaused } from "../launch";
import { ipKey, hit, type RateLimitResult } from "../rate-limit";
import { deletePage, draftWindow, replacePage } from "../publish/anon-manage";
import { notFound, resolveAnonToken } from "../publish/anon-token";
import { readFileSet } from "../publish/fileset/read";
import type { FileSet, FileSetCaller } from "../publish/fileset/types";
import { JSON_TYPE, PUBLISHING_PAUSED_ERROR } from "../publish/http";
import {
  claimUrl,
  liveUrl,
  publishPage,
  rateLimited,
  type PublisherContext,
  type PublishFailure,
  type PublishSource,
} from "../publish/pipeline";

import { sessionPublisherKey } from "./session";

/** What every MCP request knows about its caller beyond the tool set. */
interface BaseContext {
  /** `X-Kept-Client` (D9), or null. */
  client: string | null;
  /** The request's IP + UA — the keyed publish's E07 hash input; never stored raw. */
  publisher: PublisherContext;
}

/** A keyless caller: the verified session's random half, the plan its door grants, and its client IP. */
export interface KeylessContext extends BaseContext {
  kind: "keyless";
  session: string;
  plan: Plan;
  /** For the per-IP ceiling (Q6) — hashed by `ipKey`, never stored. */
  ip: string;
}

export interface KeyedContext extends BaseContext {
  kind: "keyed";
  caller: KeyCaller;
}

export type McpContext = KeylessContext | KeyedContext;

/** A tool's answer before it is wrapped: the service's body, or a flat error. */
export type ToolOutcome = { ok: true; body: object } | { ok: false; body: KeyedError };

// --- Arguments ---------------------------------------------------------------

/**
 * The page content and provenance a publish or replace carries — the shape
 * `POST /api/publish`'s JSON body takes (E08 §6.3, D10). Typed loosely on
 * purpose: sizes, paths, encodings and provenance limits are `readFileSet`'s
 * to judge, so a refusal arrives with its own code rather than as a generic
 * schema error.
 */
const contentShape = {
  html: z.string().optional().describe("A whole HTML document, for a one-page site."),
  files: z
    .array(
      z.object({
        path: z.string().describe("Relative to the site root, `/`-separated; `index.html` at the root."),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional().describe("`base64` for images, fonts and other binaries."),
      }),
    )
    .optional()
    .describe("The files of a static site; send `html` or `files`, not both."),
  spa: z.boolean().optional().describe("Serve `index.html` for unknown extensionless paths (client-routed apps)."),
  title: z.string().optional(),
  model: z.string().optional().describe("The model that wrote the page."),
  tool: z.string().optional().describe("The agent or tool publishing it."),
  prompt: z.string().optional().describe("What the human asked for, if they agree to share it."),
  readme: z.string().optional().describe("A short note on how the page was made."),
  source_url: z.string().optional().describe("Where the source lives (http or https)."),
  remix_of: z.string().optional().describe("The slug of a kept page this one remixes."),
};

type ContentArgs = { [K in keyof typeof contentShape]?: z.infer<(typeof contentShape)[K]> };

const manageTokenShape = { manage_token: z.string().describe("The manage_token publish_page returned.") };
const pageShape = { page: z.string().describe("The page's slug.") };

/** The tool's content, read exactly as `POST /api/publish` reads a JSON body. No uploads over MCP. */
function readContent(args: ContentArgs, plan: Plan): Promise<FileSet | PublishFailure> {
  const caller: FileSetCaller = { plan, uploaderId: null };
  const request = new Request("https://mcp.invalid/", {
    method: "POST",
    headers: { "content-type": JSON_TYPE },
    body: JSON.stringify(args),
  });
  return readFileSet(request, caller);
}

// --- Keyless -------------------------------------------------------------------

const PAUSED: ToolOutcome = { ok: false, body: PUBLISHING_PAUSED_ERROR };

function fromPublish<T extends object>(outcome: { ok: true; body: T } | PublishFailure): ToolOutcome {
  return outcome.ok ? { ok: true, body: outcome.body } : { ok: false, body: outcome.body };
}

function limited(result: RateLimitResult, reason: string): PublishFailure | null {
  return result.allowed ? null : rateLimited({ ...result, reason });
}

/**
 * The keyless door's own buckets (D5, Q6), before the pipeline's: 20 publishes
 * an hour per session, 300 per client IP across sessions. E07's
 * per-publisher and global buckets follow inside `publishPage`.
 */
async function keylessLimit(ctx: KeylessContext, publisherKey: string): Promise<PublishFailure | null> {
  const { mcpSessionHour, mcpPerIpHour } = AGENT_RATE_LIMITS;
  return (
    limited(await hit(`mcp-session:${publisherKey}`, mcpSessionHour), `${mcpSessionHour.limit} publishes an hour per MCP session`) ??
    limited(await hit(await ipKey("mcp-ip", ctx.ip), mcpPerIpHour), `${mcpPerIpHour.limit} MCP publishes an hour from one address`)
  );
}

export async function keylessPublish(ctx: KeylessContext, args: ContentArgs): Promise<ToolOutcome> {
  if (publishPaused()) return PAUSED;
  const publisherKey = await sessionPublisherKey(ctx.session);
  const refused = await keylessLimit(ctx, publisherKey);
  if (refused) return fromPublish(refused);

  const outcome = await publishPage(
    () => readContent(args, ctx.plan),
    { ...ctx.publisher, publisherKey },
    { client: ctx.client, publishedVia: "mcp" },
  );
  if (!outcome.ok) return fromPublish(outcome);
  const { live_url, claim_url, anonToken, expires_at, expires_in } = outcome.body;
  return { ok: true, body: { live_url, claim_url, manage_token: anonToken, expires_at, expires_in } };
}

export async function keylessReplace(
  ctx: KeylessContext,
  { manage_token, ...content }: ContentArgs & { manage_token: string },
): Promise<ToolOutcome> {
  if (publishPaused()) return PAUSED;
  return fromPublish(await replacePage(manage_token, () => readContent(content, ctx.plan), "mcp", ctx.client));
}

/** The page behind a manage token: its links, its clock, whether it was kept, and its provenance. */
export async function keylessGet(manageToken: string): Promise<ToolOutcome> {
  const site = await resolveAnonToken(manageToken);
  const page = site ? await getKeyedPageById(site.id) : null;
  if (!site || !page) return fromPublish(notFound());
  const kept = site.expiresAt === null;
  return {
    ok: true,
    body: {
      live_url: liveUrl(site.slug),
      claim_url: kept ? null : claimUrl(manageToken),
      slug: site.slug,
      kept,
      ...draftWindow(site),
      title: page.title,
      model: page.model,
      tool: page.tool,
      prompt: page.prompt,
      readme: page.readme,
      source_url: page.sourceUrl,
      remix_of: page.remixOf,
      file_count: page.fileCount,
      updated_at: page.updatedAt.toISOString(),
    },
  };
}

export async function keylessDelete(manageToken: string): Promise<ToolOutcome> {
  const outcome = await deletePage(manageToken);
  return outcome.ok ? { ok: true, body: { deleted: true } } : fromPublish(outcome);
}

// --- Keyed -------------------------------------------------------------------

const MCP_SOURCE = (ctx: KeyedContext): PublishSource => ({ client: ctx.client, publishedVia: "mcp" });

function fromKeyed<T extends object>(outcome: KeyedOutcome<T>): ToolOutcome {
  return outcome.ok ? { ok: true, body: outcome.body } : { ok: false, body: outcome.body };
}

export async function keyedPublishTool(ctx: KeyedContext, args: ContentArgs): Promise<ToolOutcome> {
  if (publishPaused()) return PAUSED;
  const set = await readContent(args, ctx.caller.plan);
  return fromKeyed(await keyedPublish(ctx.caller, set, ctx.publisher, MCP_SOURCE(ctx)));
}

export async function keyedReplaceTool(
  ctx: KeyedContext,
  { page, ...content }: ContentArgs & { page: string },
): Promise<ToolOutcome> {
  if (publishPaused()) return PAUSED;
  const set = await readContent(content, ctx.caller.plan);
  return fromKeyed(await keyedReplace(ctx.caller, page, set, MCP_SOURCE(ctx)));
}

// --- Registration ------------------------------------------------------------

/** One outcome → one `CallToolResult`: the body as structured content and as JSON text. */
export function toolResult(outcome: ToolOutcome): CallToolResult {
  const structuredContent = outcome.body as Record<string, unknown>;
  const content = [{ type: "text" as const, text: JSON.stringify(outcome.body) }];
  return outcome.ok ? { content, structuredContent } : { content, structuredContent, isError: true };
}

const PUBLISH = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function registerKeyless(server: McpServer, ctx: KeylessContext): void {
  const copy = MCP_TOOL_DESCRIPTIONS.keyless;
  server.registerTool(
    "publish_page",
    { description: copy.publish_page, inputSchema: contentShape, annotations: PUBLISH },
    async (args) => toolResult(await keylessPublish(ctx, args)),
  );
  server.registerTool(
    "replace_page",
    { description: copy.replace_page, inputSchema: { ...manageTokenShape, ...contentShape }, annotations: DESTRUCTIVE },
    async (args) => toolResult(await keylessReplace(ctx, args)),
  );
  server.registerTool(
    "get_page",
    { description: copy.get_page, inputSchema: manageTokenShape, annotations: READ_ONLY },
    async ({ manage_token }) => toolResult(await keylessGet(manage_token)),
  );
  server.registerTool(
    "delete_page",
    { description: copy.delete_page, inputSchema: manageTokenShape, annotations: DESTRUCTIVE },
    async ({ manage_token }) => toolResult(await keylessDelete(manage_token)),
  );
}

function registerKeyed(server: McpServer, ctx: KeyedContext): void {
  const copy = MCP_TOOL_DESCRIPTIONS.keyed;
  server.registerTool(
    "publish_page",
    { description: copy.publish_page, inputSchema: contentShape, annotations: PUBLISH },
    async (args) => toolResult(await keyedPublishTool(ctx, args)),
  );
  server.registerTool(
    "replace_page",
    { description: copy.replace_page, inputSchema: { ...pageShape, ...contentShape }, annotations: DESTRUCTIVE },
    async (args) => toolResult(await keyedReplaceTool(ctx, args)),
  );
  server.registerTool(
    "list_pages",
    {
      description: copy.list_pages,
      inputSchema: { cursor: z.string().optional().describe("next_cursor from the previous answer.") },
      annotations: READ_ONLY,
    },
    async ({ cursor }) => toolResult(fromKeyed(await keyedList(ctx.caller, cursor))),
  );
  server.registerTool(
    "get_page",
    { description: copy.get_page, inputSchema: pageShape, annotations: READ_ONLY },
    async ({ page }) => toolResult(fromKeyed(await keyedGet(ctx.caller, page))),
  );
  server.registerTool(
    "delete_page",
    { description: copy.delete_page, inputSchema: pageShape, annotations: DESTRUCTIVE },
    async ({ page }) => toolResult(fromKeyed(await keyedDelete(ctx.caller, page))),
  );
}

/** The caller's tool set on `server` — keyless or keyed, never both. */
export function registerTools(server: McpServer, ctx: McpContext): void {
  if (ctx.kind === "keyless") registerKeyless(server, ctx);
  else registerKeyed(server, ctx);
}
