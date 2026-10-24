/**
 * The publish pipeline — E04 task 005's drills.
 *
 * NO MOCKS (project rule). Everything below runs against the real dev Neon
 * branch, the real dev R2 bucket, the real dev KV namespace, the real
 * `purge_cache` endpoint and the deployed dev Worker. The rollback drill injects
 * a REAL misconfiguration (a KV namespace id that does not exist) rather than a
 * stubbed client, which is possible because `lib/storage/env.ts` re-reads and
 * re-validates the environment on every call.
 *
 * The drills SKIP when the dev credentials are absent: CI runs `pnpm test` on
 * fork PRs with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * EVERY IMPORT OF THE PIPELINE IS DYNAMIC AND INSIDE A TEST. `lib/db/index.ts`
 * opens its postgres client at module scope and throws without `DATABASE_URL`,
 * so a static import would turn "skipped" into "the file failed to load".
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, MAX_PAGE_BYTES } from "@kept/shared";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]);
const skipLive =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SERVE_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;

/** Slugs this file created, torn down in `after`. */
const created = new Set<string>();

const publisher = (ip: string) => ({ ip, userAgent: "kept-e04-drill/1.0" });

const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

/** A marker unique to this run, so two runs never dedup against each other. */
const runId = () => `e04-005-${crypto.randomUUID().slice(0, 8)}`;

async function probe(url: string) {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
}

after(async () => {
  if (skipLive) return;
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { sites } = await import("../db/schema");
  const { removeManifest } = await import("../storage/manifest");
  const { r2Store } = await import("../storage/r2");
  const { siteObjectKeys } = await import("../db/queries/version-files");

  for (const slug of created) {
    const [row] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
    await removeManifest(slug).catch(() => undefined);
    if (!row) continue;
    // Every file of every version, from `site_version_files` (E08 D1).
    await r2Store()
      .deleteMany(await siteObjectKeys(db, row.id))
      .catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, row.id));
  }
  await (await import("../testing/pending-purges")).clearPendingPurges(created);
  // Release the pool, or `tsx --test` hangs on `idle_timeout`.
  await db.$client.end();
});

test("draft clocks come from the shared constants, not literals", async () => {
  const { draftClocks } = await import("./pipeline");
  const now = new Date("2026-01-01T00:00:00.000Z");
  const { expiresAt, purgeAfter } = draftClocks(now);

  assert.equal(expiresAt.getTime() - now.getTime(), DRAFT_TTL_DAYS * MS_PER_DAY);
  assert.equal(
    purgeAfter.getTime() - expiresAt.getTime(),
    DRAFT_GRACE_DAYS * MS_PER_DAY,
  );
});

test(
  "validation failures carry distinct, actionable error codes",
  { skip: skipLive },
  async () => {
    const { publishPage } = await import("./pipeline");
    const { jsonBody } = await import("../testing/file-sets");
    const who = publisher("203.0.113.10");

    const empty = await publishPage(jsonBody({ html: "" }), who);
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.status, 400);
    assert.equal(empty.ok === false && empty.body.error, "empty_page");

    const oversized = await publishPage(jsonBody({ html: "x".repeat(MAX_PAGE_BYTES + 1) }), who);
    assert.equal(oversized.ok === false && oversized.status, 413);
    assert.equal(oversized.ok === false && oversized.body.error, "page_too_large");

    const malformed = await publishPage(jsonBody({ notHtml: true }), who);
    assert.equal(malformed.ok === false && malformed.status, 400);
    assert.equal(malformed.ok === false && malformed.body.error, "invalid_request");

    // A `slug` in the body is not a field — the PRD rules custom slugs out at
    // publish, and E06 owns rename. It is ignored, never honoured.
    const withSlug = await publishPage(
      jsonBody({ html: pageHtml(runId()), slug: "chosen-by-caller" }),
      who,
    );
    assert.equal(withSlug.ok, true);
    if (withSlug.ok) {
      created.add(withSlug.body.slug);
      assert.notEqual(withSlug.body.slug, "chosen-by-caller");
    }
  },
);

