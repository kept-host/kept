/**
 * The anonymous keep drills — E05 task 008.
 *
 * NO MOCKS (project rule). Every assertion runs `keepAnonymousPage` — the exact
 * function `app/api/anon/[anonToken]/keep/route.ts` delegates to — against the
 * real dev Neon branch, and the restore drill additionally uses the real dev R2
 * bucket, the real dev KV namespace, the real `purge_cache` endpoint and the
 * deployed dev Worker. The only thing the route adds on top is the session
 * lookup, which `next/headers` makes uncallable outside a Next request scope;
 * `e2e/anon-keep-api.spec.ts` covers that boundary over the wire instead.
 *
 * FOUR PROPERTIES ARE LOAD-BEARING and are asserted directly rather than
 * inferred from a status code:
 *
 *   1. The ordinary keep NEVER touches the store. Asserted by the absence of
 *      the slug pointer in R2 — `writeManifest` writes the pointer before KV,
 *      so no pointer means no manifest write and no purge.
 *   2. Unknown token, malformed token, every moderated status, an archived page
 *      and an expired-past-grace page produce the BYTE-IDENTICAL 404. A
 *      distinguishable answer turns a token guess into an existence probe.
 *   3. At `KEPT_PAGE_LIMIT` the keep still succeeds — `owned_draft`, HTTP 200,
 *      clocks retained, quota in the body. The cap degrades; it never rejects.
 *   4. A late keep inside grace puts the page BACK ON THE INTERNET: the row
 *      returns to `live` and the manifest is rewritten through `writeManifest`,
 *      which the drill proves by fetching the page from the dev edge.
 *
 * EVERY IMPORT OF THE DATABASE OR A STORE IS DYNAMIC AND INSIDE A TEST.
 * `lib/db/index.ts` opens its postgres client at module scope and throws without
 * `DATABASE_URL`, so a static import would turn "skipped" into "the file failed
 * to load". The drills SKIP without the dev credentials: CI runs `pnpm test` on
 * fork PRs with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row, object and KV key created here is removed in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  KEPT_PAGE_LIMIT,
  generateAnonToken,
  hashToken,
  type SiteStatus,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

/**
 * Fill only what is MISSING, exactly as `../auth/session-lifecycle.test.ts`
 * does: a real value in `.env.local` always wins, so this can never hide a
 * misconfiguration. Constructing the auth instance validates all eight auth
 * variables and the OAuth/Resend apps are not provisioned yet — but the session
 * drill below reaches no OAuth endpoint, no token exchange and no Resend call,
 * so these are configuration the flow never uses rather than a stub standing in
 * for a service. The one thing substituted is the INBOX, and only through the
 * magic-link plugin's own storage contract.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "anon-keep-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

/** Postgres alone is enough for every branch except the restore. */
const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** The restore drill additionally writes R2 + KV and reads the dev edge. */
const STORE_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "PUBLISHER_HASH_SALT",
] as const;
const missingStores = STORE_VARS.filter((name) => !process.env[name]);
const skipStores =
  skipLive ||
  (missingStores.length > 0
    ? `store credentials absent (${missingStores.join(", ")})`
    : false);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Contract §6: the documented worst case for a KV read to reflect a write. */
const PROPAGATION_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();
/** Slugs whose manifest this file wrote and must remove again. */
const createdManifests = new Set<string>();

async function client() {
  const { db } = await import("../db/index");
  return db;
}

async function schema() {
  return import("../db/schema");
}

