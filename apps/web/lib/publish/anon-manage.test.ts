/**
 * Replace / delete / reminder — E04 task 006's drills.
 *
 * NO MOCKS (project rule). Everything below runs against the real dev Neon
 * branch, the real dev R2 bucket, the real dev KV namespace, the real
 * `purge_cache` endpoint and the deployed dev Worker. The two failure drills
 * inject REAL misconfiguration — a KV namespace id that does not exist, an unset
 * zone id — rather than stubbing a client, which works because
 * `lib/storage/env.ts` re-reads and re-validates the environment on every call.
 *
 * The drills SKIP when the dev credentials are absent: CI runs `pnpm test` on
 * fork PRs with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * THE TESTS ARE ORDERED AND STATEFUL. One page is published at the top and then
 * replaced, replaced with a broken purge, replaced with a broken KV, deleted and
 * deleted again — because that is the sequence a real publisher performs, and
 * because the delete drill's "never a 200" is only meaningful after the earlier
 * drills have proved this slug CAN serve.
 *
 * EVERY IMPORT OF THE PIPELINE IS DYNAMIC AND INSIDE A TEST. `lib/db/index.ts`
 * opens its postgres client at module scope and throws without `DATABASE_URL`,
 * so a static import would turn "skipped" into "the file failed to load".
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";

// The KV client is imported here — and, outside `lib/storage/`, only here and in
// `manifest.test.ts` — to FORCE A KV MISS. `eslint.config.mjs` exempts this file
// for that reason and no other: nothing below writes a manifest through it. The
// delete drill is theatre without it, because while KV still answers "absent"
// every request 404s regardless of whether the pointer was deleted first.
import { kvStore } from "../storage/kv";

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

/** Contract §6: the documented worst case for a KV read to reflect a write. */
const PROPAGATION_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;

const created = new Set<string>();

const publisher = (ip: string) => ({ ip, userAgent: "kept-e04-006-drill/1.0" });
const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;
const runId = () => `e04-006-${crypto.randomUUID().slice(0, 8)}`;

/** The one page every drill below operates on, established by the first test. */
const page: {
  slug: string;
  token: string;
  liveUrl: string;
  siteId: string;
  expiresAt: string;
} = { slug: "", token: "", liveUrl: "", siteId: "", expiresAt: "" };

/** No query string, ever: it changes the cache key and defeats the purge. */
async function probe(url: string) {
  const res = await fetch(url, { redirect: "manual" });
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control") ?? "",
    body: await res.text(),
  };
}

/** Poll until the edge shows `marker`, or give up and return what it last said. */
async function probeUntil(url: string, marker: RegExp) {
  const deadline = Date.now() + PROPAGATION_WINDOW_MS;
  let seen = await probe(url);
  while (Date.now() < deadline && !marker.test(seen.body)) {
    await sleep(PROBE_INTERVAL_MS);
    seen = await probe(url);
  }
  return seen;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Capture `console.error` around a call without losing it on a throw. */
async function withCapturedErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = realError;
  }
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
});

test(
  "an unknown, malformed or wrong token is one indistinguishable 404 on all three routes",
  { skip: skipLive },
  async () => {
    const { deletePage, replacePage, updateReminderEmail } = await import("./anon-manage");

    // Structurally impossible, structurally plausible but unknown, and empty.
    const tokens = ["../../etc/passwd", "A".repeat(43), ""];
    const bodies = new Set<string>();

    for (const token of tokens) {
      const replaced = await replacePage(token, { html: pageHtml(runId()) });
      const deleted = await deletePage(token);
      const reminded = await updateReminderEmail(token, { reminderEmail: "a@b.co" });

      for (const outcome of [replaced, deleted, reminded]) {
        assert.equal(outcome.ok, false);
        assert.equal(outcome.ok === false && outcome.status, 404);
        assert.equal(outcome.ok === false && outcome.body.error, "invalid_request");
        bodies.add(JSON.stringify(outcome.ok === false ? outcome.body : null));
      }
    }

    // ONE body across every route and every reason: no oracle that separates
    // "wrong token" from "no such page" from "deleted".
    assert.equal(bodies.size, 1, `expected one 404 body, got ${[...bodies].join(" | ")}`);
  },
);

