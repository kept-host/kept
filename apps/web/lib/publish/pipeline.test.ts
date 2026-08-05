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
  const { sites, siteVersions } = await import("../db/schema");
  const { removeManifest } = await import("../storage/manifest");
  const { pageObjectKey, r2Store } = await import("../storage/r2");

  for (const slug of created) {
    const [row] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
    await removeManifest(slug).catch(() => undefined);
    if (!row) continue;
    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, row.id));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(row.id, version.id))
        .catch(() => undefined);
    }
    await db.delete(sites).where(eq(sites.id, row.id));
  }
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
    const who = publisher("203.0.113.10");

    const empty = await publishPage({ html: "" }, who);
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.status, 400);
    assert.equal(empty.ok === false && empty.body.error, "empty_page");

    const oversized = await publishPage({ html: "x".repeat(MAX_PAGE_BYTES + 1) }, who);
    assert.equal(oversized.ok === false && oversized.status, 413);
    assert.equal(oversized.ok === false && oversized.body.error, "page_too_large");

    const malformed = await publishPage({ notHtml: true }, who);
    assert.equal(malformed.ok === false && malformed.status, 400);
    assert.equal(malformed.ok === false && malformed.body.error, "invalid_request");

    // A `slug` in the body is not a field — the PRD rules custom slugs out at
    // publish, and E06 owns rename. It is ignored, never honoured.
    const withSlug = await publishPage(
      { html: pageHtml(runId()), slug: "chosen-by-caller" },
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

    const marker = runId();
    const html = pageHtml(marker);
    const outcome = await publishPage({ html }, publisher("203.0.113.20"));

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

    const html = pageHtml(runId());
    const who = publisher("203.0.113.30");

    const first = await publishPage({ html }, who);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.body));
    if (!first.ok) return;
    created.add(first.body.slug);

    const second = await publishPage({ html }, who);
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
    const html = pageHtml(runId());

    const mine = await publishPage({ html }, publisher("203.0.113.40"));
    const theirs = await publishPage({ html }, publisher("203.0.113.41"));

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
  "rollback drill: an injected KV failure leaves no orphan object, pointer or row",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { pointerKey } = await import("../storage/manifest");
    const { r2Store } = await import("../storage/r2");

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
        return await publishPage({ html: pageHtml(runId()) }, publisher("203.0.113.50"));
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
    // the site, the slug and the object.
    const failure = logs.find((line) => line.includes("store write failed"));
    assert.ok(failure, `expected a store-failure log, got: ${logs.join(" | ")}`);
    const siteId = /site ([0-9a-f-]{36})/.exec(failure!)?.[1];
    const slug = /slug "([^"]+)"/.exec(failure!)?.[1];
    const objectKey = /object "([^"]+)"/.exec(failure!)?.[1];
    assert.ok(siteId && slug && objectKey);
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
