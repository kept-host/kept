import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  KEPT_PAGE_LIMIT,
  generateAnonToken,
  hashToken,
  publishErrorSchema,
} from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `POST /api/anon/:anonToken/keep` over the wire — E05 task 008.
 *
 * `lib/sites/anon-keep.test.ts` drills the cap, the clocks, the indistinguishable
 * 404 and the late-keep restore directly against the dev stack, because
 * `next/headers` makes the *handler* uncallable outside a Next request scope.
 * This file covers exactly the part that drill cannot: the route itself.
 *
 *   1. **Signed out is 401, and the page is untouched.** Not a redirect — a
 *      `Location` carrying the bearer token would leak it through `Referer` to
 *      wherever it landed. Task 009's screen turns this 401 into a sign-in link.
 *   2. **The two prefixes do not overlap.** `/api/anon/:token/keep` is the
 *      bearer door; `/api/sites/:id/keep` is the session-only owner door (epic
 *      decision D3). A token posted at the owner route must not keep anything.
 *   3. **A real session reaches the primitive**, the response carries the shared
 *      schema's shape plus `liveUrl`/`restored`, and the token dies on success.
 *
 * NO MOCKS. Real dev Neon branch, real Better Auth instance, real signed
 * cookie, real HTTP. The one thing substituted is the **inbox**: with no
 * `RESEND_API_KEY` provisioned the magic-link plugin cannot hand a URL to
 * Resend, so this file writes the verification value through the plugin's own
 * storage contract and then calls the REAL `/api/auth/magic-link/verify`.
 *
 * SKIPS without a database and the seven variables `createAuth()` validates:
 * the first touch of `auth` constructs the whole instance and throws if any of
 * them is empty, so with the OAuth apps unprovisioned the route answers 500 and
 * never reaches its own logic. That is a missing OAuth app, not a broken route,
 * and it is asserted honestly rather than worked around. Unlike the unit drill,
 * a spec cannot inject placeholders — the values have to be in the *server's*
 * environment, not this process's.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

const SKIP: string | false =
  missing.length > 0
    ? `auth/dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

test.describe("anonymous keep route", () => {
  test.skip(!!SKIP, SKIP || undefined);

  // Two of the three tests here mint a real session, which is ~15 s of remote
  // Postgres before the first assertion. See `./live-stack.ts`.
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  const createdUserIds: string[] = [];
  const createdSiteIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP) return;
    if (createdSiteIds.length) {
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (createdUserIds.length) {
      // Cascades `profiles`, `session` and `account`.
      await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
    }
    await closeDb();
  });

  /** A real session cookie, minted through the real verify endpoint. */
  async function signIn(baseURL: string): Promise<string> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replace(/-/g, "");
    const email = `e05-008-${token.slice(0, 8)}@kept-e05-008.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E05-008 wire drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const requestCtx = await jarlessContext();
    try {
      const response = await requestCtx.get(
        `${baseURL}/api/auth/magic-link/verify?token=${token}`,
      );
      expect(response.status(), await response.text()).toBe(200);
      const body = (await response.json()) as { user: { id: string } };
      createdUserIds.push(body.user.id);

      const cookie = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value.split(";", 1)[0])
        .join("; ");
      expect(cookie.length).toBeGreaterThan(0);
      return cookie;
    } finally {
      await requestCtx.dispose();
    }
  }

  /** An anonymous draft with a REAL bearer token; only its digest is stored. */
  async function makeAnonSite(): Promise<{ id: string; slug: string; token: string }> {
    const id = crypto.randomUUID();
    const slug = `e05-008-wire-${id.slice(0, 12)}`;
    const token = generateAnonToken();
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * MS_PER_DAY);

    await db.insert(schema.sites).values({
      id,
      slug,
      status: "live",
      region: "auto",
      ownerId: null,
      anonTokenHash: await hashToken(token),
      publisherHash: "e05-008-wire",
      expiresAt,
      purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
      contentHash: "e05-008-wire",
      sizeBytes: 128,
    });
    createdSiteIds.push(id);
    return { id, slug, token };
  }

  test("signed out, the keep route refuses with 401 and leaves the page anonymous", async ({
    request,
    baseURL,
  }) => {
    const site = await makeAnonSite();

    const response = await request.post(`${baseURL}/api/anon/${site.token}/keep`);
    expect(response.status()).toBe(401);
    // No redirect: a `Location` would carry the bearer token into `Referer`.
    expect(response.headers()["location"]).toBeUndefined();
    publishErrorSchema.parse(await response.json());
    expect(response.headers()["cache-control"]).toContain("no-store");

    const [row] = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id));
    expect(row?.ownerId).toBeNull();
    expect(row?.anonTokenHash).not.toBeNull();
  });

  test("a bearer token is not an owner id: the owner route refuses it", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const site = await makeAnonSite();

    // `/api/sites/:id/` is session-authenticated and owner-scoped (D3). The
    // token is not a uuid and, even if it were, the row is not this account's.
    //
    // `sessionHeaders` and not a bare `cookie`: task 006's origin check refuses
    // a cookie-bearing mutating call that carries no `Origin`, which a real
    // browser always sends and an `APIRequestContext` never does. See
    // `./session-request.ts`.
    const wrongDoor = await request.post(`${baseURL}/api/sites/${site.token}/keep`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(wrongDoor.status()).toBe(404);

    const byId = await request.post(`${baseURL}/api/sites/${site.id}/keep`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(byId.status(), "an unclaimed draft is not keepable through the owner door").toBe(
      404,
    );

    const [row] = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id));
    expect(row?.ownerId).toBeNull();
  });

  test("signed in, the keep lands and the token dies", async ({ request, baseURL }) => {
    const cookie = await signIn(baseURL!);
    const site = await makeAnonSite();

    const response = await request.post(`${baseURL}/api/anon/${site.token}/keep`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");

    const body = (await response.json()) as {
      outcome: string;
      slug: string;
      liveUrl: string;
      restored: boolean;
      quota: { limit: number; used: number; remaining: number };
    };
    expect(body.outcome).toBe("kept");
    expect(body.slug).toBe(site.slug);
    expect(body.restored).toBe(false);
    expect(body.liveUrl).toContain(site.slug);
    expect(body.quota.limit).toBe(KEPT_PAGE_LIMIT);

    const [row] = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id));
    expect(row?.expiresAt).toBeNull();
    expect(row?.anonTokenHash).toBeNull();
    expect(row?.claimedAt).not.toBeNull();

    // The token is dead everywhere — and answers exactly like one that never
    // existed, so a stale link is not an existence probe.
    const replayed = await request.post(`${baseURL}/api/anon/${site.token}/keep`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    const unknown = await request.post(`${baseURL}/api/anon/${generateAnonToken()}/keep`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(replayed.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(await replayed.text()).toBe(await unknown.text());
  });
});
