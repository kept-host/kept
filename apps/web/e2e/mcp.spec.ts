import { keyedPublishResponseSchema } from "@kept/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { createKey } from "../lib/agents/keys";
import { closeDb, db, schema } from "../lib/db";
import { sessionOf, sessionPublisherKey } from "../lib/mcp/session";
import { ipKey } from "../lib/rate-limit";
import { drillIp } from "../lib/testing/drill-ip";

import { SKIP_LIVE_PUBLISH } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, titledHtml } from "./owner-fixtures";

/**
 * `/mcp` over the wire with the REAL SDK client — E09 task 009 (D4, D5, AC5,
 * AC6). `Client` + `StreamableHTTPClientTransport` against the local server,
 * through Playwright's request context (it trusts the dev certificate) as the
 * transport's `fetch`.
 *
 *   - keyless: initialize → tools/list → publish → get → replace → delete; a
 *     second session publishing the SAME bytes gets a second draft (edge case 1).
 *   - keyed (Bearer key): tools/list is the keyed set; publish lands kept in the
 *     account; delete.
 *   - the session id: tampered → 404, missing → 400, DELETE → 204; GET → 405.
 *
 * 7 KV-writing calls (three publishes, one replace, three deletes) plus the
 * teardown's. ⚠️ No key, session id or manage token is printed.
 */
config({ path: ".env.local", quiet: true });

const scope = newScope();
const buckets = new Set<string>();
const CLIENT = "e09/mcp-spec";

/** Playwright's request context as a WHATWG `fetch` — the SDK transport's only network seam. */
function fetchVia(request: APIRequestContext) {
  return async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const response = await request.fetch(String(url), {
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      data: typeof init.body === "string" ? init.body : undefined,
    });
    const body = [204, 205, 304].includes(response.status()) ? null : new Uint8Array(await response.body());
    return new Response(body, { status: response.status(), headers: response.headers() });
  };
}

interface Connected {
  client: Client;
  transport: StreamableHTTPClientTransport;
  ip: string;
}

async function connect(request: APIRequestContext, baseURL: string, headers: Record<string, string> = {}): Promise<Connected> {
  // A fresh drill address per session, so the per-IP ceiling is this run's alone.
  const ip = drillIp();
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
    fetch: fetchVia(request),
    requestInit: { headers: { "x-kept-client": CLIENT, "cf-connecting-ip": ip, ...headers } },
  });
  const client = new Client({ name: "kept-e2e", version: "1" });
  await client.connect(transport);
  return { client, transport, ip };
}

/** Track a keyless session's buckets for teardown. */
async function trackSession({ transport, ip }: Connected): Promise<void> {
  expect(transport.sessionId, "initialize answered an Mcp-Session-Id").toBeTruthy();
  buckets.add(await ipKey("mcp-ip", ip));
  const key = await sessionPublisherKey(sessionOf(transport.sessionId!));
  for (const bucket of [`mcp-session:${key}`, `publish-requests:${key}`, `publish:${key}`, `publish:${key}:day`]) {
    buckets.add(bucket);
  }
}

type Structured = Record<string, string | boolean | null>;

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).not.toBe(true);
  return result.structuredContent as Structured;
}

const slugOf = (liveUrl: string) => new URL(liveUrl).hostname.split(".")[0]!;

async function trackSlug(slug: string): Promise<void> {
  scope.slugs.add(slug);
  const [site] = await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.slug, slug));
  if (site) {
    scope.siteIds.push(site.id);
    buckets.add(`anon-replace:${site.id}`);
  }
}

