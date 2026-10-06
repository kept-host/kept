import {
  DRAFT_GRACE_DAYS,
  NAME_HOLD_DAYS,
  deleteResultSchema,
  limitsFor,
  publishErrorSchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  pageHtml,
  probeEdge,
  publishViaApi,
  servingDomain,
  SKIP_LIVE_PUBLISH,
  STALE_EDGE_WINDOW_MS,
  urlsFor,
  waitUntilGone,
} from "./live-publish";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `DELETE /api/sites/:id` (D14), `GET /api/sites/:id/download` and
 * `GET /api/export` over the wire, against the REAL dev stack — E06 task 008,
 * AC39 and AC41.
 *
 * NO MOCKS AND NO FIXTURE ROWS. Every page is published through
 * `POST /api/publish` and adopted through the real anonymous keep, so the
 * pointer, the KV manifest, the R2 object and the edge cache all genuinely exist
 * before a delete unwinds them.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *
 *   1. **The edge comes off, inside the purge window.** The slug pointer is
 *      gone and the page stops serving within `STALE_EDGE_WINDOW_MS`. The
 *      *ordering* inside `removeManifest` is that helper's own contract and is
 *      drilled where it is observable (`lib/storage/manifest.test.ts`,
 *      `e2e/pointer-ordering.spec.ts`).
 *   2. **ARCHIVE, NOT DESTROY (D14).** `status = 'archived'` with
 *      `purge_after = now + DRAFT_GRACE_DAYS` — the deadline E07's purge orders
 *      on — and the row, the version rows and the R2 object all still present.
 *      The owner can download the page until then (AC39).
 *   3. **The slot frees**, because `isKeptCondition` excludes `archived`, and
 *      the response carries the new `KeptQuota` so the studio needs no refetch.
 *   4. **A chosen name is held for its owner**, and a second DELETE is 200 with
 *      no second hold and no second `purge_after`.
 *   5. **Re-publishing is not deduped onto the dead page:**
 *      `claimDedupCandidate` carries `status = 'live'` for precisely this case.
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Clock slack between this process and the control plane. */
const SLACK_MS = 5 * 60_000;

/** `purge_after` is the one grace window from now (D14) — never NULL (latent bug 3). */
function expectGraceFromNow(purgeAfter: Date | null): void {
  expect(purgeAfter, "a deleted page must carry E07's deadline").not.toBeNull();
  const expected = Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY;
  expect(Math.abs(purgeAfter!.getTime() - expected)).toBeLessThan(SLACK_MS);
}

