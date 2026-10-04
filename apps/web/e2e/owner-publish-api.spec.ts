import {
  limitsFor,
  MAX_PAGE_BYTES,
  ownedPublishResultSchema,
  publishErrorSchema,
  studioErrorSchema,
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
 * `POST /api/sites` over the wire, against the REAL dev stack — decision **D9**,
 * acceptance criteria **2** (route half), **8** and **44** (this route).
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
 *   2. **The cap degrades, it never errors (AC2).** With one slot left the page
 *      lands kept at **201**; the next lands as an owned draft — serving, both
 *      clocks set — at **201** too. There is no 4xx for being full.
 *   3. **Two tabs cannot exceed the cap.** Two DIFFERENT publishes fired
 *      concurrently one slot short of the limit produce exactly one kept page
 *      and one owned draft, proven by RACING REAL REQUESTS.
 *   4. **The same bytes are one page (AC8).** Published twice — one after the
 *      other, or racing — the account gets ONE page, and the second answer is
 *      `200 { site, duplicate: true }` pointing at it.
 *   5. **Every refusal creates nothing** — signed out (401), cross-origin (E05a's
 *      flat 403, AC44), empty and oversized bodies (the studio envelope's
 *      `invalid_file` / `file_too_large`) all leave the account as it was.
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

  /** Parse a success through the shared schema, recording the page for teardown. */
  async function parsed(response: Awaited<ReturnType<typeof publish>>) {
    const body = ownedPublishResultSchema.parse(await response.json());
    if (!createdSiteIds.includes(body.site.id)) createdSiteIds.push(body.site.id);
    createdSlugs.add(body.site.slug);
    return body;
  }

  /** Publish a NEW page: 201, whichever side of the cap it lands on. */
  async function publishOk(
    request: APIRequestContext,
    baseURL: string,
    cookie: string,
    marker: string,
  ) {
    const html = pageHtml(marker);
    const response = await publish(request, baseURL, cookie, html);
    expect(response.status(), await response.text()).toBe(201);
    const body = await parsed(response);
    expect(body.duplicate, "a new page is not a duplicate").toBeUndefined();
    return { site: body.site, html };
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

  test("under the cap: 201, the page is kept, owned, tokenless, studio — and it serves", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const marker = `e06-005-${crypto.randomUUID().slice(0, 8)}`;
    const { site, html } = await publishOk(request, baseURL!, cookie, marker);

    expect(site.expiresAt, "under the cap the page is kept: no clock").toBeNull();
    expect(site.purgeAfter).toBeNull();
    expect(site.status).toBe("live");
    expect(site.liveUrl).toBe(`https://${site.slug}.${servingDomain()}`);
    // `pageHtml` puts the marker in `<title>`, so the card gets a human name.
    expect(site.title).toBe(marker);

    const row = await readSite(site.id);
    expect(site.updatedAt, "the answer is the row, read back").toBe(row.updatedAt.toISOString());
    expect(row.ownerId).toBe(profileId);
    // THE ASSERTION THIS FILE EXISTS FOR, read off the ROW rather than the
    // response: a signed-in publish mints no bearer credential, ever. Two
    // authorities on one page is the bug D9 is written against.
    expect(row.anonTokenHash).toBeNull();
    // …and `publisher_hash` IS recorded: an owned publish is still a publish,
    // and E07's volume governors key on that column.
    expect(row.publisherHash).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();
    expect(row.expiresAt, "kept pages carry no clock").toBeNull();
    expect(row.purgeAfter).toBeNull();
    expect(row.status).toBe("live");
    expect(row.title).toBe(marker);

    // §5.9: the version records the studio door.
    const [version] = await db
      .select({ publishedVia: schema.siteVersions.publishedVia })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.id, row.currentVersionId!));
    expect(version?.publishedVia).toBe("studio");

    // R2 is keyed by siteId, never by slug.
    expect(await r2Store().get(pageObjectKey(site.id, row.currentVersionId!))).toBe(html);

    const served = await waitForServe(urlFor(site.slug));
    expect(served.status).toBe(200);
    expect(served.body).toBe(html);
  });

  test("AC2: one slot left, the next publish is 201 kept and the one after is 201 owned draft — never a 4xx", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);

    // Fill the account to one short of its limit: real kept rows, seeded rather
    // than published.
    await seedKept({ siteIds: createdSiteIds }, profileId, FREE_LIMIT - 1);
    expect(await countKept(profileId)).toBe(FREE_LIMIT - 1);

    const last = await publishOk(request, baseURL!, cookie, `e06-005-last-${crypto.randomUUID().slice(0, 8)}`);
    expect(last.site.expiresAt, "the last slot is a kept page").toBeNull();
    expect(await countKept(profileId)).toBe(FREE_LIMIT);

    const marker = `e06-005-atcap-${crypto.randomUUID().slice(0, 8)}`;
    const { site, html } = await publishOk(request, baseURL!, cookie, marker);

    // THE CAP IS A BRANCH, NOT AN ERROR. `publishOk` already asserted 201.
    expect(site.expiresAt, "past the limit the page lands as a draft").not.toBeNull();
    expect(site.purgeAfter).not.toBeNull();

    const row = await readSite(site.id);
    expect(row.ownerId, "the page is OWNED, it just has a clock").toBe(profileId);
    expect(row.anonTokenHash, "still no bearer token, even at the cap").toBeNull();
    // The response's clocks are the row's, not a second computation.
    expect(site.expiresAt).toBe(row.expiresAt!.toISOString());
    expect(site.purgeAfter).toBe(row.purgeAfter!.toISOString());

    // A draft is `live` and serves exactly like a kept page — the clock is the
    // only difference, and the edge knows nothing about it.
    const served = await waitForServe(urlFor(site.slug));
    expect(served.status).toBe(200);
    expect(served.body).toBe(html);

    // The cap did not move, and the page was not lost.
    expect(await countKept(profileId)).toBe(FREE_LIMIT);
    expect(await countOwned(profileId)).toBe(FREE_LIMIT + 1);
  });

  test("two different publishes racing one slot short produce exactly one kept page", async ({
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
      publish(request, baseURL!, cookie, pageHtml(`e06-005-race-a-${crypto.randomUUID().slice(0, 8)}`)),
      publish(request, baseURL!, cookie, pageHtml(`e06-005-race-b-${crypto.randomUUID().slice(0, 8)}`)),
    ]);

    expect(first.status(), await first.text()).toBe(201);
    expect(second.status(), await second.text()).toBe(201);
    const bodies = [await parsed(first), await parsed(second)];

    const branches = bodies.map((body) => (body.site.expiresAt === null ? "kept" : "draft")).sort();
    expect(branches, "exactly one of the two may take the last slot").toEqual(["draft", "kept"]);
    // Different bytes are different pages: neither request was lost or deduped.
    expect(bodies[0]!.site.id).not.toBe(bodies[1]!.site.id);
    expect(bodies[0]!.site.slug).not.toBe(bodies[1]!.site.slug);

    // And the database agrees with the responses.
    expect(await countKept(profileId)).toBe(FREE_LIMIT);
    expect(await countOwned(profileId)).toBe(FREE_LIMIT + 1);
  });

  test("AC8: the same bytes twice are one page — the second answer is 200 { site, duplicate: true }", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const { site, html } = await publishOk(
      request,
      baseURL!,
      cookie,
      `e06-005-dup-${crypto.randomUUID().slice(0, 8)}`,
    );

    const again = await publish(request, baseURL!, cookie, html);
    expect(again.status(), await again.text()).toBe(200);
    const body = await parsed(again);
    expect(body.duplicate).toBe(true);
    expect(body.site, "the answer points at the FIRST page, as it stands").toEqual(site);
    expect(await countOwned(profileId), "no second page was made").toBe(1);
  });

  test("AC8: two identical publishes racing converge on one page", async ({ request, baseURL }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const html = pageHtml(`e06-005-dup-race-${crypto.randomUUID().slice(0, 8)}`);

    // The probe runs INSIDE the owner lock, so the second request waits for the
    // first to commit and then finds its row — never two pages.
    const responses = await Promise.all([
      publish(request, baseURL!, cookie, html),
      publish(request, baseURL!, cookie, html),
    ]);

    expect(responses.map((response) => response.status()).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map(parsed));
    expect(bodies[0]!.site.id).toBe(bodies[1]!.site.id);
    expect(bodies.filter((body) => body.duplicate === true)).toHaveLength(1);
    expect(await countOwned(profileId)).toBe(1);
  });

  test("signed out is 401 in the studio envelope and publishes nothing", async ({
    request,
    baseURL,
  }) => {
    const marker = `e06-005-signed-out-${crypto.randomUUID().slice(0, 8)}`;
    const response = await request.post(`${baseURL}/api/sites`, {
      data: { html: pageHtml(marker) },
    });

    expect(response.status(), "the gate must hold before any store work").toBe(401);
    studioErrorSchema.parse(await response.json());

    // No row exists carrying those bytes. Titles are extracted at write time, so
    // a page that was published despite the 401 would be findable by its name.
    const rows = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.title, marker));
    expect(rows, "a refused publish creates no page").toHaveLength(0);
  });

  test("AC44: a publish from a hosted page's origin is refused with E05a's own body and creates nothing", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);
    const seed = await publishOk(
      request,
      baseURL!,
      cookie,
      `e06-005-csrf-seed-${crypto.randomUUID().slice(0, 8)}`,
    );

    const marker = `e06-005-csrf-${crypto.randomUUID().slice(0, 8)}`;
    const refused = await request.post(`${baseURL}/api/sites`, {
      // A REAL session cookie carrying a HOSTED page's origin: same-site, so
      // `SameSite=Lax` does not block it. A script on a page kept hosts filling
      // its visitor's account — and, at the cap, silently spending the slot they
      // were saving — is exactly the attack E05a exists for.
      headers: { cookie, origin: `https://${seed.site.slug}.${servingDomain()}` },
      data: { html: pageHtml(marker) },
    });

    expect(refused.status()).toBe(403);
    // E05a's FLAT body, deliberately not the studio envelope: the gate runs
    // before any route code and is pinned by `origin.test.ts`.
    expect(publishErrorSchema.parse(await refused.json()).error).toBe("invalid_request");
    expect(await countOwned(profileId), "the account gained no page").toBe(1);
  });

  test("an empty and an oversized body are refused in the envelope, and nothing is created", async ({
    request,
    baseURL,
  }) => {
    const { cookie, profileId } = await signIn(baseURL!);

    const empty = await publish(request, baseURL!, cookie, "");
    expect(empty.status()).toBe(400);
    expect(studioErrorSchema.parse(await empty.json()).error.code).toBe("invalid_file");

    // One byte past `MAX_PAGE_BYTES`, from the shared constant — the same limit
    // the keyless path enforces, reached through the same schema.
    const oversized = await publish(
      request,
      baseURL!,
      cookie,
      `<!doctype html><title>x</title>${"a".repeat(MAX_PAGE_BYTES)}`,
    );
    expect(oversized.status()).toBe(413);
    expect(studioErrorSchema.parse(await oversized.json()).error.code).toBe("file_too_large");

    expect(await countOwned(profileId)).toBe(0);
  });
});