test(
  "replace drill: same URL, new bytes at the edge, and the draft clock is NOT extended",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { replacePage } = await import("./anon-manage");
    const { pageObjectKey, r2Store } = await import("../storage/r2");

    const first = pageHtml(`${runId()}-v1`);
    const published = await publishPage({ html: first }, publisher("203.0.113.60"));
    assert.equal(published.ok, true, published.ok ? "" : JSON.stringify(published.body));
    if (!published.ok) return;

    page.slug = published.body.slug;
    page.token = published.body.anonToken;
    page.liveUrl = published.body.live_url;
    page.expiresAt = published.body.expires_at;
    created.add(page.slug);

    const [before] = await db.select().from(sites).where(eq(sites.slug, page.slug));
    assert.ok(before);
    page.siteId = before.id;
    const firstVersionId = before.currentVersionId!;

    assert.equal((await probeUntil(page.liveUrl, /-v1/)).status, 200);

    const second = pageHtml(`${runId()}-v2`);
    const replaced = await replacePage(page.token, { html: second });
    assert.equal(replaced.ok, true, replaced.ok ? "" : JSON.stringify(replaced.body));
    if (!replaced.ok) return;

    // Same page: the slug and therefore the URL are stable, which is the whole
    // point of replace and the reason R2 is keyed by `siteId`.
    assert.equal(replaced.body.slug, page.slug);
    assert.equal(replaced.body.live_url, page.liveUrl);

    // THE CLOCK IS UNTOUCHED. Re-dropping a file must not buy another seven
    // days, or a weekly `curl` keeps a page forever for free.
    assert.equal(replaced.body.expires_at, page.expiresAt);

    const [after_] = await db.select().from(sites).where(eq(sites.id, page.siteId));
    assert.ok(after_);
    assert.equal(after_.expiresAt!.toISOString(), before.expiresAt!.toISOString());
    assert.equal(after_.purgeAfter!.toISOString(), before.purgeAfter!.toISOString());

    // A new version row, pointed at, with the new bytes' hash and size.
    assert.notEqual(after_.currentVersionId, firstVersionId);
    assert.notEqual(after_.contentHash, before.contentHash);
    assert.equal(after_.sizeBytes, Buffer.byteLength(second, "utf8"));
    const versions = await db
      .select()
      .from(siteVersions)
      .where(eq(siteVersions.siteId, page.siteId));
    assert.equal(versions.length, 2);
    const current = versions.find((v) => v.id === after_.currentVersionId);
    assert.ok(current);
    assert.equal(current.r2Key, pageObjectKey(page.siteId, current.id));
    assert.equal(current.contentHash, after_.contentHash);

    // ARCHIVE, DON'T DELETE: the previous version's object is still in R2.
    const r2 = r2Store();
    assert.equal(await r2.get(pageObjectKey(page.siteId, firstVersionId)), first);
    assert.equal(await r2.get(current.r2Key), second);

    // And the edge serves the NEW bytes — which only happens because
    // `writeManifest` purged both URL forms.
    const served = await probeUntil(page.liveUrl, /-v2/);
    assert.equal(served.status, 200);
    assert.match(served.body, /-v2/);
  },
);

test(
  "the purge is what makes a replacement visible: with it broken, the old page keeps serving",
  { skip: skipLive },
  async () => {
    const { replacePage } = await import("./anon-manage");
    const { purgeUrls } = await import("../storage/purge");
    const { slugPurgeUrls } = await import("../storage/manifest");

    const third = pageHtml(`${runId()}-v3`);
    const prior = process.env.CLOUDFLARE_ZONE_ID;

    // A REAL misconfiguration: `purgeConfig()` re-reads the environment on every
    // call, so unsetting the zone id fails the purge exactly as a bad deploy
    // would — and nothing else about the replace changes.
    const { result: replaced, errors } = await withCapturedErrors(async () => {
      delete process.env.CLOUDFLARE_ZONE_ID;
      try {
        return await replacePage(page.token, { html: third });
      } finally {
        restoreEnv("CLOUDFLARE_ZONE_ID", prior);
      }
    });

    // Contract §3: a failed purge is logged, never surfaced as a failure. The
    // stores are correct; only the edge is stale.
    assert.equal(replaced.ok, true, replaced.ok ? "" : JSON.stringify(replaced.body));
    assert.ok(
      errors.some((line) => line.includes("purge") && line.includes(page.slug)),
      `expected a logged purge failure, got: ${errors.join(" | ")}`,
    );

    // `LIVE_CACHE_CONTROL` is a year and nothing expires on its own (§1), so the
    // edge is still serving v2 even though R2 and KV both say v3.
    const stale = await probe(page.liveUrl);
    assert.equal(stale.status, 200);
    assert.match(stale.body, /-v2/, "without a purge the edge must keep serving the old bytes");

    // Replay the purge by hand: if v3 appears now, the purge is what did it.
    assert.ok((await purgeUrls(slugPurgeUrls(page.slug))).ok);
    const fresh = await probeUntil(page.liveUrl, /-v3/);
    assert.equal(fresh.status, 200);
    assert.match(fresh.body, /-v3/);
  },
);

