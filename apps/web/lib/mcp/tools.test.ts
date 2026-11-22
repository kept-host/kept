/**
 * The MCP tools (`./tools.ts`) against the REAL dev stack — E09 task 009.
 *
 * NO MOCKS. ONE keyless page and ONE keyed page, each reused for its whole
 * life: publish → (keyless: the same session's retry dedups) → get → replace →
 * delete. Everything else — the tool lists and their annotations, a refused
 * body, the per-session ceiling, the publish pause — writes nothing to KV.
 *
 * 9 KV-writing calls (four publishes — two of them from a `create_upload` zip —
 * two replaces, three deletes) plus the teardown's. SKIPS without dev credentials. Every row, object, KV key and
 * rate bucket it made is removed in `after`. Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/mcp/tools.test.ts
 *
 * ⚠️ No manage token, session or key is printed: assertions on them are booleans.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { keyedPageSchema, keyedPublishResponseSchema, type Plan } from "@kept/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "dotenv";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, db } from "../db";
import { siteObjectKeys } from "../db/queries/version-files";
import { profiles, rateLimits, siteVersions, sites, user } from "../db/schema";
import { ipKey } from "../rate-limit";
import { pageObjectKey, r2Store } from "../storage/r2";

import { uploadObjectKey } from "../uploads/upload";

import { mintSessionId, sessionOf, sessionPublisherKey, sessionUploader } from "./session";
import {
  keyedCreateUpload,
  keyedPublishTool,
  keyedReplaceTool,
  keylessCreateUpload,
  keylessDelete,
  keylessGet,
  keylessPublish,
  keylessReplace,
  registerTools,
  toolResult,
  type KeyedContext,
  type KeylessContext,
  type McpContext,
} from "./tools";

config({ path: ".env.local", quiet: true });

const REQUIRED = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "PUBLISHER_HASH_SALT",
  "NEXT_PUBLIC_APP_URL",
  "MCP_SESSION_SECRET",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0 ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;
// Only the per-IP bucket's daily salt; a real value in `.env.local` wins.
process.env.RATE_LIMIT_SECRET ??= "e09-009-tools-rate-limit-secret-0123456789abcdef";

const createdUsers = new Set<string>();
const publishedSlugs = new Set<string>();
const buckets = new Set<string>();
const uploadKeys = new Set<string>();

const IP = "203.0.113.90";
const publisher = { ip: IP, userAgent: "kept-e09-009-drill/1.0" };
const CLIENT = "e09/mcp-test";

const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1><p>${crypto.randomUUID()}</p></body></html>\n`;

async function keylessContext(): Promise<KeylessContext> {
  const session = sessionOf(mintSessionId());
  const key = await sessionPublisherKey(session);
  for (const bucket of [`mcp-session:${key}`, `publish-requests:${key}`, `publish:${key}`, `publish:${key}:day`]) {
    buckets.add(bucket);
  }
  buckets.add(await ipKey("mcp-ip", IP));
  buckets.add(`uploads:${await sessionUploader(session)}`);
  buckets.add(await ipKey("mcp-uploads-ip", IP));
  return { kind: "keyless", session, plan: "free", ip: IP, client: CLIENT, publisher };
}

async function keyedContext(plan: Plan): Promise<KeyedContext> {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "E09-009 drill", email: `e09-009-${id}@kept.invalid`, emailVerified: true });
  await db.insert(profiles).values({ id, email: `e09-009-${id}@kept.invalid`, plan });
  createdUsers.add(id);
  const keyId = crypto.randomUUID();
  buckets.add(`key:${keyId}`);
  buckets.add(`uploads:${id}`);
  return { kind: "keyed", caller: { keyId, profileId: id, plan }, client: CLIENT, publisher };
}

/** The slug of a `https://{slug}.{base}` live URL. */
const slugOf = (liveUrl: string) => new URL(liveUrl).hostname.split(".")[0]!;

async function siteBySlug(slug: string) {
  const [row] = await db.select().from(sites).where(eq(sites.slug, slug));
  assert.ok(row, `site ${slug} exists`);
  return row;
}