test(
  "publish drill: the seven-field contract, and the live URL serves the page",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { pageObjectKey, r2Store } = await import("../storage/r2");
    const { pointerKey } = await import("../storage/manifest");
    const { jsonBody } = await import("../testing/file-sets");

    const marker = runId();
    const html = pageHtml(marker);
    const outcome = await publishPage(jsonBody({ html }), publisher("203.0.113.20"));

    assert.equal(outcome.ok, true, outcome.ok ? "" : JSON.stringify(outcome.body));
    if (!outcome.ok) return;
    created.add(outcome.body.slug);

    const body = outcome.body;
    assert.equal(outcome.status, 201);
    assert.equal(body.live_url, `https://${body.slug}.${process.env.KEPT_BASE_DOMAIN}`);
    assert.equal(
      body.claim_url,
      `${process.env.NEXT_PUBLIC_APP_URL}/keep/${body.anonToken}`,
    );
    assert.equal(body.expires_in, `${DRAFT_TTL_DAYS}d`);
    assert.equal(body.deduped, false);
    assert.ok(body.anonToken.length >= 40, "the token must be high-entropy");
    const expiresAt = new Date(body.expires_at);
    assert.ok(Math.abs(expiresAt.getTime() - Date.now() - DRAFT_TTL_DAYS * MS_PER_DAY) < 60_000);

    // Postgres: drafts are `live` with a clock, owned by nobody, and the raw
    // token is nowhere in the row.
    const [site] = await db.select().from(sites).where(eq(sites.slug, body.slug));
    assert.ok(site);
    assert.equal(site.status, "live");
    assert.equal(site.ownerId, null);
    assert.ok(site.expiresAt && site.purgeAfter);
    assert.equal(
      site.purgeAfter!.getTime() - site.expiresAt!.getTime(),
      DRAFT_GRACE_DAYS * MS_PER_DAY,
    );
    assert.ok(!JSON.stringify(site).includes(body.anonToken));

    // The version row records the exact key the object was written to, and the
    // key is derived from `siteId` — never from the slug.
    const [version] = await db
      .select()
      .from(siteVersions)
      .where(eq(siteVersions.siteId, site.id));
    assert.ok(version);
    assert.equal(site.currentVersionId, version.id);
    assert.equal(version.r2Key, pageObjectKey(site.id, version.id));
    assert.ok(!version.r2Key.includes(body.slug));
    assert.equal(version.sizeBytes, Buffer.byteLength(html, "utf8"));
    assert.equal(site.contentHash, version.contentHash);

    // R2 holds the bytes and the pointer.
    const r2 = r2Store();
    assert.equal(await r2.get(version.r2Key), html);
    assert.notEqual(await r2.get(pointerKey(body.slug)), null);

    // And the edge serves it.
    const deadline = Date.now() + SERVE_WINDOW_MS;
    let served = await probe(body.live_url);
    while (Date.now() < deadline && served.status !== 200) {
      await sleep(PROBE_INTERVAL_MS);
      served = await probe(body.live_url);
    }
    assert.equal(served.status, 200, "the minted live_url must serve the page");
    assert.match(served.body, new RegExp(marker));
  },
);

test(
  "dedup drill: same publisher converges on one page and rotates the token",
  { skip: skipLive },
  async () => {
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { jsonBody } = await import("../testing/file-sets");

    const html = pageHtml(runId());
    const who = publisher("203.0.113.30");

    const first = await publishPage(jsonBody({ html }), who);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.body));
    if (!first.ok) return;
    created.add(first.body.slug);

    const second = await publishPage(jsonBody({ html }), who);
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.body));
    if (!second.ok) return;

    // The same page: an agent retry loop lands on one page, not N.
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.slug, first.body.slug);
    assert.equal(second.body.live_url, first.body.live_url);
    assert.equal(second.body.expires_at, first.body.expires_at, "the clock is untouched");

    // …but a FRESH token, because the stored hash makes the original
    // unrecoverable by design. Exactly one claim URL is live at a time.
    assert.notEqual(second.body.anonToken, first.body.anonToken);
    assert.notEqual(second.body.claim_url, first.body.claim_url);

    const [site] = await db.select().from(sites).where(eq(sites.slug, first.body.slug));
    assert.ok(site);
    const { hashToken } = await import("@kept/shared");
    assert.equal(site.anonTokenHash, await hashToken(second.body.anonToken));

    // One row, one version, one object — nothing was minted the second time.
    const rows = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(eq(sites.contentHash, site.contentHash!), eq(sites.publisherHash, site.publisherHash!)),
      );
    assert.equal(rows.length, 1);
    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, site.id));
    assert.equal(versions.length, 1);
  },
);

