/**
 * The origin gate — E05a task 006's drills.
 *
 * TWO HALVES, ON PURPOSE.
 *
 * 1. THE DECISION TABLE, run everywhere including CI. `lib/storage/env.ts`
 *    re-reads and re-validates `process.env` on every call, so pinning
 *    `BETTER_AUTH_URL` around a call is the real configuration path and not a
 *    stub — the same technique `anon-manage.test.ts` uses to inject real
 *    misconfiguration. No mocks anywhere (project rule).
 *
 * 2. THE WIRING, run against the real dev Neon branch. The four in-scope route
 *    modules are imported and their exported `POST` is CALLED — the actual
 *    handler, not a re-implementation — and the site rows are RE-READ
 *    afterwards, because "it answered 403" and "it changed nothing" are
 *    different claims and only the second one matters. That the handlers are
 *    callable outside a Next request scope at all is itself the proof that the
 *    gate runs before `getSession()`: `next/headers` is never reached on a
 *    refused request.
 *
 *    The over-the-wire versions of these, through a running server with a real
 *    signed-in browser context, are task 008's (`e2e/`), which this task blocks.
 *
 * 3. THE KEYLESS GUARANTEE, also live: `POST /api/publish` and
 *    `DELETE /api/anon/:token` succeed with NO `Origin` header at all. E08's
 *    entire wedge is agents publishing keyless; an origin requirement leaking
 *    onto those routes would be a product regression discovered two epics late,
 *    so it is asserted here rather than assumed from a code reading.
 *
 * The live drills SKIP when the dev credentials are absent: CI runs `pnpm test`
 * on fork PRs with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, publishErrorSchema } from "@kept/shared";
import { config } from "dotenv";

import { refuseUntrustedOrigin } from "./origin";

config({ path: ".env.local", quiet: true });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The pinned control-plane origin the decision table is asserted against. */
const APP = "https://app.kept-dev.xyz";
/** A hosted page — same registrable domain, and the whole reason this exists. */
const HOSTED = "https://calm-fox-42.kept-dev.xyz";
/** A session cookie, of the shape task 005 pins. Its VALUE is never inspected. */
const COOKIE = "__Host-kept.session_token=drill.not-a-real-session";