/** A brand-new account with zero kept pages. */
async function makeProfile(): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  const email = `e05-008-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "E05-008 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  status?: SiteStatus;
  /** Days from now; negative for a clock that has already run out. */
  expiresInDays?: number;
  /** Null → no grace window at all (a kept page). */
  graceDays?: number | null;
  ownerId?: string | null;
  /** Give the row a `site_versions` row so a manifest can be built from it. */
  withVersion?: boolean;
}

/**
 * An anonymous page with a REAL bearer token: the raw token is returned, only
 * its SHA-256 reaches the row — exactly what the publish pipeline does.
 */
async function makeSite({
  status = "live",
  expiresInDays = DRAFT_TTL_DAYS,
  graceDays = DRAFT_GRACE_DAYS,
  ownerId = null,
  withVersion = false,
}: MakeSite = {}): Promise<{ id: string; slug: string; token: string; versionId: string }> {
  const db = await client();
  const { sites, siteVersions } = await schema();
  const { pageObjectKey } = await import("../storage/r2");

  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const slug = `e05-008-${id.slice(0, 12)}`;
  const token = generateAnonToken();
  const expiresAt = new Date(Date.now() + expiresInDays * MS_PER_DAY);

  await db.insert(sites).values({
    id,
    slug,
    status,
    region: "auto",
    currentVersionId: withVersion ? versionId : null,
    ownerId,
    anonTokenHash: await hashToken(token),
    publisherHash: "e05-008-drill",
    expiresAt,
    purgeAfter:
      graceDays === null ? null : new Date(expiresAt.getTime() + graceDays * MS_PER_DAY),
    claimedAt: null,
    contentHash: "e05-008",
    sizeBytes: 128,
  });
  if (withVersion) {
    await db.insert(siteVersions).values({
      id: versionId,
      siteId: id,
      region: "auto",
      r2Key: pageObjectKey(id, versionId),
      contentHash: "e05-008",
      sizeBytes: 128,
    });
  }
  createdSites.add(id);
  return { id, slug, token, versionId };
}

/**
 * `n` kept pages against one profile — `owner_id` set, `expires_at IS NULL`,
 * `status = 'live'`, which is the ONLY definition of kept-ness the cap counts.
 */
async function fillKept(profileId: string, n: number): Promise<void> {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  for (let i = 0; i < n; i++) {
    const site = await makeSite({ ownerId: profileId });
    await db
      .update(sites)
      .set({ expiresAt: null, purgeAfter: null, anonTokenHash: null, claimedAt: new Date() })
      .where(eq(sites.id, site.id));
  }
}

async function readSite(siteId: string) {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return row;
}

/** The failure body, as a string, so two refusals can be compared byte for byte. */
function refusal(outcome: { ok: boolean; status?: number; body?: unknown }): string {
  assert.equal(outcome.ok, false);
  return JSON.stringify({ status: outcome.status, body: outcome.body });
}

after(async () => {
  if (skipLive) return;
  const { eq, inArray } = await import("drizzle-orm");
  const db = await client();
  const { profiles, sites, user } = await schema();

  if (createdManifests.size > 0) {
    const { removeManifest } = await import("../storage/manifest");
    const { pageObjectKey, r2Store } = await import("../storage/r2");
    for (const slug of createdManifests) {
      await removeManifest(slug).catch(() => undefined);
      const [row] = await db.select().from(sites).where(eq(sites.slug, slug));
      if (row?.currentVersionId) {
        await r2Store()
          .delete(pageObjectKey(row.id, row.currentVersionId))
          .catch(() => undefined);
      }
    }
  }
  if (createdSites.size > 0) {
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdProfiles.size > 0) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.$client.end();
});

test(
  "under the cap: the page is kept, both clocks are gone, the token is dead — and nothing touched the store",
  { skip: skipLive },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");
    const { pointerKey } = await import("../storage/manifest");
    const { r2Store } = await import("../storage/r2");

    const profileId = await makeProfile();
    const site = await makeSite();

    const outcome = await keepAnonymousPage(site.token, profileId);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok === false && outcome.body));
    if (!outcome.ok) return;

    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.outcome, "kept");
    assert.equal(outcome.body.siteId, site.id);
    assert.equal(outcome.body.slug, site.slug);
    assert.equal(outcome.body.restored, false);
    assert.match(outcome.body.liveUrl, new RegExp(`^https://${site.slug}\\.`));
    // The limit comes from the shared constant, never a literal 3.
    assert.equal(outcome.body.quota.limit, KEPT_PAGE_LIMIT);
    assert.equal(outcome.body.quota.used, 1);
    assert.equal(outcome.body.quota.remaining, KEPT_PAGE_LIMIT - 1);

    const row = await readSite(site.id);
    assert.equal(row.expiresAt, null, "a kept page has no clock");
    assert.equal(row.purgeAfter, null);
    assert.equal(row.anonTokenHash, null, "two authorities on one page is a bug");
    assert.equal(row.ownerId, profileId);
    assert.ok(row.claimedAt, "claimed_at records when the page stopped being anonymous");
    assert.equal(row.status, "live", "keeping never changes the status");
    assert.equal(row.slug, site.slug, "the URL must not move");

    // PROPERTY 1. `writeManifest` writes the slug pointer BEFORE KV, so the
    // absence of a pointer for a slug that was never published is proof that
    // the ordinary keep wrote no manifest and burned no purge.
    if (!skipStores) {
      assert.equal(await r2Store().get(pointerKey(site.slug)), null);
    }
  },
);