test(
  "dedup is per publisher: identical bytes from a different client mint a second page",
  { skip: skipLive },
  async () => {
    const { publishPage } = await import("./pipeline");
    const { jsonBody } = await import("../testing/file-sets");
    const html = pageHtml(runId());

    const mine = await publishPage(jsonBody({ html }), publisher("203.0.113.40"));
    const theirs = await publishPage(jsonBody({ html }), publisher("203.0.113.41"));

    assert.equal(mine.ok, true);
    assert.equal(theirs.ok, true);
    if (!mine.ok || !theirs.ok) return;
    created.add(mine.body.slug);
    created.add(theirs.body.slug);

    // Nobody is ever handed a stranger's page — or delete rights over it —
    // because their bytes matched.
    assert.equal(theirs.body.deduped, false);
    assert.notEqual(theirs.body.slug, mine.body.slug);
    assert.notEqual(theirs.body.anonToken, mine.body.anonToken);
  },
);

test(
  "dedup drill: a deleted page is never deduped onto — republishing mints a new one",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites } = await import("../db/schema");
    const { deletePage } = await import("./anon-manage");
    const { publishPage } = await import("./pipeline");
    const { pointerKey } = await import("../storage/manifest");
    const { r2Store } = await import("../storage/r2");
    const { jsonBody } = await import("../testing/file-sets");

    const html = pageHtml(runId());
    const who = publisher("203.0.113.60");

    const first = await publishPage(jsonBody({ html }), who);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.body));
    if (!first.ok) return;
    created.add(first.body.slug);

    // Task 006's delete ARCHIVES: the row keeps its `expires_at` and its
    // `anon_token_hash`, so it still matches every other clause of the dedup
    // predicate. `status = 'live'` is the only thing excluding it.
    const deleted = await deletePage(first.body.anonToken);
    assert.equal(deleted.ok, true, deleted.ok ? "" : JSON.stringify(deleted.body));

    const [archived] = await db.select().from(sites).where(eq(sites.slug, first.body.slug));
    assert.ok(archived);
    assert.equal(archived.status, "archived");
    assert.ok(archived.expiresAt && archived.expiresAt > new Date(), "still unexpired");
    assert.ok(archived.anonTokenHash, "the token hash is retained for late recovery");

    // Identical bytes, same publisher, immediately after the delete.
    const second = await publishPage(jsonBody({ html }), who);
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.body));
    if (!second.ok) return;
    created.add(second.body.slug);

    // A NEW page, not `deduped: true` pointing at a link that 404s.
    assert.equal(second.body.deduped, false);
    assert.notEqual(second.body.slug, first.body.slug);

    // …and a real publish happened behind it: the deduped path writes no
    // manifest at all, so the pointer for the new slug is the proof.
    assert.notEqual(
      await r2Store().get(pointerKey(second.body.slug)),
      null,
      "a republish after a delete must write a manifest, not reuse the archived row",
    );

    const [minted] = await db.select().from(sites).where(eq(sites.slug, second.body.slug));
    assert.ok(minted);
    assert.notEqual(minted.id, archived.id);
    assert.equal(minted.status, "live");
  },
);

