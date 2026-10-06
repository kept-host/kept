import {
  MAX_PAGE_BYTES,
  limitsFor,
  publishErrorSchema,
  replaceResultSchema,
  studioErrorSchema,
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
  STALE_EDGE_WINDOW_MS,
  waitForBytes,
} from "./live-publish";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `POST /api/sites/:id/replace` over the wire, against the REAL dev stack —
 * E06 task 006, reworked for versions (D7) in task 007.
 *
 * NO MOCKS AND NO FIXTURE ROWS. Every page here is published through
 * `POST /api/publish` for real and adopted through the real
 * `POST /api/anon/:token/keep`, so by the time a replace runs there is a genuine
 * R2 object, a genuine slug pointer, a genuine KV manifest and a genuine cached
 * response to overwrite. A hand-inserted row would prove nothing about any of
 * them.
 *
 * WHAT THIS FILE IS FOR, that no unit drill can reach:
 *
 *   1. **In place.** Same slug, same URL, same `siteId` — new bytes served after
 *      the purge, a NEW `site_versions` row, the PREVIOUS version's object still
 *      in R2, and its id in the response for the Undo toast (AC25).
 *   2. **Identical bytes are a no-op** (AC27): `{ unchanged: true }`, no row, no
 *      manifest write.
 *   3. **Pruning** (AC26): on free, the plan's `previousVersions` survive and a
 *      pruned version's object is gone — asserted with `get → null`, because
 *      `R2Store` has no `list` by design (contract §7.5; epic Risk 10).
 *   4. **The clock is untouched.** Asserted on a kept page (`expires_at` stays
 *      null) *and* on an owned draft (`expires_at`/`purge_after` byte-identical
 *      before and after). A replace that extended the draft window would let a
 *      weekly upload hold a page forever for free — it breaks the business
 *      model, not a test.
 *   5. **The title follows the bytes.** A replacement carrying a different
 *      `<title>` renames the card. A title populated on publish but not on
 *      replace is worse than none at all: the wall would confidently show the
 *      previous page's name.
 *   6. **Every refusal applies nothing** — a page under review, an empty body, an
 *      oversized body, another account's page, a signed-out call and a
 *      cross-origin one all leave the row and the served bytes exactly as they
 *      were.
 *
 * ⚠️ THE OLD BYTES DO NOT VANISH FROM THE EDGE INSTANTLY, AND THIS SPEC DOES NOT
 * ASSERT THAT THEY DO. `waitForBytes` polls up to `STALE_EDGE_WINDOW_MS` — the
 * delayed re-purge's deadline — rather than trusting a lucky measurement.
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

const urlFor = (slug: string): string => `https://${slug}.${servingDomain()}/`;