test(
  "the token dies on keep: a double-submitted keep link is the same 404 as an unknown token",
  { skip: skipLive },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");

    const profileId = await makeProfile();
    const site = await makeSite();

    const first = await keepAnonymousPage(site.token, profileId);
    assert.equal(first.ok, true);

    const second = await keepAnonymousPage(site.token, profileId);
    const unknown = await keepAnonymousPage(generateAnonToken(), profileId);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.status, 404);
    assert.equal(
      refusal(second),
      refusal(unknown),
      "an already-kept page must not be distinguishable from a page that never existed",
    );
  },
);

test(
  "at the cap: HTTP success, an owned draft, the clock retained and the quota returned",
  { skip: skipLive },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");

    const profileId = await makeProfile();
    await fillKept(profileId, KEPT_PAGE_LIMIT);
    const site = await makeSite();
    const before = await readSite(site.id);

    const outcome = await keepAnonymousPage(site.token, profileId);
    assert.equal(outcome.ok, true, "the cap is a branch, never a 4xx");
    if (!outcome.ok || outcome.body.outcome !== "owned_draft") {
      assert.fail(`expected owned_draft, got ${JSON.stringify(outcome)}`);
    }

    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.quota.limit, KEPT_PAGE_LIMIT);
    assert.equal(outcome.body.quota.used, KEPT_PAGE_LIMIT);
    assert.equal(outcome.body.quota.remaining, 0);
    assert.equal(
      outcome.body.expiresAt,
      before.expiresAt?.toISOString(),
      "a live page at the cap keeps the clock it already had",
    );

    const row = await readSite(site.id);
    assert.equal(row.ownerId, profileId, "at the cap the page is still OWNED");
    assert.equal(row.anonTokenHash, null, "and the token still dies");
    assert.deepEqual(row.expiresAt, before.expiresAt);
    assert.ok(row.claimedAt);
  },
);

test(
  "one indistinguishable 404: unknown, malformed, every moderated status, archived, and past grace",
  { skip: skipLive },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");
    const profileId = await makeProfile();

    const refusals = new Set<string>();

    // Structurally impossible, structurally plausible but unknown, and empty.
    for (const token of ["../../etc/passwd", generateAnonToken(), ""]) {
      refusals.add(refusal(await keepAnonymousPage(token, profileId)));
    }

    // Every status a bearer token may NOT keep. `resolveAnonToken` is called
    // with `requireLive: false` for the late keep, so these reach the caller's
    // own allowlist and must die there.
    for (const status of ["archived", "removed", "quarantined", "under_review"] as const) {
      const site = await makeSite({ status });
      refusals.add(refusal(await keepAnonymousPage(site.token, profileId)));
      assert.equal((await readSite(site.id)).ownerId, null, `${status} must not be claimable`);
    }

    // Expired, and PAST its grace window: awaiting E07's hard delete.
    const gone = await makeSite({
      status: "expired",
      expiresInDays: -(DRAFT_GRACE_DAYS + 2),
      graceDays: DRAFT_GRACE_DAYS,
    });
    refusals.add(refusal(await keepAnonymousPage(gone.token, profileId)));
    assert.equal((await readSite(gone.id)).ownerId, null);

    // An expired row with NO grace window recorded cannot be shown to be inside
    // one, so it is refused rather than guessed at.
    const clockless = await makeSite({ status: "expired", expiresInDays: -1, graceDays: null });
    refusals.add(refusal(await keepAnonymousPage(clockless.token, profileId)));

    assert.equal(
      refusals.size,
      1,
      `expected ONE 404 body for every reason, got:\n${[...refusals].join("\n")}`,
    );
  },
);