after(async () => {
  if (skip) return;
  const rows = publishedSlugs.size
    ? await db.select({ id: sites.id }).from(sites).where(inArray(sites.slug, [...publishedSlugs]))
    : [];
  const siteIds = new Set(rows.map((row) => row.id));
  await (await import("../testing/served-manifests")).removeServedManifests(publishedSlugs);
  await (await import("../testing/pending-purges")).clearPendingPurges(publishedSlugs, siteIds);
  for (const siteId of siteIds) {
    buckets.add(`anon-replace:${siteId}`);
    const versions = await db.select({ id: siteVersions.id }).from(siteVersions).where(eq(siteVersions.siteId, siteId));
    const keys = [...versions.map((v) => pageObjectKey(siteId, v.id)), ...(await siteObjectKeys(db, siteId))];
    if (keys.length > 0) await r2Store().deleteMany(keys).catch(() => undefined);
  }
  if (uploadKeys.size > 0) await r2Store().deleteMany([...uploadKeys]);
  if (siteIds.size > 0) await db.delete(sites).where(inArray(sites.id, [...siteIds]));
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  if (buckets.size > 0) await db.delete(rateLimits).where(inArray(rateLimits.bucket, [...buckets]));
  await closeDb();
});

test("tools/list: the keyless and keyed sets, their annotations, and the isError envelope", { skip }, async () => {
  async function listed(ctx: McpContext) {
    const server = new McpServer({ name: "kept", version: "test" });
    registerTools(server, ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "e09-009", version: "1" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      // A refused body through the SDK: the flat error as structured content, `isError` set.
      const refused = await client.callTool({ name: "publish_page", arguments: { html: "" } });
      return { tools: new Map(tools.map((tool) => [tool.name, tool])), refused };
    } finally {
      await client.close();
      await server.close();
    }
  }

  const keyless = await listed(await keylessContext());
  assert.deepEqual([...keyless.tools.keys()].sort(), [
    "create_upload",
    "delete_page",
    "get_page",
    "publish_page",
    "replace_page",
  ]);
  const keyed = await listed(await keyedContext("free"));
  assert.deepEqual([...keyed.tools.keys()].sort(), [
    "create_upload",
    "delete_page",
    "get_page",
    "list_pages",
    "publish_page",
    "replace_page",
  ]);

  for (const tools of [keyless.tools, keyed.tools]) {
    const publish = tools.get("publish_page")!.annotations;
    assert.deepEqual(
      [publish?.readOnlyHint, publish?.destructiveHint, publish?.openWorldHint],
      [false, false, true],
    );
    for (const name of ["replace_page", "delete_page"]) {
      assert.equal(tools.get(name)!.annotations?.destructiveHint, true, name);
      assert.equal(tools.get(name)!.annotations?.idempotentHint, true, name);
    }
    assert.equal(tools.get("get_page")!.annotations?.readOnlyHint, true);
    const upload = tools.get("create_upload")!.annotations;
    assert.deepEqual(
      [upload?.readOnlyHint, upload?.destructiveHint, upload?.idempotentHint, upload?.openWorldHint],
      [false, false, false, true],
    );
    assert.ok(tools.get("publish_page")!.inputSchema.properties?.upload_id, "publish takes an upload_id");
  }
  assert.equal(keyed.tools.get("list_pages")!.annotations?.readOnlyHint, true);
  assert.ok(keyless.tools.get("replace_page")!.inputSchema.properties?.manage_token, "keyless addresses by manage_token");
  assert.ok(keyed.tools.get("replace_page")!.inputSchema.properties?.page, "keyed addresses by page");

  for (const { refused } of [keyless, keyed]) {
    assert.equal(refused.isError, true);
    const body = refused.structuredContent as { error: string; message: string };
    assert.ok(["empty_page", "invalid_request"].includes(body.error), body.error);
    assert.equal(typeof body.message, "string");
  }
});

test("the publish pause answers publishing_paused on every writing tool, reading nothing", { skip }, async () => {
  const keyless = await keylessContext();
  const keyed = await keyedContext("free");
  const before = process.env.KEPT_PUBLISH_PAUSED;
  process.env.KEPT_PUBLISH_PAUSED = "true";
  try {
    const html = pageHtml("paused");
    for (const outcome of [
      await keylessPublish(keyless, { html }),
      await keylessReplace(keyless, { manage_token: "not-a-token", html }),
      await keyedPublishTool(keyed, { html }),
      await keyedReplaceTool(keyed, { page: "not-a-page", html }),
      await keylessCreateUpload(keyless),
      await keyedCreateUpload(keyed),
    ]) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.body.error, "publishing_paused");
      assert.equal(toolResult(outcome).isError, true);
    }
  } finally {
    if (before === undefined) delete process.env.KEPT_PUBLISH_PAUSED;
    else process.env.KEPT_PUBLISH_PAUSED = before;
  }
});