test(
  "replace rollback: an injected KV failure leaves the page serving the PREVIOUS bytes",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { replacePage } = await import("./anon-manage");
    const { pointerKey } = await import("../storage/manifest");
    const { r2Store } = await import("../storage/r2");

    const [before] = await db.select().from(sites).where(eq(sites.id, page.siteId));
    assert.ok(before);
    const versionsBefore = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, page.siteId));
    const priorNamespace = process.env.KV_NAMESPACE_ID;

    const { result: outcome, errors } = await withCapturedErrors(async () => {
      // A well-formed namespace id that does not exist: the KV REST PUT 404s
      // AFTER the pointer has been overwritten — the `step: "kv"` case, the only
      // one with something to unwind.
      process.env.KV_NAMESPACE_ID = "00000000000000000000000000000000";
      try {
        return await replacePage(page.token, { html: pageHtml(`${runId()}-v4`) });
      } finally {
        restoreEnv("KV_NAMESPACE_ID", priorNamespace);
      }
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.status, 500);
    assert.equal(outcome.ok === false && outcome.body.error, "internal_error");

    const failure = errors.find((line) => line.includes("store write failed"));
    assert.ok(failure, `expected a store-failure log, got: ${errors.join(" | ")}`);
    const orphanKey = /object "([^"]+)"/.exec(failure)?.[1];
    assert.ok(orphanKey);

    // THE ROW IS BACK WHERE IT WAS. Not a new version, not a dangling pointer to
    // a version whose bytes were deleted.
    const [after_] = await db.select().from(sites).where(eq(sites.id, page.siteId));
    assert.ok(after_);
    assert.equal(after_.currentVersionId, before.currentVersionId);
    assert.equal(after_.contentHash, before.contentHash);
    assert.equal(after_.sizeBytes, before.sizeBytes);
    const versionsAfter = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, page.siteId));
    assert.equal(
      versionsAfter.length,
      versionsBefore.length,
      "the failed version row must be gone",
    );

    // No orphan object, and the pointer names the version that is still current
    // — the unwind RESTORED the manifest rather than removing it, because
    // removing it would take a working page dark.
    const r2 = r2Store();
    assert.equal(await r2.get(orphanKey), null, "orphan page object");
    const pointer = await r2.get(pointerKey(page.slug));
    assert.ok(pointer);
    assert.equal(JSON.parse(pointer).versionId, before.currentVersionId);
    // The real KV was never touched by the failing put, so both stores agree.
    const kvValue = await kvStore().get(page.slug);
    assert.ok(kvValue);
    assert.equal(JSON.parse(kvValue).versionId, before.currentVersionId);

    // A failed replace is invisible to visitors.
    const served = await probe(page.liveUrl);
    assert.equal(served.status, 200);
    assert.match(served.body, /-v3/);
  },
);

test(
  "delete drill under a FORCED KV miss: a deleted page is never resurrected",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites, siteVersions } = await import("../db/schema");
    const { deletePage } = await import("./anon-manage");
    const { pointerKey, slugPurgeUrls } = await import("../storage/manifest");
    const { purgeUrls } = await import("../storage/purge");
    const { r2Store } = await import("../storage/r2");

    const kv = kvStore();
    const r2 = r2Store();

    // ── the positive control ────────────────────────────────────────────────
    // Delete the KV key BY HAND, leaving the pointer, and purge. The page must
    // keep serving with `s-maxage=60` — E03's observable signature of a response
    // that came through `slugs/{slug}.json`. Without this, "never a 200" below
    // could be explained by a fallback that never fires at all.
    await kv.delete(page.slug);
    assert.equal(await kv.get(page.slug), null, "KV must miss for this to test anything");
    assert.ok((await purgeUrls(slugPurgeUrls(page.slug))).ok);

    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    let fallback = await probe(page.liveUrl);
    while (Date.now() < deadline && !fallback.cacheControl.includes("s-maxage=60")) {
      await sleep(PROBE_INTERVAL_MS);
      fallback = await probe(page.liveUrl);
    }
    assert.equal(fallback.status, 200, "a KV miss must fall through to the pointer");
    assert.match(fallback.cacheControl, /s-maxage=60\b/);

    // ── the delete ──────────────────────────────────────────────────────────
    const deleted = await deletePage(page.token);
    assert.equal(deleted.ok, true, deleted.ok ? "" : JSON.stringify(deleted.body));

    // Pointer first: it is gone, and KV — already missing — stayed gone. A
    // KV-first delete would leave the pointer standing right here.
    assert.equal(await r2.get(pointerKey(page.slug)), null, "the pointer must be gone");
    assert.equal(await kv.get(page.slug), null);

    // ARCHIVE, NOT DESTROY: the row and every version's bytes are retained for
    // E07's grace-end job. The only thing between a visitor and the page is the
    // pointer's absence — which is exactly the window §7.3 exists for.
    const [row] = await db.select().from(sites).where(eq(sites.id, page.siteId));
    assert.ok(row, "the row must survive a delete");
    assert.equal(row.status, "archived");
    assert.ok(row.purgeAfter, "E07's grace-end sweep reads purge_after");
    const versions = await db
      .select()
      .from(siteVersions)
      .where(eq(siteVersions.siteId, page.siteId));
    // v1 (publish), v2 (replace), v3 (replace with the purge broken). The failed
    // v4 was unwound and must not be here.
    assert.equal(versions.length, 3);
    for (const version of versions) {
      assert.notEqual(await r2.get(version.r2Key), null, "bytes must be retained");
    }

    // ── never a 200, across the whole propagation window ─────────────────────
    const stop = Date.now() + PROPAGATION_WINDOW_MS;
    do {
      const seen = await probe(page.liveUrl);
      assert.notEqual(
        seen.status,
        200,
        `deleted page served ${seen.status} with ${seen.cacheControl} — the pointer outlived the KV delete`,
      );
      await sleep(PROBE_INTERVAL_MS);
    } while (Date.now() < stop);
  },
);