test(
  "rollback drill: an injected KV failure leaves no orphan object, pointer or row",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { pointerKey } = await import("../storage/manifest");
    const { pageObjectKey, r2Store } = await import("../storage/r2");
    const { jsonBody } = await import("../testing/file-sets");

    const prior = process.env.KV_NAMESPACE_ID;
    const logs: string[] = [];
    const realError = console.error;

    const outcome = await (async () => {
      console.error = (...args: unknown[]) => void logs.push(args.join(" "));
      // A REAL failure, not a stub: a well-formed namespace id that does not
      // exist makes the KV REST PUT 404 after the pointer is already written —
      // the `step: "kv"` case, the only one with something to unwind.
      process.env.KV_NAMESPACE_ID = "00000000000000000000000000000000";
      try {
        return await publishPage(jsonBody({ html: pageHtml(runId()) }), publisher("203.0.113.50"));
      } finally {
        console.error = realError;
        if (prior === undefined) delete process.env.KV_NAMESPACE_ID;
        else process.env.KV_NAMESPACE_ID = prior;
      }
    })();

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.status, 500);
    assert.equal(outcome.ok === false && outcome.body.error, "internal_error");

    // The failure log is the E07 divergence audit's entry point, so it must name
    // the site, the slug and the version (whose keys the rows name).
    const failure = logs.find((line) => line.includes("store write failed"));
    assert.ok(failure, `expected a store-failure log, got: ${logs.join(" | ")}`);
    const siteId = /site ([0-9a-f-]{36})/.exec(failure!)?.[1];
    const slug = /slug "([^"]+)"/.exec(failure!)?.[1];
    const versionId = /version ([0-9a-f-]{36})/.exec(failure!)?.[1];
    assert.ok(siteId && slug && versionId);
    const objectKey = pageObjectKey(siteId, versionId);
    assert.match(failure!, /manifest kv/);

    // Nothing survived: no pointer, no object, no row.
    const r2 = r2Store();
    assert.equal(await r2.get(pointerKey(slug!)), null, "orphan slug pointer");
    assert.equal(await r2.get(objectKey!), null, "orphan page object");
    const rows = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId!));
    assert.equal(rows.length, 0, "orphan site row");

    // A clean unwind logs the failure but never the "ROLLBACK INCOMPLETE" line
    // that E07's audit treats as a divergence.
    assert.equal(
      logs.filter((line) => line.includes("ROLLBACK INCOMPLETE")).length,
      0,
    );
  },
);

// ── E08 task 004: file sets through the anonymous publish ─────────────────────
// KV budget: two manifest writes (the regression page, the set page) and their
// two deletes in `after`. AC14 and AC5 write no manifest at all.

/** 001's AC17 fixture: `hashContent` of it at `dev-v0.8.0` (`fileset/shared-files.test.ts`). */
const PINNED_HTML = "<!doctype html>\n<title>kept — café ✓</title>\n<p>One page, one file. 🌱</p>\n";
const PINNED_HASH = "5c005c88c8eab03225411aa438e789d0d095f866b6f3b9125e08ffb773aa40ad";

/** A publisher nobody else is — so dedup and the governors see only this test. */
const freshPublisher = () => ({ ip: "203.0.113.94", userAgent: `kept-e08-004-drill/${crypto.randomUUID()}` });