test("keyless: per-session ceiling refuses before the pipeline", { skip }, async () => {
  const ctx = await keylessContext();
  const bucket = `mcp-session:${await sessionPublisherKey(ctx.session)}`;
  // Fill this hour's window exactly as `hit` keys it.
  await db.execute(sql`
    insert into rate_limits (bucket, window_start, count)
    values (${bucket}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 20)
  `);
  const outcome = await keylessPublish(ctx, { html: pageHtml("over the ceiling") });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.body.error, "rate_limited");
    assert.ok((outcome.body.retry_after_seconds ?? 0) > 0);
  }
});

test("keyless: one page — publish → same-session retry dedups → get → replace → delete", { skip }, async () => {
  const ctx = await keylessContext();
  const html = pageHtml("e09-009 keyless");

  const published = await keylessPublish(ctx, { html, model: "drill-model", tool: "drill-tool" });
  assert.ok(published.ok, JSON.stringify(published.ok ? {} : published.body));
  const body = published.body as Record<string, string>;
  assert.deepEqual(Object.keys(body).sort(), ["claim_url", "expires_at", "expires_in", "live_url", "manage_token"]);
  const slug = slugOf(body.live_url!);
  publishedSlugs.add(slug);
  const token = body.manage_token!;
  assert.ok(new URL(body.claim_url!).pathname.endsWith(`/keep/${token}`), "the claim link carries the manage token");

  const site = await siteBySlug(slug);
  assert.equal(site.publisherHash, await sessionPublisherKey(ctx.session), "the publisher is the session, not the IP");
  const [version] = await db.select().from(siteVersions).where(eq(siteVersions.siteId, site.id));
  assert.deepEqual([version?.publishedVia, version?.client], ["mcp", CLIENT]);

  // The same session retrying the same bytes converges on the same page; the token rotates.
  const retried = await keylessPublish(ctx, { html });
  assert.ok(retried.ok);
  const again = retried.body as Record<string, string>;
  assert.equal(again.live_url, body.live_url);
  assert.ok(again.manage_token !== token, "a dedup hit rotates the token");
  const current = again.manage_token!;

  const got = await keylessGet(current);
  assert.ok(got.ok);
  const page = got.body as Record<string, unknown>;
  assert.deepEqual([page.slug, page.kept, page.model, page.tool, page.title], [slug, false, "drill-model", "drill-tool", "e09-009 keyless"]);
  assert.equal(page.claim_url, body.claim_url!.replace(token, current));
  assert.equal(page.expires_in, "7d");

  const replaced = await keylessReplace(ctx, { manage_token: current, html: pageHtml("e09-009 keyless, replaced") });
  assert.ok(replaced.ok, JSON.stringify(replaced.ok ? {} : replaced.body));
  assert.equal((replaced.body as { live_url: string }).live_url, body.live_url);
  assert.equal(((await keylessGet(current)).body as { title: string }).title, "e09-009 keyless, replaced");

  const stale = await keylessGet(token);
  assert.equal(stale.ok, false, "the rotated-away token names nothing");

  const deleted = await keylessDelete(current);
  assert.deepEqual(deleted, { ok: true, body: { deleted: true } });
  const gone = await keylessGet(current);
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.body.error, "invalid_request");
});

test("keyed: one page — publish kept → get → replace → delete, all published_via mcp", { skip }, async () => {
  const ctx = await keyedContext("free");

  const published = await keyedPublishTool(ctx, { html: pageHtml("e09-009 keyed"), model: "drill-model" });
  assert.ok(published.ok, JSON.stringify(published.ok ? {} : published.body));
  const body = keyedPublishResponseSchema.parse(published.body);
  publishedSlugs.add(body.slug);
  assert.equal(body.kept, true);
  const site = await siteBySlug(body.slug);
  assert.equal(site.ownerId, ctx.caller.profileId);

  const server = new McpServer({ name: "kept", version: "test" });
  registerTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e09-009", version: "1" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const got = await client.callTool({ name: "get_page", arguments: { page: body.slug } });
    assert.notEqual(got.isError, true);
    assert.equal(keyedPageSchema.parse(got.structuredContent).model, "drill-model");

    const listed = await client.callTool({ name: "list_pages", arguments: {} });
    assert.deepEqual((listed.structuredContent as { pages: { slug: string }[] }).pages.map((p) => p.slug), [body.slug]);

    const replaced = await client.callTool({
      name: "replace_page",
      arguments: { page: body.slug, html: pageHtml("e09-009 keyed, replaced") },
    });
    assert.notEqual(replaced.isError, true, JSON.stringify(replaced.structuredContent));
    const versions = await db.select().from(siteVersions).where(eq(siteVersions.siteId, site.id));
    assert.ok(versions.length >= 1);
    assert.ok(versions.every((v) => v.publishedVia === "mcp" && v.client === CLIENT), "every version came through mcp");

    const deleted = await client.callTool({ name: "delete_page", arguments: { page: body.slug } });
    assert.deepEqual(deleted.structuredContent, { slug: body.slug, deleted: true });
    const gone = await client.callTool({ name: "get_page", arguments: { page: body.slug } });
    assert.equal(gone.isError, true);
    assert.equal((gone.structuredContent as { error: string }).error, "not_found");
  } finally {
    await client.close();
    await server.close();
  }
});