test(
  "delete is idempotent, and an archived page can no longer be replaced",
  { skip: skipLive },
  async () => {
    const { deletePage, replacePage, updateReminderEmail } = await import("./anon-manage");

    // A retrying agent or a double-clicked button gets the state it asked for,
    // not a 500 and not a 404.
    const again = await deletePage(page.token);
    assert.equal(again.ok, true, again.ok ? "" : JSON.stringify(again.body));
    assert.deepEqual(again.ok && again.body, { ok: true });

    // The token still resolves — it is how E05/E07's late-recovery path finds
    // the page — but the manage operations are closed, and they close with the
    // same 404 a stranger's token gets.
    const replaced = await replacePage(page.token, { html: pageHtml(runId()) });
    assert.equal(replaced.ok === false && replaced.status, 404);
    const reminded = await updateReminderEmail(page.token, { reminderEmail: "a@b.co" });
    assert.equal(reminded.ok === false && reminded.status, 404);
  },
);

test(
  "reminder: stores, overwrites and clears, with one response either way",
  { skip: skipLive },
  async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../db/index");
    const { sites } = await import("../db/schema");
    const { publishPage } = await import("./pipeline");
    const { updateReminderEmail } = await import("./anon-manage");

    const published = await publishPage(
      { html: pageHtml(runId()) },
      publisher("203.0.113.61"),
    );
    assert.equal(published.ok, true, published.ok ? "" : JSON.stringify(published.body));
    if (!published.ok) return;
    created.add(published.body.slug);
    const token = published.body.anonToken;

    const readEmail = async () => {
      const [row] = await db
        .select({ reminderEmail: sites.reminderEmail })
        .from(sites)
        .where(eq(sites.slug, published.body.slug));
      return row?.reminderEmail ?? null;
    };

    const stored = await updateReminderEmail(token, { reminderEmail: "first@example.com" });
    assert.equal(stored.ok, true);
    assert.equal(await readEmail(), "first@example.com");

    const overwritten = await updateReminderEmail(token, {
      reminderEmail: "second@example.com",
    });
    assert.equal(await readEmail(), "second@example.com");

    const cleared = await updateReminderEmail(token, { reminderEmail: "" });
    assert.equal(await readEmail(), null);

    const nulled = await updateReminderEmail(token, { reminderEmail: null });
    assert.equal(await readEmail(), null);

    // IDENTICAL RESPONSES. Storing, overwriting and clearing must be
    // indistinguishable, or the endpoint tells a stranger with a leaked link
    // whether the publisher left an address.
    const shapes = new Set(
      [stored, overwritten, cleared, nulled].map((o) => JSON.stringify([o.ok, o.status, o.body])),
    );
    assert.equal(shapes.size, 1, `expected one response shape, got ${[...shapes].join(" | ")}`);

    // A bad address is a validation error, not a silent no-op.
    const bad = await updateReminderEmail(token, { reminderEmail: "not-an-email" });
    assert.equal(bad.ok === false && bad.status, 400);
    assert.equal(bad.ok === false && bad.body.error, "invalid_request");
    assert.equal(await readEmail(), null);
  },
);