test.describe("owner replace", () => {
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
    const email = `e06-006r-${token.slice(0, 8)}@kept-e06-006.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E06-006 replace drill" }),
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
    marker: string;
  }

  /** A REAL kept page belonging to this session: published keyless, then adopted. */
  async function ownedPage(
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
  ): Promise<OwnedPage> {
    const marker = `e06-006r-${crypto.randomUUID().slice(0, 8)}`;
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

    return { siteId: row!.id, slug: body.slug, versionId: row!.versionId!, html, marker };
  }

  const readSite = async (id: string) => {
    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(row, `site ${id} vanished`).toBeDefined();
    return row!;
  };

  const replace = (
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
    siteId: string,
    html: string,
  ) =>
    request.post(`${baseURL}/api/sites/${siteId}/replace`, {
      headers: sessionHeaders(cookie, baseURL),
      data: { html },
    });

  /** A 200 replace body that must be a NEW version — narrowed, or the test fails. */
  const newVersion = (json: unknown) => {
    const body = replaceResultSchema.parse(json);
    if (body.unchanged) throw new Error("expected a new version, got { unchanged: true }");
    return body;
  };

  const versionRows = (siteId: string) =>
    db
      .select({ id: schema.siteVersions.id, r2Key: schema.siteVersions.r2Key })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, siteId));

  test("same URL, new bytes, a new version, the old one retained and named for Undo — and no clock appears", async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + STALE_EDGE_WINDOW_MS + 30_000);

    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const firstKey = pageObjectKey(page.siteId, page.versionId);

    // Warm the URL so the replace is overwriting a page the edge has actually
    // cached — `LIVE_CACHE_CONTROL` is a year, so without the purge this is the
    // product's most visible bug: "I re-dropped my file and nothing changed".
    expect((await probeEdge(urlFor(page.slug))).status).toBe(200);
    const pointerBefore = await r2Store().get(pointerKey(page.slug));
    const rowBefore = await readSite(page.siteId);

    const nextMarker = `${page.marker}-v2`;
    const nextHtml = pageHtml(nextMarker);
    const response = await replace(request, baseURL!, cookie, page.siteId, nextHtml);

    expect(response.status(), await response.text()).toBe(200);
    const body = newVersion(await response.json());
    expect(body.siteId).toBe(page.siteId);
    expect(body.slug, "a replace keeps the URL — that is the whole point").toBe(page.slug);
    expect(body.liveUrl).toBe(`https://${page.slug}.${servingDomain()}`);
    expect(body.versionId).not.toBe(page.versionId);
    // What the Undo toast restores (AC25), and nothing was pruned: one previous
    // version is exactly what free keeps.
    expect(body.previousVersionId).toBe(page.versionId);
    expect(body.pruned).toBe(false);
    // The title follows the bytes. `pageHtml` puts the marker in `<title>`.
    expect(body.title).toBe(nextMarker);
    expect(body.expiresAt, "a kept page has no clock, before or after").toBeNull();

    const row = await readSite(page.siteId);
    expect(row.slug).toBe(page.slug);
    expect(row.currentVersionId).toBe(body.versionId);
    expect(row.title).toBe(nextMarker);
    expect(row.status).toBe("live");
    expect(row.expiresAt).toBeNull();
    expect(row.purgeAfter).toBeNull();
    // The OG card's cache key (bug 4).
    expect(row.updatedAt.getTime()).toBeGreaterThan(rowBefore.updatedAt.getTime());

    // A NEW version row, and the previous one STILL THERE.
    const versions = await versionRows(page.siteId);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.id)).toContain(page.versionId);

    // R2: a new object under the SAME siteId, and the previous object untouched.
    // The layout is `sites/{siteId}/{versionId}/index.html` — keyed by id, never
    // by slug — so nothing moved and nothing was overwritten in place.
    expect(await r2Store().get(pageObjectKey(page.siteId, body.versionId))).toBe(nextHtml);
    expect(
      await r2Store().get(firstKey),
      "the previous version's bytes are retained for Undo",
    ).toBe(page.html);

    // THE MANIFEST WAS REWRITTEN FOR THE SAME SLUG, not moved to a new one. The
    // pointer's bytes carry the version id, so a changed pointer under an
    // unchanged key is exactly what a replace is meant to look like.
    const pointerAfter = await r2Store().get(pointerKey(page.slug));
    expect(pointerAfter).not.toBeNull();
    expect(pointerAfter).not.toBe(pointerBefore);
    expect(pointerAfter).toContain(body.versionId);

    // And the edge catches up within the architectural bound.
    const elapsed = await waitForBytes(urlFor(page.slug), nextHtml);
    expect(elapsed).toBeLessThanOrEqual(STALE_EDGE_WINDOW_MS);
  });

  test("the bytes already served are { unchanged: true }: no version, no manifest write (AC27)", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const before = await readSite(page.siteId);
    // The pointer carries `updatedAt: Date.now()`, so ANY manifest write would
    // change its bytes, even for the same version.
    const pointerBefore = await r2Store().get(pointerKey(page.slug));

    const response = await replace(request, baseURL!, cookie, page.siteId, page.html);

    expect(response.status(), await response.text()).toBe(200);
    expect(replaceResultSchema.parse(await response.json())).toEqual({ unchanged: true });
    expect(await readSite(page.siteId), "no column moved — not even updated_at").toEqual(before);
    expect(await versionRows(page.siteId), "no version row").toHaveLength(1);
    expect(await r2Store().get(pointerKey(page.slug)), "no manifest write").toBe(pointerBefore);
  });

  test("on free, a third replace leaves exactly current + 1 and the pruned objects are gone (AC26)", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const keep = 1 + limitsFor("free").previousVersions;

    const prunedKeys: string[] = [];
    let last: ReturnType<typeof newVersion> | undefined;
    for (const round of [1, 2, 3]) {
      const before = await versionRows(page.siteId);
      const response = await replace(
        request,
        baseURL!,
        cookie,
        page.siteId,
        pageHtml(`${page.marker}-r${round}`),
      );
      expect(response.status(), await response.text()).toBe(200);
      last = newVersion(await response.json());
      const after = await versionRows(page.siteId);
      const dropped = before.filter((version) => !after.some((kept) => kept.id === version.id));
      expect(last.pruned, `round ${round}`).toBe(dropped.length > 0);
      prunedKeys.push(...dropped.map((version) => version.r2Key));
    }

    const rows = await versionRows(page.siteId);
    expect(rows, "the current version plus the plan's previous versions").toHaveLength(keep);
    expect(rows.map((version) => version.id)).toContain(last!.versionId);
    expect(prunedKeys).toHaveLength(2);
    // R2 has no list by design (contract §7.5): gone means `get` is null.
    for (const key of prunedKeys) expect(await r2Store().get(key), key).toBeNull();
    for (const version of rows) expect(await r2Store().get(version.r2Key)).not.toBeNull();
  });

  test("replacing a draft does not extend its clock by a millisecond", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    // Demote through the real endpoint to get an OWNED DRAFT with a live clock.
    const demoted = await request.post(`${baseURL}/api/sites/${page.siteId}/demote`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(demoted.status(), await demoted.text()).toBe(200);

    const before = await readSite(page.siteId);
    expect(before.expiresAt, "precondition: the page is a draft").not.toBeNull();

    const response = await replace(
      request,
      baseURL!,
      cookie,
      page.siteId,
      pageHtml(`${page.marker}-draft-v2`),
    );
    expect(response.status(), await response.text()).toBe(200);
    const body = newVersion(await response.json());

    const after = await readSite(page.siteId);
    // THE ASSERTION THIS FILE EXISTS FOR. Not "roughly the same" — identical.
    expect(after.expiresAt?.toISOString()).toBe(before.expiresAt!.toISOString());
    expect(after.purgeAfter?.toISOString()).toBe(before.purgeAfter!.toISOString());
    // …and the response echoes the deadline it found rather than a fresh one.
    expect(body.expiresAt).toBe(before.expiresAt!.toISOString());
  });

  test("a page under review refuses the replace and keeps its bytes", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    // E06 RENDERS these states and writes none of them, so the fixture sets it
    // directly — there is no product path that could. AC29 names `under_review`;
    // the rest of the gate is drilled in `lib/sites/owner-routes.test.ts`.
    await db
      .update(schema.sites)
      .set({ status: "under_review" })
      .where(eq(schema.sites.id, page.siteId));

    const before = await readSite(page.siteId);
    const response = await replace(
      request,
      baseURL!,
      cookie,
      page.siteId,
      pageHtml(`${page.marker}-flagged`),
    );

    expect(response.status()).toBe(409);
    const { error } = studioErrorSchema.parse(await response.json());
    expect(error.code).toBe("not_allowed_in_status");
    // An explanation, not a bare refusal: swapping the contents of a flagged
    // page is the evasion the flag exists to stop, and the owner deserves to
    // know that is what happened.
    expect(error.message.toLowerCase()).toContain("review");

    expect(await readSite(page.siteId)).toEqual(before);
    expect(await versionRows(page.siteId), "a refused replace writes no version").toHaveLength(1);
  });

  test("an empty and an oversized body are both refused, and the page is untouched", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const before = await readSite(page.siteId);

    const empty = await replace(request, baseURL!, cookie, page.siteId, "");
    expect(empty.status()).toBe(400);
    expect(studioErrorSchema.parse(await empty.json()).error.code).toBe("invalid_file");

    // One byte past `MAX_PAGE_BYTES`, from the shared constant — the same limit
    // the publish path enforces, reached through the same schema.
    const oversized = await replace(
      request,
      baseURL!,
      cookie,
      page.siteId,
      `<!doctype html><title>x</title>${"a".repeat(MAX_PAGE_BYTES)}`,
    );
    expect(oversized.status()).toBe(413);
    expect(studioErrorSchema.parse(await oversized.json()).error.code).toBe("file_too_large");

    expect(await readSite(page.siteId)).toEqual(before);
    expect((await probeEdge(urlFor(page.slug))).body).toBe(page.html);
  });

  test("signed out is 401, another account's page is the not-found body", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const mine = await ownedPage(request, baseURL!, cookie);

    const signedOut = await request.post(`${baseURL}/api/sites/${mine.siteId}/replace`, {
      data: { html: pageHtml("e06-006r-signed-out") },
    });
    expect(signedOut.status(), "the gate must hold before any store work").toBe(401);
    studioErrorSchema.parse(await signedOut.json());
    expect((await readSite(mine.siteId)).currentVersionId).toBe(mine.versionId);

    const otherCookie = await signIn(baseURL!);
    const theirs = await ownedPage(request, baseURL!, otherCookie);

    const refused = await replace(
      request,
      baseURL!,
      cookie,
      theirs.siteId,
      pageHtml("e06-006r-stolen"),
    );
    const absent = await replace(
      request,
      baseURL!,
      cookie,
      crypto.randomUUID(),
      pageHtml("e06-006r-absent"),
    );
    expect(refused.status()).toBe(404);
    expect(absent.status()).toBe(404);
    // Byte-identical: "not yours" must not be an existence oracle.
    expect(await refused.text()).toBe(await absent.text());
    expect(studioErrorSchema.parse(await refused.json()).error.code).toBe("not_found");
    expect((await readSite(theirs.siteId)).currentVersionId).toBe(theirs.versionId);
  });

  test("a replace from a hosted page's origin is refused and changes nothing", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const before = await readSite(page.siteId);

    const refused = await request.post(`${baseURL}/api/sites/${page.siteId}/replace`, {
      // A REAL session cookie carrying a HOSTED page's origin: same-site, so
      // `SameSite=Lax` does not block it and `__Host-` does nothing about it. A
      // script on a page kept hosts rewriting its publisher's OTHER pages is
      // exactly the attack E05a exists for.
      headers: { cookie, origin: `https://${page.slug}.${servingDomain()}` },
      data: { html: pageHtml("e06-006r-csrf") },
    });

    expect(refused.status()).toBe(403);
    // E05a's flat body, untouched — the gate runs before any studio code.
    expect(publishErrorSchema.parse(await refused.json()).error).toBe("invalid_request");
    expect(await readSite(page.siteId)).toEqual(before);
    expect((await probeEdge(urlFor(page.slug))).body).toBe(page.html);
  });
});