test.describe("MCP /mcp", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, SKIP_LIVE_PUBLISH || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await cleanup(scope);
    if (buckets.size > 0) await db.delete(schema.rateLimits).where(inArray(schema.rateLimits.bucket, [...buckets]));
    await closeDb();
  });

  test("keyless: publish → get → replace → delete; a second session with the same bytes gets its own draft", async ({
    request,
    baseURL,
  }) => {
    const a = await connect(request, baseURL!);
    const b = await connect(request, baseURL!);
    try {
      await trackSession(a);
      await trackSession(b);
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

      const { tools } = await a.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["delete_page", "get_page", "publish_page", "replace_page"]);

      const html = titledHtml(`mcp keyless ${crypto.randomUUID()}`);
      const first = await call(a.client, "publish_page", { html, model: "drill-model" });
      expect(Object.keys(first).sort()).toEqual(["claim_url", "expires_at", "expires_in", "live_url", "manage_token"]);
      const slugA = slugOf(first.live_url as string);
      await trackSlug(slugA);

      // Edge case 1 (D5): the same bytes from another session — another draft, another claim link.
      const second = await call(b.client, "publish_page", { html });
      const slugB = slugOf(second.live_url as string);
      await trackSlug(slugB);
      expect(slugB).not.toBe(slugA);
      expect(second.claim_url === first.claim_url, "claim links never cross sessions").toBe(false);

      const [site] = await db.select().from(schema.sites).where(eq(schema.sites.slug, slugA));
      const [version] = await db.select().from(schema.siteVersions).where(eq(schema.siteVersions.siteId, site!.id));
      expect([version?.publishedVia, version?.client]).toEqual(["mcp", CLIENT]);

      const token = first.manage_token as string;
      const got = await call(a.client, "get_page", { manage_token: token });
      expect([got.slug, got.kept, got.model]).toEqual([slugA, false, "drill-model"]);

      const replaced = await call(a.client, "replace_page", { manage_token: token, html: titledHtml("mcp keyless, replaced") });
      expect(replaced.live_url).toBe(first.live_url);
      expect((await call(a.client, "get_page", { manage_token: token })).title).toBe("mcp keyless, replaced");

      expect(await call(a.client, "delete_page", { manage_token: token })).toEqual({ deleted: true });
      expect(await call(b.client, "delete_page", { manage_token: second.manage_token })).toEqual({ deleted: true });
      const gone = await a.client.callTool({ name: "get_page", arguments: { manage_token: token } });
      expect(gone.isError).toBe(true);
      expect((gone.structuredContent as { error: string }).error).toBe("invalid_request");

      await a.transport.terminateSession();
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  test("keyed: a Bearer key gets the keyed set and publishes into the account", async ({ request, baseURL }) => {
    const userId = crypto.randomUUID();
    const email = `e09-mcp-${userId.slice(0, 8)}@kept-e09.invalid`;
    await db.insert(schema.user).values({ id: userId, name: "E09 MCP drill", email, emailVerified: true });
    await db.insert(schema.profiles).values({ id: userId, email });
    scope.userIds.push(userId);
    const created = await createKey(userId, "mcp drill");
    expect(created, "a key was minted").not.toBeNull();
    buckets.add(`key:${created!.summary.id}`);

    const keyed = await connect(request, baseURL!, { authorization: `Bearer ${created!.apiKey}` });
    try {
      const { tools } = await keyed.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["delete_page", "get_page", "list_pages", "publish_page", "replace_page"]);

      const published = keyedPublishResponseSchema.parse(
        await call(keyed.client, "publish_page", { html: titledHtml(`mcp keyed ${crypto.randomUUID()}`) }),
      );
      scope.slugs.add(published.slug);
      expect(published.kept).toBe(true);
      const [site] = await db.select().from(schema.sites).where(eq(schema.sites.slug, published.slug));
      expect(site?.ownerId).toBe(userId);

      const listed = await call(keyed.client, "list_pages", {});
      expect((listed.pages as unknown as { slug: string }[]).map((page) => page.slug)).toEqual([published.slug]);
      expect(await call(keyed.client, "delete_page", { page: published.slug })).toEqual({ slug: published.slug, deleted: true });
    } finally {
      await keyed.client.close();
    }
  });

  test("the session id: tampered → 404, missing → 400, DELETE → 204; GET → 405", async ({ request, baseURL }) => {
    const { client, transport } = await connect(request, baseURL!);
    const id = transport.sessionId!;
    await client.close();

    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    // One character of the MAC, mid-string, so the bytes change (the last character carries padding bits).
    const at = id.indexOf(".") + 5;
    const tamperedId = id.slice(0, at) + (id[at] === "A" ? "B" : "A") + id.slice(at + 1);

    const tampered = await request.post("/mcp", { headers: { ...headers, "mcp-session-id": tamperedId }, data: listTools });
    expect(tampered.status()).toBe(404);
    const forged = await request.post("/mcp", { headers: { ...headers, "mcp-session-id": `${"A".repeat(22)}.${"A".repeat(43)}` }, data: listTools });
    expect(forged.status()).toBe(404);
    const missing = await request.post("/mcp", { headers, data: listTools });
    expect(missing.status()).toBe(400);
    const valid = await request.post("/mcp", { headers: { ...headers, "mcp-session-id": id }, data: listTools });
    expect(valid.status()).toBe(200);
    expect(valid.headers()["mcp-session-id"], "only initialize mints a session").toBeUndefined();

    expect((await request.delete("/mcp", { headers: { "mcp-session-id": id } })).status()).toBe(204);
    expect((await request.delete("/mcp", { headers: { "mcp-session-id": tamperedId } })).status()).toBe(404);
    expect((await request.get("/mcp")).status()).toBe(405);
  });
});