/** A 1×1 PNG: D9 wants an image to start with its own signature. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test(
  "E08 Verification 1 / AC17: every legacy single-HTML form stores dev-v0.8.0's hash, one object, the old manifest and the old purge list",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { pendingPurges, sites, siteVersions } = await import("../db/schema");
    const { versionFiles } = await import("../db/queries/version-files");
    const { publishPage } = await import("./pipeline");
    const { readFileSet } = await import("./fileset/read");
    const { pointerKey } = await import("../storage/manifest");
    const { pageObjectKey, r2Store } = await import("../storage/r2");

    const url = "https://kept.test/api/publish";
    const forms: Record<string, () => Request> = {
      json: () =>
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ html: PINNED_HTML }),
        }),
      raw: () =>
        new Request(url, {
          method: "POST",
          headers: { "content-type": "text/html; charset=utf-8" },
          body: PINNED_HTML,
        }),
      multipart: () => {
        const form = new FormData();
        form.append("html", new File([PINNED_HTML], "page.html", { type: "text/html" }));
        return new Request(url, { method: "POST", body: form });
      },
    };

    const who = freshPublisher();
    const bodies = [];
    for (const [form, request] of Object.entries(forms)) {
      const outcome = await publishPage(() => readFileSet(request(), { plan: "free", uploaderId: null }), who);
      assert.equal(outcome.ok, true, `${form}: ${outcome.ok ? "" : JSON.stringify(outcome.body)}`);
      if (!outcome.ok) return;
      created.add(outcome.body.slug);
      bodies.push(outcome.body);
    }
    // One publisher, one hash: the second and third forms dedup onto the first
    // form's page — the three forms hash identically.
    assert.deepEqual(bodies.map((body) => body.deduped), [false, true, true]);
    const { slug } = bodies[0]!;
    assert.ok(bodies.every((body) => body.slug === slug));

    const [site] = await db.select().from(sites).where(eq(sites.slug, slug));
    assert.ok(site?.currentVersionId);
    assert.equal(site.contentHash, PINNED_HASH, "the dev-v0.8.0 content_hash");
    const [version] = await db.select().from(siteVersions).where(eq(siteVersions.id, site.currentVersionId));
    const bytes = new TextEncoder().encode(PINNED_HTML).length;
    assert.equal(version!.contentHash, PINNED_HASH);
    assert.equal(version!.sizeBytes, bytes);
    assert.equal(version!.fileCount, 1);
    assert.equal(version!.spa, false);
    assert.equal(version!.has404, false);
    assert.deepEqual(await versionFiles(db, version!.id), [{ path: "index.html", sizeBytes: bytes, sha256: PINNED_HASH }]);
    assert.equal(await r2Store().get(pageObjectKey(site.id, version!.id)), PINNED_HTML, "one object, the document's bytes");

    // The manifest dev-v0.8.0 wrote, key for key: no `spa`, no `has404`.
    const pointer = (await r2Store().get(pointerKey(slug)))!;
    const { updatedAt } = JSON.parse(pointer) as { updatedAt: number };
    assert.equal(
      pointer,
      JSON.stringify({ siteId: site.id, versionId: version!.id, status: "live", region: "auto", ownerId: null, updatedAt }),
    );

    // …and its purge list: exactly `/` and `/index.html`.
    const purges = await db.select().from(pendingPurges).where(eq(pendingPurges.slug, slug));
    const origin = `https://${slug}.${process.env.KEPT_BASE_DOMAIN}`;
    assert.deepEqual(purges.map((row) => row.urls), [[`${origin}/`, `${origin}/index.html`]]);
  },
);

test(
  "E08 AC15 + AC18: a file set stores every file and its rows, the manifest carries its flags, and the same set again is deduped",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { versionFiles } = await import("../db/queries/version-files");
    const { publishPage } = await import("./pipeline");
    const { pointerKey } = await import("../storage/manifest");
    const { r2Store, siteObjectKey } = await import("../storage/r2");
    const { fileSet, jsonBody } = await import("../testing/file-sets");

    const marker = runId();
    const body = {
      spa: true,
      files: [
        { path: "index.html", content: pageHtml(marker) },
        { path: "assets/app.css", content: `/* ${marker} */ body { color: #111 }` },
        { path: "assets/app.js", content: `console.log(${JSON.stringify(marker)});` },
        { path: "404.html", content: "<!doctype html><title>Not here</title>" },
        { path: "img/dot.png", content: PNG_BASE64, encoding: "base64" },
      ],
    };
    const expected = await fileSet(body);
    const who = freshPublisher();

    const first = await publishPage(jsonBody(body), who);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.body));
    if (!first.ok) return;
    created.add(first.body.slug);
    assert.equal(first.body.deduped, false);

    const [site] = await db.select().from(sites).where(eq(sites.slug, first.body.slug));
    assert.ok(site?.currentVersionId);
    const [version] = await db.select().from(siteVersions).where(eq(siteVersions.id, site.currentVersionId));
    assert.equal(version!.fileCount, 5);
    assert.equal(version!.sizeBytes, expected.totalBytes, "site_versions.size_bytes is the set total");
    assert.equal(site.sizeBytes, expected.totalBytes, "sites.size_bytes too");
    assert.equal(version!.contentHash, expected.contentHash, "the set hash (D10)");
    assert.equal(version!.spa, true);
    assert.equal(version!.has404, true, "a root 404.html is in the set");
    assert.deepEqual(
      await versionFiles(db, version!.id),
      expected.entries
        .map(({ path, bytes, sha256 }) => ({ path, sizeBytes: bytes.length, sha256 }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      "one row per stored path, with its size and SHA-256",
    );
    for (const entry of expected.entries) {
      const stream = await r2Store().getStream(siteObjectKey(site.id, version!.id, entry.path));
      assert.ok(stream, `${entry.path} is in R2`);
      const stored = new Uint8Array(await new Response(stream).arrayBuffer());
      assert.deepEqual(stored, entry.bytes, `${entry.path}: the stored bytes are the set's`);
    }

    const manifest = JSON.parse((await r2Store().get(pointerKey(site.slug)))!) as Record<string, unknown>;
    assert.equal(manifest.versionId, version!.id);
    assert.equal(manifest.spa, true);
    assert.equal(manifest.has404, true);

    // AC18: the same set from the same publisher converges on the one page.
    const second = await publishPage(jsonBody(body), who);
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.body));
    if (!second.ok) return;
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.slug, first.body.slug);
  },
);

