import {
  limitsFor,
  MAX_PAGE_BYTES,
  ownedPublishResultSchema,
  publishErrorSchema,
} from "@kept/shared";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { pageHtml, probeEdge, servingDomain, SKIP_LIVE_PUBLISH } from "./live-publish";
import { seedKept } from "./owner-fixtures";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `POST /api/sites` over the wire, against the REAL dev stack — E06 task 004,
 * epic decision **D1**.
 *
 * NO MOCKS. Every page an assertion is about is published through the real
 * endpoint by a real session minted through the real magic-link verify, so each
 * assertion is made against a genuine row, a genuine R2 object, a genuine KV
 * manifest and a genuinely served page. The slots that merely FILL an account
 * to its kept limit are real rows seeded by direct insert (`seedKept`): the cap
 * counts them exactly as it counts a publish, and publishing
 * `limitsFor("free").keptPages` pages per test would cost minutes of R2/KV
 * traffic for no extra proof.
 *
 * WHAT THIS FILE IS FOR, that no unit drill can reach:
 *
 *   1. **Owned from the first byte.** `owner_id` set, `claimed_at` stamped, and
 *      — the assertion this route exists for — **`anon_token_hash` NULL on the
 *      row**, read out of the database rather than inferred from the response.
 *      A signed-in publish that minted a bearer token would put two authorities
 *      on one page, which is the exact shape D1 rejects.
 *   2. **The cap degrades, it never errors.** At the plan's kept limit the page
 *      still lands — owned, serving, with both clocks set — at HTTP **200**.
 *      There is no 4xx for being full and there must never be one.
 *   3. **Two tabs cannot exceed the cap.** Two publishes fired concurrently one
 *      slot short of the limit produce exactly one `kept` and one
 *      `owned_draft`, proven by RACING REAL REQUESTS rather than by reading the
 *      transaction that is supposed to prevent it.
 *   4. **Every refusal creates nothing** — signed out, cross-origin, empty and
 *      oversized bodies all leave the account with the pages it had.
 *
 * SKIPS without dev credentials: CI runs on fork PRs with no secrets.
 */
config({ path: ".env.local", quiet: true });

const authMissing = ["BETTER_AUTH_SECRET"].filter((name) => !process.env[name]?.trim());

const SKIP: string | false =
  SKIP_LIVE_PUBLISH ||
  (authMissing.length > 0
    ? `auth credentials absent (${authMissing.join(", ")}) — run locally with apps/web/.env.local`
    : false);

/** A freshly minted slug is cold everywhere, so the only wait is the purge. */
const SERVE_TIMEOUT_MS = 30_000;
const SERVE_INTERVAL_MS = 1_000;

const urlFor = (slug: string): string => `https://${slug}.${servingDomain()}/`;

/** The cap every drill account (`free`, as every new account is) is held to. */
const FREE_LIMIT = limitsFor("free").keptPages;

