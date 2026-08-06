import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  KEPT_PAGE_LIMIT,
  keepResultSchema,
  publishErrorSchema,
} from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { db, schema } from "../lib/db";

/**
 * The three owner routes over the wire — E05 task 010.
 *
 * `lib/sites/owner-routes.test.ts` drills the cap, the clocks and the no-oracle
 * property directly against the dev database, because `next/headers` makes the
 * *handlers* uncallable outside a request scope. This file covers exactly the
 * part that drill cannot: the session boundary and the router.
 *
 *   1. **Signed out is 401 on all three.** The gate is the whole point of
 *      `/api/sites/` existing as a separate prefix from `/api/anon/` (epic
 *      decision D3), and it must hold before any database work happens.
 *   2. **`swap` is not captured by `[id]`.** Next resolves static segments
 *      before dynamic ones. Structurally `/api/sites/swap` is a one-segment
 *      path and `[id]/keep` is a two-segment one, so they cannot collide — but
 *      the assertion is one request and the alternative is discovering it in
 *      production.
 *   3. **A real session reaches the primitives.** Signed in, keep/demote/swap
 *      answer with the shared schemas' shapes and honour ownership.
 *
 * NO MOCKS. Real dev Neon branch, real Better Auth instance, real signed
 * cookie, real HTTP. The one thing substituted is the **inbox**: with no
 * `RESEND_API_KEY` provisioned the magic-link plugin cannot hand a URL to
 * Resend, so this file writes the verification value through the plugin's own
 * storage contract and then calls the REAL `/api/auth/magic-link/verify`.
 * Nothing about Better Auth is stubbed — the email transport is skipped,
 * exactly as `lib/auth/session-lifecycle.test.ts` established.
 *
 * SKIPS without a database and an auth secret: CI runs on fork PRs with no
 * secrets, and a control plane with no `BETTER_AUTH_SECRET` cannot construct
 * `auth` at all. Run locally with `apps/web/.env.local` populated.
 */
config({ path: ".env.local", quiet: true });

const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET"].filter(
  (name) => !process.env[name]?.trim(),
);

const SKIP: string | false =
  missing.length > 0
    ? `auth/dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

test.describe("owner site routes", () => {
  test.skip(!!SKIP, SKIP || undefined);

  const createdUserIds: string[] = [];
  const createdSiteIds: string[] = [];

  test.afterAll(async () => {
    if (SKIP) return;
    if (createdSiteIds.length) {
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (createdUserIds.length) {
      // Cascades `profiles`, `session` and `account`.
      await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
    }
    await db.$client.end();
  });

  /** A real session cookie, minted through the real verify endpoint. */
  async function signIn(baseURL: string): Promise<string> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replace(/-/g, "");
    const email = `e05-010-${token.slice(0, 8)}@kept-e05-010.invalid`;

    // The inbox, and only the inbox: `storeToken` defaults to "plain", so the
    // identifier IS the token `sendMagicLink` would have put in a URL.
    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E05-010 wire drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const response = await fetch(`${baseURL}/api/auth/magic-link/verify?token=${token}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    createdUserIds.push(body.user.id);

    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .join("; ");
    expect(cookie.length).toBeGreaterThan(0);
    return cookie;
  }

  /** The profile Better Auth's create hook bootstrapped for a fresh user. */
  async function profileIdFor(cookie: string, baseURL: string): Promise<string> {
    const response = await fetch(`${baseURL}/api/auth/get-session`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    return body.user.id;
  }

  async function makeSite(ownerId: string, kept: boolean): Promise<string> {
    const id = crypto.randomUUID();
    const msPerDay = 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * msPerDay);
    await db.insert(schema.sites).values({
      id,
      slug: `e05-010-wire-${id.slice(0, 12)}`,
      status: "live",
      region: "auto",
      ownerId,
      publisherHash: "e05-010-wire",
      expiresAt: kept ? null : expiresAt,
      purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * msPerDay),
      claimedAt: new Date(),
      contentHash: "e05-010-wire",
      sizeBytes: 128,
    });
    createdSiteIds.push(id);
    return id;
  }

  test("signed out, all three routes refuse with 401 before any database work", async ({
    request,
    baseURL,
  }) => {
    const someId = crypto.randomUUID();
    const targets: [string, unknown][] = [
      [`${baseURL}/api/sites/${someId}/keep`, undefined],
      [`${baseURL}/api/sites/${someId}/demote`, undefined],
      [`${baseURL}/api/sites/swap`, { demote: crypto.randomUUID(), keep: crypto.randomUUID() }],
    ];

    for (const [url, data] of targets) {
      const response = await request.post(url, data === undefined ? {} : { data });
      expect(response.status(), `${url} must gate before it reads anything`).toBe(401);
      // The closed error shape, so a client can branch on it.
      publishErrorSchema.parse(await response.json());
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
  });

  test("`swap` is a static segment and never lands in the `[id]` handler", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const ownerId = await profileIdFor(cookie, baseURL!);
    const site = await makeSite(ownerId, true);

    // `demote === keep` is a 400 that ONLY the swap handler emits — the `[id]`
    // handlers answer 401 or 404 and never look at a body. Getting it back is
    // proof the request resolved to `swap/route.ts`.
    const response = await request.post(`${baseURL}/api/sites/swap`, {
      headers: { cookie },
      data: { demote: site, keep: site },
    });
    expect(response.status()).toBe(400);
    publishErrorSchema.parse(await response.json());
  });

  test("signed in, keep and demote round-trip and a stranger's page is 404", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const ownerId = await profileIdFor(cookie, baseURL!);
    const draft = await makeSite(ownerId, false);

    const kept = await request.post(`${baseURL}/api/sites/${draft}/keep`, {
      headers: { cookie },
    });
    expect(kept.status()).toBe(200);
    const keepBody = keepResultSchema.parse(await kept.json());
    expect(keepBody.outcome).toBe("kept");
    expect(keepBody.quota.limit).toBe(KEPT_PAGE_LIMIT);
    expect(
      (await db.select().from(schema.sites).where(eq(schema.sites.id, draft)))[0]?.expiresAt,
    ).toBeNull();

    const demoted = await request.post(`${baseURL}/api/sites/${draft}/demote`, {
      headers: { cookie },
    });
    expect(demoted.status()).toBe(200);

    // A second account's page, from this account's session.
    const otherCookie = await signIn(baseURL!);
    const otherOwner = await profileIdFor(otherCookie, baseURL!);
    const theirs = await makeSite(otherOwner, true);

    const refused = await request.post(`${baseURL}/api/sites/${theirs}/keep`, {
      headers: { cookie },
    });
    expect(refused.status()).toBe(404);

    // Byte-identical to a page that simply does not exist.
    const absent = await request.post(`${baseURL}/api/sites/${crypto.randomUUID()}/keep`, {
      headers: { cookie },
    });
    expect(absent.status()).toBe(404);
    expect(await refused.text()).toBe(await absent.text());
  });
});