test(
  "at the cap AND expired: the page comes back on a FRESH draft clock, never a resumed one",
  { skip: skipStores },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");

    const profileId = await makeProfile();
    await fillKept(profileId, KEPT_PAGE_LIMIT);
    // Expired yesterday, 29 days of grace left, and a version so a manifest can
    // be built from the row.
    const site = await makeSite({
      status: "expired",
      expiresInDays: -1,
      graceDays: DRAFT_GRACE_DAYS,
      withVersion: true,
    });
    createdManifests.add(site.slug);

    const before = Date.now();
    const outcome = await keepAnonymousPage(site.token, profileId);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok === false && outcome.body));
    if (!outcome.ok || outcome.body.outcome !== "owned_draft") {
      assert.fail(`expected owned_draft, got ${JSON.stringify(outcome)}`);
    }

    assert.equal(outcome.body.restored, true, "the response says the page is back");
    const expiresAt = new Date(outcome.body.expiresAt).getTime();
    assert.ok(
      expiresAt > before + (DRAFT_TTL_DAYS - 1) * MS_PER_DAY,
      "a fresh DRAFT_TTL_DAYS window, not the expired one it arrived with",
    );

    const row = await readSite(site.id);
    assert.equal(row.status, "live", "the restore flips the status back");
    assert.equal(row.ownerId, profileId);
    assert.equal(row.anonTokenHash, null);
    assert.deepEqual(row.expiresAt, new Date(outcome.body.expiresAt));
    assert.deepEqual(row.purgeAfter, new Date(outcome.body.purgeAfter));
  },
);

test(
  "a failed manifest write is reported honestly and leaves the row consistent, not half-kept",
  { skip: skipStores },
  async () => {
    const { keepAnonymousPage } = await import("./anon-keep");

    const profileId = await makeProfile();
    const site = await makeSite({
      status: "expired",
      expiresInDays: -1,
      graceDays: DRAFT_GRACE_DAYS,
      withVersion: true,
    });
    // The pointer write still succeeds, so R2 has an object to clean up.
    createdManifests.add(site.slug);

    // REAL MISCONFIGURATION, NOT A STUB: a KV namespace id that does not exist.
    // `lib/storage/env.ts` re-reads the environment on every call, so this
    // reaches Cloudflare and fails there — the same failure a rotated
    // credential or a deleted namespace would produce in production.
    const realNamespace = process.env.KV_NAMESPACE_ID;
    process.env.KV_NAMESPACE_ID = "00000000000000000000000000000000";

    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    let outcome;
    try {
      outcome = await keepAnonymousPage(site.token, profileId);
    } finally {
      console.error = realError;
      process.env.KV_NAMESPACE_ID = realNamespace;
    }

    assert.equal(outcome.ok, false, "a restore that never reached the edge must not answer 200");
    assert.equal(outcome.ok === false && outcome.status, 500);
    assert.equal(outcome.ok === false && outcome.body.error, "internal_error");
    assert.match(
      outcome.ok === false ? outcome.body.message : "",
      /on your account/,
      "the body must say the page is kept but not yet back — not a bare 'try again'",
    );
    assert.ok(
      errors.some((line) => line.includes("RESTORE INCOMPLETE") && line.includes(site.slug)),
      `the divergence must be logged loudly, got: ${errors.join(" | ")}`,
    );

    // Postgres committed and is the authority: the page is owned, permanent and
    // marked live, so the restore is replayable rather than half-applied.
    const row = await readSite(site.id);
    assert.equal(row.status, "live");
    assert.equal(row.ownerId, profileId);
    assert.equal(row.expiresAt, null);
    assert.equal(row.anonTokenHash, null);
  },
);