// ── create_upload: the zip goes over a kept PUT, the call carries only its ID ──

/** A one-page site as a zip, the bytes `create_upload`'s command would PUT. */
async function siteZip(marker: string): Promise<Uint8Array<ArrayBuffer>> {
  const { downloadZip } = await import("client-zip");
  return new Uint8Array(
    await downloadZip([{ name: "index.html", input: pageHtml(marker), lastModified: new Date(0) }]).arrayBuffer(),
  );
}

/** `create_upload`, then the PUT its command makes — through the real route handler. */
async function uploaded(outcome: Awaited<ReturnType<typeof keylessCreateUpload>>, owner: string, marker: string) {
  assert.ok(outcome.ok, JSON.stringify(outcome.body));
  const link = outcome.body as { upload_id: string; upload_url: string; max_bytes: number; command: string };
  uploadKeys.add(uploadObjectKey(owner, link.upload_id));
  assert.ok(link.command.endsWith(`curl -fsS -T /tmp/kept-site.zip '${link.upload_url}'`), "the command PUTs to the URL");
  assert.ok(link.command.startsWith("cd <your site folder> && "), "the folder is the agent's to fill in");

  const { PUT } = await import("../../app/api/uploads/[uploadId]/route");
  const zip = await siteZip(marker);
  const res = await PUT(new Request(link.upload_url, { method: "PUT", body: zip }), {
    params: Promise.resolve({ uploadId: link.upload_id }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { upload_id: link.upload_id, bytes: zip.length });
  return link.upload_id;
}

test("keyless create_upload: PUT the zip, publish_page({ upload_id }) is live and spends it; another session cannot use one", { skip }, async () => {
  const ctx = await keylessContext();
  const owner = await sessionUploader(ctx.session);

  const uploadId = await uploaded(await keylessCreateUpload(ctx), owner, "e09 keyless upload");
  const published = await keylessPublish(ctx, { upload_id: uploadId });
  assert.ok(published.ok, JSON.stringify(published.body));
  const body = published.body as Record<string, string>;
  const slug = slugOf(body.live_url!);
  publishedSlugs.add(slug);
  assert.equal((await siteBySlug(slug)).status, "live");
  assert.equal(await r2Store().get(uploadObjectKey(owner, uploadId)), null, "used once: the upload is deleted");

  // Another session's upload_id names nothing here, and is still there for its own session.
  const foreignId = await uploaded(await keylessCreateUpload(ctx), owner, "e09 foreign upload");
  const other = await keylessContext();
  const refused = await keylessPublish(other, { upload_id: foreignId });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.body.error, "upload_not_found");
  assert.notEqual(await r2Store().get(uploadObjectKey(owner, foreignId)), null);

  assert.deepEqual(await keylessDelete(body.manage_token!), { ok: true, body: { deleted: true } });
});

test("keyed create_upload: PUT the zip, publish_page({ upload_id }) lands in the account and spends it", { skip }, async () => {
  const ctx = await keyedContext("free");
  const owner = ctx.caller.profileId;

  const uploadId = await uploaded(await keyedCreateUpload(ctx), owner, "e09 keyed upload");
  const published = await keyedPublishTool(ctx, { upload_id: uploadId });
  assert.ok(published.ok, JSON.stringify(published.body));
  const body = keyedPublishResponseSchema.parse(published.body);
  publishedSlugs.add(body.slug);
  const site = await siteBySlug(body.slug);
  assert.deepEqual([site.ownerId, site.status], [owner, "live"]);
  assert.equal(await r2Store().get(uploadObjectKey(owner, uploadId)), null, "used once: the upload is deleted");
});
