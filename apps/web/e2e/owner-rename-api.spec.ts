import {
  MANIFEST_KV_CACHE_TTL_SECONDS,
  publishErrorSchema,
  renameResultSchema,
  studioErrorSchema,
  type StudioErrorCode,
} from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  pageHtml,
  probeEdge,
  publishViaApi,
  servingDomain,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `PATCH /api/sites/:id/slug` over the wire, against the REAL dev stack —
 * E06 task 005.
 *
 * NO MOCKS AND NO FIXTURE ROWS FOR THE PAGES THAT MATTER. A rename is the one
 * management verb that touches the edge, so a hand-inserted `sites` row with no
 * R2 object and no KV manifest would prove nothing about it. Every page here is
 * published through `POST /api/publish` for real and adopted through the real
 * `POST /api/anon/:token/keep`, so by the time a rename runs there is a genuine
 * pointer, a genuine KV manifest and a genuine cached response to move.
 *
 * WHAT THIS FILE IS FOR, that no unit drill can reach:
 *
 *   1. **The promise is true.** The new URL serves the same bytes immediately;
 *      the old URL stops serving within the window; `sites_slug_key` still
 *      holds; **R2 is untouched** — the object is keyed by `siteId`, so the
 *      same key answers before and after.
 *   2. **Every refusal applies nothing.** Collision, reserved label, profanity,
 *      shape-invalid and a non-`live` page each leave the row, the pointer and
 *      the served page exactly as they were. Asserted per case.
 *   3. **The session boundary and the origin gate**, on the wire.
 *
 * ⚠️ THE OLD URL DOES NOT 404 INSTANTLY AND THIS SPEC DOES NOT ASSERT THAT IT
 * DOES. `MANIFEST_KV_CACHE_TTL_SECONDS` is 60, already Cloudflare's floor, and
 * `purge_cache` does not reach the Worker's KV read cache — epic decision D2.
 * Measured on deployed dev on 2026-08-22 the old URL went dark **4 seconds**
 * after `removeManifest` on a page whose response had been a Cache API `HIT`
 * for 90 s; the bound below is the architecture's worst case, not that
 * observation, and the poll is what keeps this test honest rather than lucky.
 *
 * ⚠️ A RENAME IS FOUR PURGES. `writeManifest` and `removeManifest` each issue
 * one immediately and schedule a second at `2 × MANIFEST_KV_CACHE_TTL_SECONDS
 * + 5 s`. The two IMMEDIATE ones are observable here and are observed — both
 * URL forms of each slug, which is what `slugPurgeUrls` covers and why a purge
 * of `/` alone would leave `/index.html` stale for a year. The two DELAYED ones
 * fire inside the server process long after the response; their contract is
 * drilled directly in `lib/storage/manifest.test.ts` with a zero delay, which
 * is the only place it can be observed without a two-minute wait.
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

/**
 * How long the old URL may still answer, worst case: the delayed re-purge's own
 * deadline. Derived from the shared constant — never a literal — for the same
 * reason `lib/storage/manifest.ts` derives `KV_REPURGE_DELAY_MS` from it.
 */
const OLD_URL_WINDOW_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 5) * 1000;

/** A page URL, both forms — the two entries `slugPurgeUrls` covers. */
const urlsFor = (slug: string): string[] => [
  `https://${slug}.${servingDomain()}/`,
  `https://${slug}.${servingDomain()}/index.html`,
];