test.describe("owned publish", () => {
  test.skip(!!SKIP, SKIP || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  const createdUserIds: string[] = [];
  const createdSiteIds: string[] = [];
  const createdSlugs = new Set<string>();

  test.beforeAll(async () => {
    if (SKIP) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP) return;
    const { removeManifest } = await import("../lib/storage/manifest");
    for (const slug of createdSlugs) {
      await removeManifest(slug).catch(() => undefined);
    }
    for (const id of createdSiteIds) {
      const versions = await db
        .select({ id: schema.siteVersions.id })
        .from(schema.siteVersions)
        .where(eq(schema.siteVersions.siteId, id));
      for (const version of versions) {
        await r2Store()
          .delete(pageObjectKey(id, version.id))
          .catch(() => undefined);
      }
    }
    if (createdSiteIds.length) {
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (createdUserIds.length) {
      await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
    }
    await closeDb();
  });

  /** A real session cookie, minted through the real magic-link verify endpoint. */
  async function signIn(baseURL: string): Promise<{ cookie: string; profileId: string }> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replace(/-/g, "");
    const email = `e06-004-${token.slice(0, 8)}@kept-e06-004.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E06-004 publish drill" }),
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

      // `profiles.id` IS the auth user id (E05 D1) — no second lookup needed.
      return { cookie, profileId: body.user.id };
    } finally {
      await requestCtx.dispose();
    }
  }

  const publish = (
    request: APIRequestContext,
    baseURL: string,
    cookie: string,
    html: string,
  ) =>
    request.post(`${baseURL}/api/sites`, {
      headers: sessionHeaders(cookie, baseURL),
      data: { html },
    });

  /** Publish and parse through the shared schema, recording the row for teardown. */
  async function publishOk(
    request: APIRequestContext,
    baseURL: string,
    cookie: string,
    marker: string,
  ) {
    const html = pageHtml(marker);
    const response = await publish(request, baseURL, cookie, html);
    expect(response.status(), await response.text()).toBe(200);
    const body = ownedPublishResultSchema.parse(await response.json());
    createdSiteIds.push(body.siteId);
    createdSlugs.add(body.slug);
    return { body, html };
  }

  const readSite = async (id: string) => {
    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(row, `site ${id} vanished`).toBeDefined();
    return row!;
  };

  /** The kept-ness predicate, as the enforcer counts it. Never a second spelling. */
  const countKept = async (profileId: string): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sites)
      .where(
        and(
          eq(schema.sites.ownerId, profileId),
          isNull(schema.sites.expiresAt),
          eq(schema.sites.status, "live"),
        ),
      );
    return row?.count ?? 0;
  };

  const countOwned = async (profileId: string): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sites)
      .where(eq(schema.sites.ownerId, profileId));
    return row?.count ?? 0;
  };

  /** Poll a freshly minted URL until it serves. */
  async function waitForServe(url: string) {
    const deadline = Date.now() + SERVE_TIMEOUT_MS;
    let last = await probeEdge(url);
    while (last.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SERVE_INTERVAL_MS));
      last = await probeEdge(url);
    }
    return last;
  }

  test("under the cap: the page is kept, owned, tokenless — and it serves", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const marker = `e06-004-${crypto.randomUUID().slice(0, 8)}`;
    const { body, html } = await publishOk(request, baseURL!, cookie, marker);

    expect(body.outcome).toBe("kept");
    expect(body.liveUrl).toBe(`https://${body.slug}.${servingDomain()}`);
    // `pageHtml` puts the marker in `<title>`, so the card gets a human name.
    expect(body.title).toBe(marker);
    // The quota reflects the state AFTER this publish, so the dashboard repaints
    // from the response without a refetch.
    expect(body.quota.limit).toBe(FREE_LIMIT);
    expect(body.quota.used).toBe(1);
    expect(body.quota.remaining).toBe(FREE_LIMIT - 1);

    const row = await readSite(body.siteId);
    expect(row.ownerId).toBe(profileId);
    // THE ASSERTION THIS FILE EXISTS FOR, read off the ROW rather than the
    // response: a signed-in publish mints no bearer credential, ever. Two
    // authorities on one page is the bug D1 is written against.
    expect(row.anonTokenHash).toBeNull();
    // …and `publisher_hash` IS recorded: an owned publish is still a publish,
    // and E07's volume governors key on that column.
    expect(row.publisherHash).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();
    expect(row.expiresAt, "kept pages carry no clock").toBeNull();
    expect(row.purgeAfter).toBeNull();
    expect(row.status).toBe("live");
    expect(row.title).toBe(marker);

    // R2 is keyed by siteId, never by slug.
    expect(await r2Store().get(pageObjectKey(body.siteId, row.currentVersionId!))).toBe(html);

    const served = await waitForServe(urlFor(body.slug));
    expect(served.status).toBe(200);
    expect(served.body).toBe(html);
  });

  test("at the cap: the page lands as an owned draft at HTTP 200, never a 4xx", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);

    // Fill the account to its limit: real kept rows, seeded rather than published.
    await seedKept({ siteIds: createdSiteIds }, profileId, FREE_LIMIT);
    expect(await countKept(profileId)).toBe(FREE_LIMIT);

    const marker = `e06-004-atcap-${crypto.randomUUID().slice(0, 8)}`;
    const { body, html } = await publishOk(request, baseURL!, cookie, marker);

    // THE CAP IS A BRANCH, NOT AN ERROR. `publishOk` already asserted 200.
    expect(body.outcome).toBe("owned_draft");
    expect(body.quota.limit).toBe(FREE_LIMIT);
    expect(body.quota.used).toBe(FREE_LIMIT);
    expect(body.quota.remaining).toBe(0);

    const row = await readSite(body.siteId);
    expect(row.ownerId, "the page is OWNED, it just has a clock").toBe(profileId);
    expect(row.anonTokenHash, "still no bearer token, even at the cap").toBeNull();
    expect(row.expiresAt).not.toBeNull();
    expect(row.purgeAfter).not.toBeNull();
    // The response's clocks are the row's, not a second computation.
    const draft = body.outcome === "owned_draft" ? body : null;
    expect(draft, "the page past the cap must carry the draft branch").not.toBeNull();
    expect(draft!.expiresAt).toBe(row.expiresAt!.toISOString());
    expect(draft!.purgeAfter).toBe(row.purgeAfter!.toISOString());

    // A draft is `live` and serves exactly like a kept page — the clock is the
    // only difference, and the edge knows nothing about it.
    const served = await waitForServe(urlFor(body.slug));
    expect(served.status).toBe(200);
    expect(served.body).toBe(html);

    // The cap did not move, and the page was not lost.
    expect(await countKept(profileId)).toBe(FREE_LIMIT);
    expect(await countOwned(profileId)).toBe(FREE_LIMIT + 1);
  });

  test("two concurrent publishes one slot short produce exactly one kept page", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);

    // One slot short of the cap — seeded, so the race is the only thing published.
    await seedKept({ siteIds: createdSiteIds }, profileId, FREE_LIMIT - 1);
    expect(await countKept(profileId)).toBe(FREE_LIMIT - 1);

    // FIRED CONCURRENTLY, not sequentially. This is the whole test: a cap read
    // outside the insert's transaction lets both of these see the same count and
    // both land kept, producing one page more than the account may hold.
    const [first, second] = await Promise.all([
      publish(request, baseURL!, cookie, pageHtml(`e06-004-race-a-${crypto.randomUUID().slice(0, 8)}`)),
      publish(request, baseURL!, cookie, pageHtml(`e06-004-race-b-${crypto.randomUUID().slice(0, 8)}`)),
    ]);

    expect(first.status(), await first.text()).toBe(200);
    expect(second.status(), await second.text()).toBe(200);
    const bodies = [
      ownedPublishResultSchema.parse(await first.json()),
      ownedPublishResultSchema.parse(await second.json()),
    ];
    for (const body of bodies) {
      createdSiteIds.push(body.siteId);
      createdSlugs.add(body.slug);
    }

    const outcomes = bodies.map((body) => body.outcome).sort();
    expect(outcomes, "exactly one of the two may take the last slot").toEqual([
      "kept",
      "owned_draft",
    ]);
    // Both slugs are distinct pages: neither request was lost or deduped.
    expect(bodies[0]!.siteId).not.toBe(bodies[1]!.siteId);
    expect(bodies[0]!.slug).not.toBe(bodies[1]!.slug);

    // And the database agrees with the responses.
    expect(await countKept(profileId)).toBe(FREE_LIMIT);
    expect(await countOwned(profileId)).toBe(FREE_LIMIT + 1);
  });

  test("signed out is 401 and publishes nothing", async ({ request, baseURL }) => {
    const marker = `e06-004-signed-out-${crypto.randomUUID().slice(0, 8)}`;
    const response = await request.post(`${baseURL}/api/sites`, {
      data: { html: pageHtml(marker) },
    });

    expect(response.status(), "the gate must hold before any store work").toBe(401);
    publishErrorSchema.parse(await response.json());

    // No row exists carrying those bytes. Titles are extracted at write time, so
    // a page that was published despite the 401 would be findable by its name.
    const rows = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.title, marker));
    expect(rows, "a refused publish creates no page").toHaveLength(0);
  });

  test("a publish from a hosted page's origin is refused and creates nothing", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const seed = await publishOk(
      request,
      baseURL!,
      cookie,
      `e06-004-csrf-seed-${crypto.randomUUID().slice(0, 8)}`,
    );

    const marker = `e06-004-csrf-${crypto.randomUUID().slice(0, 8)}`;
    const refused = await request.post(`${baseURL}/api/sites`, {
      // A REAL session cookie carrying a HOSTED page's origin: same-site, so
      // `SameSite=Lax` does not block it. A script on a page kept hosts filling
      // its visitor's account — and, at the cap, silently spending the slot they
      // were saving — is exactly the attack E05a exists for.
      headers: { cookie, origin: `https://${seed.body.slug}.${servingDomain()}` },
      data: { html: pageHtml(marker) },
    });

    expect(refused.status()).toBe(403);
    expect(publishErrorSchema.parse(await refused.json()).error).toBe("invalid_request");
    expect(await countOwned(profileId), "the account gained no page").toBe(1);
  });

  test("an empty and an oversized body are both refused, and nothing is created", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);

    const empty = await publish(request, baseURL!, cookie, "");
    expect(empty.status()).toBe(400);
    expect(publishErrorSchema.parse(await empty.json()).error).toBe("empty_page");

    // One byte past `MAX_PAGE_BYTES`, from the shared constant — the same limit
    // the keyless path enforces, reached through the same schema.
    const oversized = await publish(
      request,
      baseURL!,
      cookie,
      `<!doctype html><title>x</title>${"a".repeat(MAX_PAGE_BYTES)}`,
    );
    expect(oversized.status()).toBe(413);
    expect(publishErrorSchema.parse(await oversized.json()).error).toBe("page_too_large");

    expect(await countOwned(profileId)).toBe(0);
  });
});