test(
  "E08 AC14: a file R2 refuses unwinds the whole version — no object of it is left, and the publish leaves no row",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { hashBytes } = await import("@kept/shared");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { publishPage, writeVersionFiles } = await import("./pipeline");
    const { r2Store, siteObjectKey } = await import("../storage/r2");
    const { fileSet } = await import("../testing/file-sets");

    const marker = runId();
    const set = await fileSet({
      files: [
        { path: "index.html", content: pageHtml(marker) },
        ...Array.from({ length: 11 }, (_, i) => ({ path: `assets/f${i}.css`, content: `/* ${marker} ${i} */` })),
      ],
    });
    // THE SEAM (epic Risk 9): a path no validated set can carry, whose key is
    // past R2's 1,024-byte limit — a real refusal from R2, not a stub.
    const refusedBytes = new TextEncoder().encode("p {}");
    const refused = {
      path: `${"x".repeat(1100)}.css`,
      bytes: refusedBytes,
      sha256: await hashBytes(refusedBytes),
      contentType: "text/css; charset=utf-8",
    };
    const entries = [...set.entries.slice(0, 9), refused, ...set.entries.slice(9)];
    const r2 = r2Store();

    // ── the store half: every object it wrote is gone ────────────────────────
    const siteId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const result = await writeVersionFiles(siteId, versionId, { entries });
    console.log(`[e08-004] AC14 refusal → ${result.ok ? "accepted?!" : result.error.slice(0, 160)}`);
    assert.equal(result.ok, false, "R2 must refuse the 10th file");
    assert.equal(!result.ok && result.unwound, true, "and the unwind must complete");
    for (const entry of set.entries) {
      assert.equal(await r2.get(siteObjectKey(siteId, versionId, entry.path)), null, `${entry.path} survived the unwind`);
    }

    // ── through the publish: no row, no object ───────────────────────────────
    const crafted = { ...set, entries, contentHash: `e08-004-ac14-${crypto.randomUUID()}` };
    const logs: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logs.push(args.join(" "));
    let outcome: Awaited<ReturnType<typeof publishPage>>;
    try {
      outcome = await publishPage(async () => crafted, freshPublisher());
    } finally {
      console.error = realError;
    }
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.status, 500);
    assert.equal(!outcome.ok && outcome.body.error, "internal_error");
    assert.deepEqual(await db.select().from(sites).where(eq(sites.contentHash, crafted.contentHash)), [], "no site row");
    assert.deepEqual(
      await db.select().from(siteVersions).where(eq(siteVersions.contentHash, crafted.contentHash)),
      [],
      "no site_versions row",
    );
    const failure = logs.find((line) => line.includes("store write failed"));
    assert.ok(failure, `expected a store-failure log, got: ${logs.join(" | ")}`);
    const failedSite = /site ([0-9a-f-]{36})/.exec(failure)![1]!;
    const failedVersion = /version ([0-9a-f-]{36})/.exec(failure)![1]!;
    for (const entry of set.entries) {
      assert.equal(await r2.get(siteObjectKey(failedSite, failedVersion, entry.path)), null, `${entry.path} survived the publish`);
    }
    assert.equal(logs.filter((line) => line.includes("ROLLBACK INCOMPLETE")).length, 0, "a clean unwind");
  },
);

test(
  "E08 AC5: a set without a root index.html is missing_index — refused before anything is written",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { hashPublisher } = await import("@kept/shared");
    const { db } = await import("../db/index");
    const { sites } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { publisherHashSalt } = await import("../storage/env");
    const { jsonBody } = await import("../testing/file-sets");

    const who = freshPublisher();
    const outcome = await publishPage(
      jsonBody({
        files: [
          { path: "about/page.html", content: pageHtml(runId()) },
          { path: "app.css", content: "body { margin: 0 }" },
        ],
      }),
      who,
    );
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.status, 400);
    assert.equal(!outcome.ok && outcome.body.error, "missing_index");

    // The reader refused before the pipeline minted anything: this publisher
    // has no row at all (no `insertAnonymousDraft`, so no ids, no objects, no KV).
    const publisherHash = await hashPublisher(who.ip, who.userAgent, publisherHashSalt());
    assert.deepEqual(await db.select({ id: sites.id }).from(sites).where(eq(sites.publisherHash, publisherHash)), []);
  },
);