test(
  "the session boundary: a REAL Better Auth session resolves to the profile the page ends up owned by",
  { skip: skipLive },
  async () => {
    const { auth } = await import("../auth/index");
    const { getProfileForSession } = await import("../db/queries/profile");
    const { keepAnonymousPage } = await import("./anon-keep");
    const { signedOut } = await import("./owner-routes");

    // The signed-out branch the route takes before it reads the token at all.
    // `getSession()` itself needs a Next request scope, so what is asserted here
    // is what the handler does with its `null`.
    assert.equal(await getProfileForSession(null), null);
    const refused = signedOut();
    assert.equal(refused.status, 401, "no session is a 401, never a redirect carrying the token");
    assert.equal(refused.body.error, "invalid_request");

    const baseUrl = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)!.replace(
      /\/+$/,
      "",
    );
    const ctx = await auth.$context;
    const linkToken = crypto.randomUUID().replace(/-/g, "");
    const email = `e05-008-${linkToken.slice(0, 8)}@kept-e05-008.invalid`;

    // The inbox, and only the inbox: `storeToken` defaults to "plain", so the
    // identifier IS the token `sendMagicLink` would have put in a URL.
    await ctx.internalAdapter.createVerificationValue({
      identifier: linkToken,
      value: JSON.stringify({ email, name: "E05-008 session drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });
    const verified = await auth.handler(
      new Request(`${baseUrl}/api/auth/magic-link/verify?token=${linkToken}`),
    );
    assert.equal(verified.status, 200, await verified.clone().text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .join("; ");

    // Read the session back through the cookie Better Auth itself wrote — the
    // exact value `getSession()` returns inside a request scope.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.ok(session, "the minted cookie must resolve to a session");
    createdProfiles.add(session.user.id);

    const profile = await getProfileForSession(session);
    assert.ok(profile, "a signed-in user always has a profile (bootstrapped on create)");

    const site = await makeSite();
    const outcome = await keepAnonymousPage(site.token, profile.id);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok === false && outcome.body));

    const row = await readSite(site.id);
    assert.equal(
      row.ownerId,
      session.user.id,
      "the page belongs to the SESSION's account — the token says which page, never whose",
    );
  },
);

test(
  "late keep inside grace: the manifest is rewritten and the page serves from the dev edge again",
  { skip: skipStores },
  async () => {
    const { publishPage } = await import("../publish/pipeline");
    const { keepAnonymousPage } = await import("./anon-keep");
    const { removeManifest, pointerKey } = await import("../storage/manifest");
    const { r2Store } = await import("../storage/r2");
    const { eq } = await import("drizzle-orm");
    const db = await client();
    const { sites } = await schema();

    const marker = `e05-008-${crypto.randomUUID().slice(0, 8)}`;
    const published = await publishPage(
      {
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`,
      },
      { ip: "203.0.113.80", userAgent: "kept-e05-008-drill/1.0" },
    );
    assert.equal(published.ok, true, published.ok ? "" : JSON.stringify(published.body));
    if (!published.ok) return;

    const slug = published.body.slug;
    createdManifests.add(slug);
    const [row] = await db.select().from(sites).where(eq(sites.slug, slug));
    assert.ok(row);
    createdSites.add(row.id);

    // E07's expiry sweep, performed by hand: the manifest is REMOVED and the
    // row goes to `expired` with its grace window still open. The URL is
    // deliberately never requested while it is down, so no colo has cached
    // either the absence or a stale KV read.
    assert.equal((await removeManifest(slug)).ok, true);
    await db
      .update(sites)
      .set({
        status: "expired",
        expiresAt: new Date(Date.now() - MS_PER_DAY),
        purgeAfter: new Date(Date.now() + (DRAFT_GRACE_DAYS - 1) * MS_PER_DAY),
      })
      .where(eq(sites.id, row.id));

    const profileId = await makeProfile();
    const outcome = await keepAnonymousPage(published.body.anonToken, profileId);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok === false && outcome.body));
    if (!outcome.ok) return;

    assert.equal(outcome.body.outcome, "kept");
    assert.equal(outcome.body.restored, true);
    assert.equal(outcome.body.liveUrl, published.body.live_url);

    const restored = await readSite(row.id);
    assert.equal(restored.status, "live");
    assert.equal(restored.expiresAt, null, "under the cap, the restored page is permanent");
    assert.equal(restored.purgeAfter, null);
    assert.equal(restored.ownerId, profileId);
    assert.equal(restored.anonTokenHash, null);

    // The pointer is back, carrying the row's own region and the new owner —
    // and `writeManifest` writes the same bytes to KV in the same call.
    const pointer = await r2Store().get(pointerKey(slug));
    assert.ok(pointer, "the slug pointer must exist again after a restore");
    assert.deepEqual(JSON.parse(pointer), {
      siteId: row.id,
      versionId: row.currentVersionId,
      status: "live",
      region: "auto",
      ownerId: profileId,
      updatedAt: JSON.parse(pointer).updatedAt as number,
    });

    // AND THE PAGE IS ACTUALLY BACK. A fresh cache-busting URL each poll, so
    // the answer is always a real KV read rather than the Cache API's memory of
    // one, and a KV write can take up to `PROPAGATION_WINDOW_MS` to be visible.
    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    let served = { status: 0, body: "" };
    while (Date.now() < deadline) {
      const response = await fetch(`${published.body.live_url}/?p=${crypto.randomUUID()}`, {
        redirect: "manual",
      });
      served = { status: response.status, body: await response.text() };
      if (served.status === 200 && served.body.includes(marker)) break;
      await sleep(PROBE_INTERVAL_MS);
    }
    assert.equal(served.status, 200, `the edge still says ${served.status} after the restore`);
    assert.ok(served.body.includes(marker), "the restored page must serve its own bytes");
  },
);