test.describe("owner delete", () => {
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
      await db.delete(schema.nameHolds).where(inArray(schema.nameHolds.siteId, createdSiteIds));
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
    const email = `e06-006d-${token.slice(0, 8)}@kept-e06-006.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E06-006 delete drill" }),
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

  async function ownedPage(
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
    marker = `e06-006d-${crypto.randomUUID().slice(0, 8)}`,
  ): Promise<OwnedPage> {
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

  const remove = (
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    cookie: string,
    siteId: string,
  ) =>
    request.delete(`${baseURL}/api/sites/${siteId}`, {
      headers: sessionHeaders(cookie, baseURL),
    });

  test("the page stops serving, the row is archived with E07's deadline and retained, the slot frees, and the owner can still download it", async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + STALE_EDGE_WINDOW_MS + 60_000);

    const cookie = await signIn(baseURL!);
    // Two kept pages, so the freed slot is a number that visibly moves rather
    // than a zero that could have come from anywhere.
    const keeper = await ownedPage(request, baseURL!, cookie);
    const doomed = await ownedPage(request, baseURL!, cookie);
    const objectKey = pageObjectKey(doomed.siteId, doomed.versionId);
    const before = await readSite(doomed.siteId);

    // Warm it, so the delete is unwinding a page the edge has genuinely cached.
    expect((await probeEdge(urlsFor(doomed.slug)[0]!)).status).toBe(200);

    const response = await remove(request, baseURL!, cookie, doomed.siteId);
    expect(response.status(), await response.text()).toBe(200);
    const body = deleteResultSchema.parse(await response.json());
    expect(body.siteId).toBe(doomed.siteId);
    expect(body.slug).toBe(doomed.slug);
    // Owners reach `archived`; `removed` is E07's.
    expect(body.status).toBe("archived");
    // The account's plan's limit (new accounts are free), never a typed one.
    const { keptPages } = limitsFor("free");
    expect(body.quota).toEqual({ limit: keptPages, used: 1, remaining: keptPages - 1 });

    // ARCHIVE, DON'T DELETE: the row, the version and the bytes all survive,
    // and the row carries the deadline E07's purge orders on.
    const row = await readSite(doomed.siteId);
    expect(row.status).toBe("archived");
    expectGraceFromNow(row.purgeAfter);
    expect(row.updatedAt.getTime(), "a delete moves updated_at").toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    expect(row.slug, "the row keeps its name — nothing is destroyed today").toBe(doomed.slug);
    expect(row.ownerId).not.toBeNull();
    const versions = await db
      .select({ id: schema.siteVersions.id })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, doomed.siteId));
    expect(versions).toHaveLength(1);
    expect(
      await r2Store().get(objectKey),
      "the bytes are E07's to collect, not this endpoint's",
    ).toBe(doomed.html);

    // THE EDGE IS OFF. The pointer is gone — `lib/storage/kv` may not be
    // imported outside `manifest.ts` (lint), and the pointer is written and
    // deleted from the same call as the KV key, so its absence is the
    // manifest's absence.
    expect(await r2Store().get(pointerKey(doomed.slug))).toBeNull();
    for (const url of urlsFor(doomed.slug)) {
      const elapsed = await waitUntilGone(url);
      expect(elapsed).toBeLessThanOrEqual(STALE_EDGE_WINDOW_MS);
    }

    // The other page is untouched by any of it.
    expect((await readSite(keeper.siteId)).status).toBe("live");
    expect((await probeEdge(urlsFor(keeper.slug)[0]!)).status).toBe(200);

    // AC39 over the wire: the archived page downloads until purge_after, as an
    // attachment — the browser saves it, never renders it on this origin.
    const download = await request.get(`${baseURL}/api/sites/${doomed.siteId}/download`, {
      headers: { cookie },
    });
    expect(download.status()).toBe(200);
    expect(download.headers()["content-type"]).toBe(PAGE_CONTENT_TYPE);
    expect(download.headers()["content-disposition"]).toBe(
      `attachment; filename="${doomed.slug}.html"`,
    );
    expect(await download.text()).toBe(doomed.html);
  });

  test("a chosen name is held for its owner, deleting twice is the same success, and publishing afterwards is not deduped onto the dead page", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const chosen = `e06-008d-${crypto.randomUUID().slice(0, 8)}`;
    const renamed = await request.patch(`${baseURL}/api/sites/${page.siteId}/name`, {
      headers: sessionHeaders(cookie, baseURL!),
      data: { name: chosen },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    createdSlugs.add(chosen);

    const first = await remove(request, baseURL!, cookie, page.siteId);
    expect(first.status()).toBe(200);
    expect(deleteResultSchema.parse(await first.json()).slug).toBe(chosen);

    const [hold] = await db
      .select()
      .from(schema.nameHolds)
      .where(eq(schema.nameHolds.name, chosen));
    expect(hold, "a chosen name leaving a page is held (D4)").toBeDefined();
    expect(hold!.userId).toBe((await readSite(page.siteId)).ownerId);
    expect(hold!.reason).toBe("deleted");
    expect(
      Math.abs(hold!.heldUntil.getTime() - (Date.now() + NAME_HOLD_DAYS * MS_PER_DAY)),
    ).toBeLessThan(SLACK_MS);
    const archived = await readSite(page.siteId);
    expectGraceFromNow(archived.purgeAfter);

    // A retrying client or a double-clicked button must not see an error for
    // reaching the state it asked for — and must not move anything either.
    const second = await remove(request, baseURL!, cookie, page.siteId);
    expect(second.status(), await second.text()).toBe(200);
    expect(deleteResultSchema.parse(await second.json()).status).toBe("archived");
    expect(await readSite(page.siteId), "no second purge_after bump").toEqual(archived);
    const [again] = await db
      .select()
      .from(schema.nameHolds)
      .where(eq(schema.nameHolds.name, chosen));
    expect(again, "no second hold").toEqual(hold);

    // The SAME document from the SAME publisher identity. Without
    // `status = 'live'` in the dedup predicate this would match the archived row
    // and answer 201 with a link that 404s.
    const republished = await publishViaApi(request, page.html, {
      "user-agent": page.marker,
    });
    expect(republished.status(), await republished.text()).toBe(201);
    const body = (await republished.json()) as { slug: string; deduped: boolean };
    createdSlugs.add(body.slug);
    expect(body.deduped, "a deleted page must never be handed back as a dedup hit").toBe(
      false,
    );
    expect(body.slug).not.toBe(page.slug);

    const [row] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, body.slug));
    createdSiteIds.push(row!.id);
    expect(row!.id).not.toBe(page.siteId);
    expect((await probeEdge(urlsFor(body.slug)[0]!)).status).toBe(200);
  });

  test("a page under review can still be deleted", async ({ request, baseURL }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    await db
      .update(schema.sites)
      .set({ status: "quarantined" })
      .where(eq(schema.sites.id, page.siteId));

    // Delete and download are the only affordances a flagged page keeps —
    // rename, replace and keep are refused, and this must not be.
    const response = await remove(request, baseURL!, cookie, page.siteId);
    expect(response.status(), await response.text()).toBe(200);
    expect(deleteResultSchema.parse(await response.json()).status).toBe("archived");
    expect((await readSite(page.siteId)).status).toBe("archived");
    expect(await r2Store().get(pointerKey(page.slug))).toBeNull();
  });

  test("signed out is 401, another account's page is the not-found body — for delete and download alike", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const mine = await ownedPage(request, baseURL!, cookie);

    const signedOut = await request.delete(`${baseURL}/api/sites/${mine.siteId}`);
    expect(signedOut.status(), "the gate must hold before any store work").toBe(401);
    studioErrorSchema.parse(await signedOut.json());
    expect((await readSite(mine.siteId)).status).toBe("live");
    for (const path of [`/api/sites/${mine.siteId}/download`, "/api/export"]) {
      const anonymous = await request.get(`${baseURL}${path}`);
      expect(anonymous.status(), path).toBe(401);
      studioErrorSchema.parse(await anonymous.json());
    }

    const otherCookie = await signIn(baseURL!);
    const theirs = await ownedPage(request, baseURL!, otherCookie);

    const refused = await remove(request, baseURL!, cookie, theirs.siteId);
    const absent = await remove(request, baseURL!, cookie, crypto.randomUUID());
    expect(refused.status()).toBe(404);
    expect(absent.status()).toBe(404);
    // Byte-identical: "not yours" must not be an existence oracle.
    expect(await refused.text()).toBe(await absent.text());
    expect(studioErrorSchema.parse(await refused.json()).error.code).toBe("not_found");
    expect((await readSite(theirs.siteId)).status).toBe("live");
    expect(await r2Store().get(pointerKey(theirs.slug))).not.toBeNull();

    // AC39: somebody else's page does not download either — the same body.
    const stolen = await request.get(`${baseURL}/api/sites/${theirs.siteId}/download`, {
      headers: { cookie },
    });
    expect(stolen.status()).toBe(404);
    expect(await stolen.text()).toBe(await absent.text());
  });

  test("the export streams over the wire as a native download of a zip", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);

    // A plain GET with the session cookie, as a link click sends it — no origin
    // header, no fetch-to-blob.
    const response = await request.get(`${baseURL}/api/export`, { headers: { cookie } });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/zip");
    expect(response.headers()["content-disposition"]).toMatch(
      /^attachment; filename="kept-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const zip = await response.body();
    // A local file header first; the names are stored as-is (entries are not
    // compressed), so they — and the page's bytes — are in the stream verbatim.
    expect(zip.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    const text = zip.toString("utf8");
    expect(text).toContain("kept-export.json");
    expect(text).toContain(`${page.slug}/index.html`);
    expect(text).toContain(page.html);
  });

  test("a delete from a hosted page's origin is refused and the page keeps serving", async ({
    request,
    baseURL,
  }) => {
    const cookie = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const before = await readSite(page.siteId);

    const refused = await request.delete(`${baseURL}/api/sites/${page.siteId}`, {
      // A real session cookie carrying a HOSTED page's origin: same-site, so
      // `SameSite=Lax` does not block it. A script on a page kept hosts deleting
      // its publisher's other pages is the worst outcome this gate prevents.
      headers: { cookie, origin: `https://${page.slug}.${servingDomain()}` },
    });

    expect(refused.status()).toBe(403);
    // E05a's flat body, untouched — the gate runs before any studio code.
    expect(publishErrorSchema.parse(await refused.json()).error).toBe("invalid_request");
    expect(await readSite(page.siteId)).toEqual(before);
    expect(await r2Store().get(pointerKey(page.slug))).not.toBeNull();
    expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);
  });
});