test.describe("owner rename", () => {
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
  async function signIn(baseURL: string): Promise<string> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replace(/-/g, "");
    const email = `e06-005-${token.slice(0, 8)}@kept-e06-005.invalid`;

    // The inbox, and only the inbox: `storeToken` defaults to "plain", so the
    // identifier IS the token `sendMagicLink` would have put in a URL.
    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E06-005 rename drill" }),
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

      return response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value.split(";", 1)[0])
        .join("; ");
    } finally {
      await requestCtx.dispose();
    }
  }

  interface OwnedPage {
    siteId: string;
    slug: string;
    versionId: string;
    html: string;
  }

  /**
   * A REAL kept page belonging to this session: published keyless, then adopted
   * through the real anonymous keep. Nothing about it is inserted by hand, so
   * the R2 object, the slug pointer, the KV manifest and the edge cache are all
   * genuinely present before a rename moves them.
   */
  async function ownedPage(
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
  ): Promise<OwnedPage> {
    const marker = `e06-005-${crypto.randomUUID().slice(0, 8)}`;
    const html = pageHtml(marker);
    const published = await publishViaApi(request, html, { "user-agent": marker });
    expect(published.status(), await published.text()).toBe(201);
    const body = (await published.json()) as { slug: string; anonToken: string };
    createdSlugs.add(body.slug);

    const kept = await request.post(`${baseURL}/api/anon/${body.anonToken}/keep`, {
      headers: sessionHeaders(cookie, baseURL),
    });
    expect(kept.status(), await kept.text()).toBe(200);

    const [row] = await db
      .select({ id: schema.sites.id, versionId: schema.sites.currentVersionId })
      .from(schema.sites)
      .where(eq(schema.sites.slug, body.slug));
    expect(row).toBeDefined();
    createdSiteIds.push(row!.id);

    return { siteId: row!.id, slug: body.slug, versionId: row!.versionId!, html };
  }

  const readSite = async (id: string) => {
    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(row, `site ${id} vanished`).toBeDefined();
    return row!;
  };

  const rename = (
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
    siteId: string,
    slug: string,
  ) =>
    request.patch(`${baseURL}/api/sites/${siteId}/slug`, {
      headers: sessionHeaders(cookie, baseURL),
      data: { slug },
    });

  /** Poll a URL until it stops serving, or until the architectural bound. */
  async function waitUntilGone(url: string): Promise<number> {
    const started = Date.now();
    for (;;) {
      const probe = await probeEdge(url);
      if (probe.status !== 200) return Date.now() - started;
      if (Date.now() - started > OLD_URL_WINDOW_MS) {
        throw new Error(
          `${url} still served 200 after ${Math.round(OLD_URL_WINDOW_MS / 1000)}s — past the delayed re-purge, which means a purge did not land.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  test("the new URL serves immediately, the old one stops, and R2 never moved", async ({
    request,
    baseURL,
  }) => {
    // The poll for the old URL is bounded by the architecture, not by the
    // measurement, so the budget has to cover the worst case plus a sign-in.
    test.setTimeout(LIVE_STACK_TIMEOUT + OLD_URL_WINDOW_MS + 30_000);

    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const objectKey = pageObjectKey(page.siteId, page.versionId);
    const objectBefore = await r2Store().get(objectKey);
    expect(objectBefore, "the published page object must exist before a rename").toBe(page.html);

    // Warm the old URL so the rename is moving a page the edge has actually
    // cached — the case the copy describes, not a slug one second old.
    expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);

    const nextSlug = `e06-005-renamed-${crypto.randomUUID().slice(0, 8)}`;
    createdSlugs.add(nextSlug);

    const response = await rename(request, baseURL!, cookie, page.siteId, nextSlug);
    expect(response.status(), await response.text()).toBe(200);
    const body = renameResultSchema.parse(await response.json());
    // The client `router.replace`s onto this; without it the next navigation
    // 404s on the user's own page.
    expect(body.slug).toBe(nextSlug);
    expect(body.previousSlug).toBe(page.slug);
    expect(body.liveUrl).toBe(`https://${nextSlug}.${servingDomain()}`);

    // Postgres moved.
    expect((await readSite(page.siteId)).slug).toBe(nextSlug);

    // The NEW slug serves the same bytes, in both URL forms, right away.
    for (const url of urlsFor(nextSlug)) {
      const probe = await probeEdge(url);
      expect(probe.status, `${url} must serve immediately`).toBe(200);
      expect(probe.body).toBe(page.html);
    }

    // The OLD slug stops — within the bound, and both forms. `/index.html` is a
    // separate cache entry from `/`, so a purge that covered one and not the
    // other would leave a year-long stale copy behind exactly here.
    for (const url of urlsFor(page.slug)) {
      const elapsed = await waitUntilGone(url);
      expect(elapsed).toBeLessThanOrEqual(OLD_URL_WINDOW_MS);
    }

    // THE POINTERS: the new slug has one, the old one does not. This is the KV
    // half made observable — `lib/storage/kv` may not be imported outside
    // `manifest.ts` (lint), and the pointer is written from the same bytes in
    // the same call, so its presence is the manifest's presence.
    expect(await r2Store().get(pointerKey(nextSlug))).not.toBeNull();
    expect(await r2Store().get(pointerKey(page.slug))).toBeNull();

    // R2 IS UNTOUCHED. Same key, same bytes: objects are keyed by `siteId`, so
    // a rename moves no object and creates no version.
    expect(await r2Store().get(objectKey)).toBe(page.html);
    const versions = await db
      .select({ id: schema.siteVersions.id })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, page.siteId));
    expect(versions).toHaveLength(1);
  });

  test("renaming a page to its own slug writes nothing", async ({ request, baseURL }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    // The pointer's bytes carry `updatedAt`, so identical bytes before and
    // after prove no manifest was written — and therefore that no purge was
    // spent on a change that did not happen.
    const pointerBefore = await r2Store().get(pointerKey(page.slug));
    const rowBefore = await readSite(page.siteId);

    const response = await rename(request, baseURL!, cookie, page.siteId, page.slug);
    expect(response.status(), await response.text()).toBe(200);
    const body = renameResultSchema.parse(await response.json());
    expect(body.slug).toBe(page.slug);
    expect(body.previousSlug).toBe(page.slug);

    expect(await r2Store().get(pointerKey(page.slug))).toBe(pointerBefore);
    expect(await readSite(page.siteId)).toEqual(rowBefore);
    expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);
  });

  test("collision, reserved, profanity and bad shape each change nothing", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const mine = await ownedPage(request, baseURL!, cookie);
    const theirs = await ownedPage(request, baseURL!, cookie);

    const cases: [string, string, number, StudioErrorCode][] = [
      // Taken — by the unique index, which is the only authority. 409 and
      // `name_taken`, never a 500.
      ["collision", theirs.slug, 409, "name_taken"],
      ["reserved", "dashboard", 400, "name_reserved"],
      ["reserved (E06's own route)", "settings", 400, "name_reserved"],
      ["profanity", "my-ass-page", 400, "name_inappropriate"],
      ["shape", "Not A Slug", 400, "name_invalid"],
      ["shape (doubled hyphen)", "two--hyphens", 400, "name_invalid"],
    ];

    for (const [label, slug, status, code] of cases) {
      const rowBefore = await readSite(mine.siteId);
      const pointerBefore = await r2Store().get(pointerKey(mine.slug));

      const response = await rename(request, baseURL!, cookie, mine.siteId, slug);
      expect(response.status(), `${label}: ${await response.text()}`).toBe(status);
      expect(studioErrorSchema.parse(await response.json()).error.code, label).toBe(code);

      // NOTHING APPLIED — asserted per case, not once. The whole row, the
      // pointer, and the page still serving under its old name.
      expect(await readSite(mine.siteId), label).toEqual(rowBefore);
      expect(await r2Store().get(pointerKey(mine.slug)), label).toBe(pointerBefore);
      expect((await probeEdge(urlsFor(mine.slug)[0]!)).status, label).toBe(200);
      // …and no pointer was minted at the name that was refused.
      if (slug !== theirs.slug) {
        expect(await r2Store().get(pointerKey(slug)), label).toBeNull();
      }
    }

    // `sites_slug_key` still holds: the other page kept its slug and exactly
    // one row claims it.
    const rows = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, theirs.slug));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(theirs.siteId);
  });

  test("a page under review refuses the rename and keeps its address", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    // E06 RENDERS these states and writes none of them, so the fixture sets it
    // directly — there is no product path that could.
    await db
      .update(schema.sites)
      .set({ status: "quarantined" })
      .where(eq(schema.sites.id, page.siteId));

    const rowBefore = await readSite(page.siteId);
    const response = await rename(
      request,
      baseURL!,
      cookie,
      page.siteId,
      `e06-005-flagged-${crypto.randomUUID().slice(0, 8)}`,
    );
    expect(response.status()).toBe(409);
    const { error } = studioErrorSchema.parse(await response.json());
    expect(error.code).toBe("not_allowed_in_status");
    // An explanation, not a bare refusal: moving a flagged page to a fresh URL
    // is the evasion the flag exists to stop, and the owner deserves to know
    // that is what happened.
    expect(error.message.toLowerCase()).toContain("review");
    expect(await readSite(page.siteId)).toEqual(rowBefore);
  });

  test("signed out is 401, another account's page is the not-found body", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const mine = await ownedPage(request, baseURL!, cookie);

    const signedOut = await request.patch(`${baseURL}/api/sites/${mine.siteId}/slug`, {
      data: { slug: "e06-005-signed-out" },
    });
    expect(signedOut.status(), "the gate must hold before any database work").toBe(401);
    studioErrorSchema.parse(await signedOut.json());
    expect((await readSite(mine.siteId)).slug).toBe(mine.slug);

    // A second account, from this account's session.
    const otherCookie = await signIn(baseURL!);
    const theirs = await ownedPage(request, baseURL!, otherCookie);

    const refused = await rename(
      request,
      baseURL!,
      cookie,
      theirs.siteId,
      `e06-005-stolen-${crypto.randomUUID().slice(0, 8)}`,
    );
    const absent = await rename(
      request,
      baseURL!,
      cookie,
      crypto.randomUUID(),
      `e06-005-absent-${crypto.randomUUID().slice(0, 8)}`,
    );
    expect(refused.status()).toBe(404);
    expect(absent.status()).toBe(404);
    // Byte-identical: "not yours" must not be an existence oracle.
    expect(await refused.text()).toBe(await absent.text());
    expect(studioErrorSchema.parse(await refused.json()).error.code).toBe("not_found");
    expect((await readSite(theirs.siteId)).slug).toBe(theirs.slug);
  });

  test("a rename from a hosted page's origin is refused and moves nothing", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const rowBefore = await readSite(page.siteId);
    const nextSlug = `e06-005-csrf-${crypto.randomUUID().slice(0, 8)}`;

    const refused = await request.patch(`${baseURL}/api/sites/${page.siteId}/slug`, {
      // A REAL session cookie carrying a HOSTED page's origin: same-site, so
      // `SameSite=Lax` does not block it and `__Host-` does nothing about it.
      // A script on a page kept hosts renaming its publisher's other pages is
      // exactly the attack E05a exists for — and a rename is the worst verb to
      // lose, because the permanent link is the product.
      headers: { cookie, origin: `https://${page.slug}.${servingDomain()}` },
      data: { slug: nextSlug },
    });

    expect(refused.status()).toBe(403);
    // E05a's flat body, untouched — the gate runs before any studio code.
    expect(publishErrorSchema.parse(await refused.json()).error).toBe("invalid_request");
    expect(await readSite(page.siteId)).toEqual(rowBefore);
    expect(await r2Store().get(pointerKey(nextSlug))).toBeNull();
    expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);
  });
});