const DB_VARS = ["DATABASE_URL", "BETTER_AUTH_SECRET", "NEXT_PUBLIC_APP_URL"] as const;
const PUBLISH_VARS = [
  ...DB_VARS,
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

function absent(names: readonly string[]): string | false {
  const missing = names.filter((name) => !process.env[name]);
  return missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;
}

const skipDb = absent(DB_VARS);
const skipPublish = absent(PUBLISH_VARS);

// ── 1. THE DECISION TABLE ───────────────────────────────────────────────────

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Ask the real helper, with the trusted origin pinned to `APP` for the duration
 * of the call and restored afterwards so the live drills below still resolve
 * the environment's own value.
 */
function decide(headers: Record<string, string>): { refused: boolean; status?: number; response?: Response } {
  const priorUrl = process.env.BETTER_AUTH_URL;
  const priorSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_URL = APP;
  process.env.BETTER_AUTH_SECRET ??= "drill-secret-that-is-at-least-32-bytes-long";
  try {
    const res = refuseUntrustedOrigin(
      new Request(`${APP}/api/sites/swap`, { method: "POST", headers }),
    );
    return res === null
      ? { refused: false }
      : { refused: true, status: res.status, response: res };
  } finally {
    restore("BETTER_AUTH_URL", priorUrl);
    restore("BETTER_AUTH_SECRET", priorSecret);
  }
}

const refused = (headers: Record<string, string>) => decide(headers).refused;

test("a cookie-bearing request from the app's own origin is allowed", () => {
  assert.equal(refused({ cookie: COOKIE, origin: APP }), false);
  // A browser sends `Origin` on every POST, so this is the shape of every real
  // dashboard request; `Sec-Fetch-Site` agreeing changes nothing.
  assert.equal(
    refused({ cookie: COOKIE, origin: APP, "sec-fetch-site": "same-origin" }),
    false,
  );
});

test("a cookie-bearing request from any other origin is 403 — the hosted page included", () => {
  for (const origin of [
    HOSTED, // the same-site case `SameSite=Lax` does not block
    "https://kept-dev.xyz", // the apex, which serves the landing and mints nothing
    "https://evil.example",
    "null", // an opaque origin: sandboxed iframe, redirected cross-origin POST
  ]) {
    assert.equal(decide({ cookie: COOKIE, origin }).status, 403, origin);
  }
});

test("the comparison is scheme + host + port, never a prefix or suffix match", () => {
  for (const origin of [
    "https://app.kept-dev.xyz.evil.com", // the suffix attack
    "https://notapp.kept-dev.xyz",
    "http://app.kept-dev.xyz", // scheme differs
    "https://app.kept-dev.xyz:8443", // port differs
    "https://app.kept-dev.xyz@evil.example", // userinfo confusion
    "not a url at all",
    "", // present but empty: treated as absent, and then refused for it
  ]) {
    assert.equal(decide({ cookie: COOKIE, origin }).status, 403, origin);
  }
  // A trailing slash is not a different origin — `URL` normalises it away.
  assert.equal(refused({ cookie: COOKIE, origin: `${APP}/` }), false);
});

test("with no Origin, only `Sec-Fetch-Site: same-origin` passes — `same-site` is refused on purpose", () => {
  assert.equal(refused({ cookie: COOKIE, "sec-fetch-site": "same-origin" }), false);
  // `same-site` is EXACTLY the hosted-page case. Allowing it would undo the task.
  assert.equal(decide({ cookie: COOKIE, "sec-fetch-site": "same-site" }).status, 403);
  assert.equal(decide({ cookie: COOKIE, "sec-fetch-site": "cross-site" }).status, 403);
  // `none` is a user-initiated navigation with no initiator — not the dashboard.
  assert.equal(decide({ cookie: COOKIE, "sec-fetch-site": "none" }).status, 403);
});

test("a cookie with neither Origin nor Sec-Fetch-Site is 403, matching Better Auth", () => {
  // better-auth@1.6.26 `validateOrigin` throws MISSING_OR_NULL_ORIGIN for this
  // shape on its own endpoints. One app, one answer per request shape.
  assert.equal(decide({ cookie: COOKIE }).status, 403);
});

test("a request with no cookie is never asked for an origin — the keyless contract", () => {
  // Mirrors better-auth's `const useCookies = headers.has("cookie")`. Nothing
  // ambient is being spent, so there is nothing to protect; the handler's own
  // 401 answers it. This is the branch every agent call depends on.
  assert.equal(refused({}), false);
  assert.equal(refused({ origin: HOSTED }), false);
  assert.equal(refused({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(refused({ "content-type": "text/html" }), false);
});

test("the refusal is the publish family's closed error shape, uncacheable", async () => {
  const { response } = decide({ cookie: COOKIE, origin: HOSTED });
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // No `Retry-After`: this is not a transient condition and a client must not
  // be told to try the same forbidden thing again.
  assert.equal(response.headers.get("retry-after"), null);
  const body = publishErrorSchema.parse(await response.json());
  assert.equal(body.error, "invalid_request");
  // The message names the origin that IS allowed, so a developer debugging a
  // 403 is not left guessing. It never echoes the rejected origin back.
  assert.ok(body.message.includes(APP));
  assert.equal(body.message.includes(HOSTED), false);
});

test("the five bearer-credential routes do not import the gate", async () => {
  const { readFile } = await import("node:fs/promises");
  const bearerRoutes = [
    "app/api/publish/route.ts",
    "app/api/anon/[anonToken]/route.ts",
    "app/api/anon/[anonToken]/replace/route.ts",
    "app/api/anon/[anonToken]/reminder/route.ts",
    // The scheduled sweep, authorised by `Authorization: Bearer CRON_SECRET`
    // from `.github/workflows/cron-draft-reminder.yml`. A GitHub Actions `curl`
    // sends no `Origin` and no `Sec-Fetch-Site`, so a gate here would refuse
    // every run — and the failure would surface as reminder emails quietly not
    // being sent, not as anything a browser flow would ever notice.
    "app/api/cron/draft-reminder/route.ts",
  ];
  for (const path of bearerRoutes) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.equal(
      source.includes("refuseUntrustedOrigin"),
      false,
      `${path} must stay keyless — E08's agents send no Origin header.`,
    );
  }
});

// ── 2. THE WIRING, against the real dev database ────────────────────────────

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();
const createdSlugs = new Set<string>();

async function db() {
  const { db } = await import("../db/index");
  return db;
}

async function makeProfile(): Promise<string> {
  const client = await db();
  const { profiles, user } = await import("../db/schema");
  const id = crypto.randomUUID();
  const email = `e05a-006-${id}@kept.invalid`;
  await client.insert(user).values({ id, name: "E05a-006 drill", email, emailVerified: true });
  await client.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

async function makeSite(ownerId: string, kept: boolean): Promise<string> {
  const client = await db();
  const { sites } = await import("../db/schema");
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);
  await client.insert(sites).values({
    id,
    slug: `e05a-006-${id.slice(0, 12)}`,
    status: "live",
    region: "auto",
    ownerId,
    publisherHash: "e05a-006-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: now,
    contentHash: "e05a-006",
    sizeBytes: 128,
  });
  createdSites.add(id);
  return id;
}

/** The whole row, so "mutates nothing" is asserted over every column. */
async function snapshot(siteId: string): Promise<string> {
  const client = await db();
  const { sites } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await client.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return JSON.stringify(row);
}

function crossOrigin(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: COOKIE,
      origin: HOSTED,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sameOrigin(url: string, appOrigin: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: COOKIE,
      origin: appOrigin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * What the handler does once the gate lets it through. It cannot complete out
 * here — `getSession()` reads `next/headers`, which needs a Next request scope —
 * so the assertion is the honest one: whatever happens, it is NOT the 403. Both
 * admissible outcomes (a throw from `next/headers`, or a 401 for a session that
 * does not resolve) prove the same thing: the refusal is origin-dependent, not
 * blanket.
 */
async function statusOrThrow(call: () => Promise<Response>): Promise<number | "threw"> {
  try {
    return (await call()).status;
  } catch {
    return "threw";
  }
}

after(async () => {
  if (skipDb) return;
  const client = await db();
  const { profiles, sites, siteVersions, user } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const { removeManifest } = await import("../storage/manifest");
  const { pageObjectKey, r2Store } = await import("../storage/r2");

  for (const slug of createdSlugs) {
    await removeManifest(slug).catch(() => undefined);
    const [row] = await client.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
    if (row) createdSites.add(row.id);
  }
  for (const id of createdSites) {
    const versions = await client
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, id));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(id, version.id))
        .catch(() => undefined);
    }
    await client.delete(sites).where(eq(sites.id, id));
  }
  for (const id of createdProfiles) {
    // `profiles.id` FKs `user.id` with `on delete cascade`, so one delete does both.
    await client.delete(profiles).where(eq(profiles.id, id));
    await client.delete(user).where(eq(user.id, id));
  }
  // No resource leak: `postgres-js` holds the pool open and the process would
  // otherwise never exit.
  await client.$client.end();
});

test(
  "a cross-origin swap is 403 and both rows are untouched on re-read",
  { skip: skipDb },
  async () => {
    const { POST } = await import("../../app/api/sites/swap/route");
    const { appOrigin } = await import("../storage/env");
    const owner = await makeProfile();
    const kept = await makeSite(owner, true);
    const draft = await makeSite(owner, false);
    const before = [await snapshot(kept), await snapshot(draft)];

    const res = await POST(
      crossOrigin("https://app.kept-dev.xyz/api/sites/swap", { demote: kept, keep: draft }),
    );

    assert.equal(res.status, 403);
    assert.equal(publishErrorSchema.parse(await res.json()).error, "invalid_request");
    // The claim that matters: the database, re-read, not the status code.
    assert.deepEqual([await snapshot(kept), await snapshot(draft)], before);

    // And the identical request from the app's own origin is not refused here.
    const allowed = await statusOrThrow(() =>
      POST(
        sameOrigin("https://app.kept-dev.xyz/api/sites/swap", appOrigin(), {
          demote: kept,
          keep: draft,
        }),
      ),
    );
    assert.notEqual(allowed, 403);
    assert.deepEqual([await snapshot(kept), await snapshot(draft)], before);
  },
);

test(
  "a cross-origin keep is 403 and the row is untouched on re-read",
  { skip: skipDb },
  async () => {
    const { POST } = await import("../../app/api/sites/[id]/keep/route");
    const { appOrigin } = await import("../storage/env");
    const owner = await makeProfile();
    const draft = await makeSite(owner, false);
    const before = await snapshot(draft);
    const params = Promise.resolve({ id: draft });

    const res = await POST(
      crossOrigin(`https://app.kept-dev.xyz/api/sites/${draft}/keep`),
      { params },
    );

    assert.equal(res.status, 403);
    // Still a draft: the clock is intact, so nothing was kept.
    assert.equal(await snapshot(draft), before);

    const allowed = await statusOrThrow(() =>
      POST(sameOrigin(`https://app.kept-dev.xyz/api/sites/${draft}/keep`, appOrigin()), {
        params: Promise.resolve({ id: draft }),
      }),
    );
    assert.notEqual(allowed, 403);
    assert.equal(await snapshot(draft), before);
  },
);

test(
  "a cross-origin demote is 403 and the kept page keeps no clock",
  { skip: skipDb },
  async () => {
    const { POST } = await import("../../app/api/sites/[id]/demote/route");
    const owner = await makeProfile();
    const kept = await makeSite(owner, true);
    const before = await snapshot(kept);

    const res = await POST(
      crossOrigin(`https://app.kept-dev.xyz/api/sites/${kept}/demote`),
      { params: Promise.resolve({ id: kept }) },
    );

    assert.equal(res.status, 403);
    assert.equal(await snapshot(kept), before);
  },
);

test(
  "the anonymous keep — two credentials — is 403 cross-origin before the token is read",
  { skip: skipDb },
  async () => {
    const { POST } = await import("../../app/api/anon/[anonToken]/keep/route");
    // No row is needed: the gate must refuse before the token is resolved, so a
    // token that names nothing still gets 403 rather than the token 404. That
    // ordering is the point — a refused request performs no lookup at all.
    const res = await POST(
      crossOrigin("https://app.kept-dev.xyz/api/anon/e05a-006-nonexistent/keep"),
      { params: Promise.resolve({ anonToken: "e05a-006-nonexistent" }) },
    );
    assert.equal(res.status, 403);
    assert.equal(publishErrorSchema.parse(await res.json()).error, "invalid_request");
  },
);

// ── 3. THE KEYLESS GUARANTEE ────────────────────────────────────────────────

test(
  "publish and delete succeed with no Origin header at all — E08's agent path",
  { skip: skipPublish },
  async () => {
    const { POST } = await import("../../app/api/publish/route");
    const { DELETE } = await import("../../app/api/anon/[anonToken]/route");

    // Exactly the shape of `curl -X POST --data-binary @page.html`: no Origin,
    // no Sec-Fetch-Site, no cookie, no key.
    const published = await POST(
      new Request("https://app.kept-dev.xyz/api/publish", {
        method: "POST",
        headers: { "content-type": "text/html", "user-agent": "kept-e05a-006-drill/1.0" },
        body: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>e05a-006</title></head><body><h1>e05a-006</h1></body></html>\n",
      }),
    );

    assert.equal(published.status, 201);
    const body = (await published.json()) as { slug: string; anonToken: string };
    createdSlugs.add(body.slug);

    const deleted = await DELETE(
      new Request(`https://app.kept-dev.xyz/api/anon/${body.anonToken}`, { method: "DELETE" }),
      { params: Promise.resolve({ anonToken: body.anonToken }) },
    );
    assert.equal(deleted.status, 200);
  },
);
