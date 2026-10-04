import {
  DRAFT_GRACE_DAYS,
  accountDeletionResultSchema,
  ownedPublishResultSchema,
  publishErrorSchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  pageHtml,
  probeEdge,
  servingDomain,
  SKIP_LIVE_PUBLISH,
  STALE_EDGE_WINDOW_MS,
  waitForBytes,
} from "./live-publish";
import { jarlessContext, sessionHeaders } from "./session-request";

/**
 * `DELETE /api/account` over the wire, against the REAL dev stack — decision
 * **D16** (E06 task 008; AC43's server half — task 014 adds the second browser
 * context).
 *
 * NO MOCKS AND NO FIXTURE ROWS. Every page is published through the real owned
 * publish (`POST /api/sites`) by a real magic-link session, so the pointer, the
 * KV manifest, the R2 object and the edge cache all genuinely exist before the
 * teardown unwinds them.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *
 *  1. **No ownerless live page.** After deletion, `status = 'live' AND owner_id
 *     IS NULL AND anon_token_hash IS NULL AND expires_at IS NULL` returns zero
 *     rows. Asserted UNSCOPED, because the failure mode is precisely a row no
 *     ownership query can reach.
 *  2. **Every page is `archived`, ownerless, with E07's deadline** —
 *     `purge_after = now + DRAFT_GRACE_DAYS` for the pages taken offline now.
 *     Owners reach `archived`; `removed` is E07's.
 *  3. **The pages stop serving**, inside the architectural window, with the
 *     pointer gone for every affected slug.
 *  4. **R2 objects are still present** — E07's purge collects them.
 *  5. **A chosen name is held with no owner.**
 *  6. **The session is gone** — its row with the user, and this browser's
 *     cookie cleared by the response.
 *  7. **A second account's pages are untouched.**
 *
 * The gates are drilled too: signed out is 401, a hosted page's origin is 403,
 * and a body without the account's email is 400 — each mutating nothing.
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

/** Both URL forms: `/index.html` is a separate cache entry from `/`. */
const urlsFor = (slug: string): string[] => [
  `https://${slug}.${servingDomain()}/`,
  `https://${slug}.${servingDomain()}/index.html`,
];

test.describe("account deletion", () => {
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
    // The deleted account's rows SURVIVE the teardown — that is the point — and
    // their `owner_id` is null by now, so cleanup goes by id, never by owner.
    if (createdSiteIds.length) {
      await db.delete(schema.nameHolds).where(inArray(schema.nameHolds.siteId, createdSiteIds));
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (createdUserIds.length) {
      await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
    }
    await closeDb();
  });

  /** A real session cookie, its user id and email, from the real magic-link verify endpoint. */
  async function signIn(
    baseURL: string,
  ): Promise<{ cookie: string; userId: string; email: string }> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replace(/-/g, "");
    const email = `e06-011-${token.slice(0, 8)}@kept-e06-011.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "E06-011 account deletion drill" }),
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
      return { cookie, userId: body.user.id, email };
    } finally {
      await requestCtx.dispose();
    }
  }

  interface OwnedPage {
    siteId: string;
    slug: string;
    versionId: string;
    objectKey: string;
    html: string;
  }

  /** One page published straight into the account — no anon token ever minted. */
  async function ownedPage(
    request: APIRequestContext,
    baseURL: string,
    cookie: string,
  ): Promise<OwnedPage> {
    const html = pageHtml(`e06-011-${crypto.randomUUID().slice(0, 8)}`);
    const response = await request.post(`${baseURL}/api/sites`, {
      headers: { ...sessionHeaders(cookie, baseURL), "content-type": "text/html" },
      data: html,
    });
    expect(response.status(), await response.text()).toBe(201);
    const { site } = ownedPublishResultSchema.parse(await response.json());
    createdSlugs.add(site.slug);
    createdSiteIds.push(site.id);

    const [row] = await db
      .select({ versionId: schema.sites.currentVersionId })
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id));
    const versionId = row?.versionId;
    expect(versionId, "a published page must have a current version").toBeTruthy();

    return {
      siteId: site.id,
      slug: site.slug,
      versionId: versionId!,
      objectKey: pageObjectKey(site.id, versionId!),
      html,
    };
  }

  const readSite = async (id: string) => {
    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(row, `site ${id} vanished`).toBeDefined();
    return row!;
  };

  const destroy = (
    request: APIRequestContext,
    baseURL: string,
    cookie: string,
    email: unknown,
  ) =>
    request.delete(`${baseURL}/api/account`, {
      headers: { ...sessionHeaders(cookie, baseURL), "content-type": "application/json" },
      data: JSON.stringify({ email }),
    });

  /** Poll a URL until it stops serving, or until the architectural bound. */
  async function waitUntilGone(url: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const probe = await probeEdge(url);
      if (probe.status !== 200) return;
      if (Date.now() - started > STALE_EDGE_WINDOW_MS) {
        throw new Error(
          `${url} still served 200 after ${Math.round(STALE_EDGE_WINDOW_MS / 1000)}s — past the delayed re-purge, which means a purge did not land.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  test("every page goes dark and lands `archived` with no owner, its chosen name is held, the bytes stay, and another account is untouched", async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + STALE_EDGE_WINDOW_MS + 120_000);

    const { cookie, userId, email } = await signIn(baseURL!);
    // The four shapes an account can be holding when its owner presses delete:
    // pages[0] archived, pages[1] quarantined, pages[2] kept, pages[3] an owned
    // DRAFT. All four are real publishes with bytes and a manifest to unwind;
    // the draft is a kept page demoted through the real route, so the shape
    // does not depend on filling the account to its kept limit first.
    const pages: OwnedPage[] = [];
    for (let i = 0; i < 4; i += 1) {
      pages.push(await ownedPage(request, baseURL!, cookie));
    }
    const draft = pages[3]!;
    const demoted = await request.post(`${baseURL}/api/sites/${draft.siteId}/demote`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect(
      (await readSite(draft.siteId)).expiresAt,
      "the demoted page is an owned draft, on its clock",
    ).not.toBeNull();

    const archived = await request.delete(`${baseURL}/api/sites/${pages[0]!.siteId}`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(archived.status(), await archived.text()).toBe(200);
    const archivedBefore = await readSite(pages[0]!.siteId);
    await db
      .update(schema.sites)
      .set({ status: "quarantined" })
      .where(eq(schema.sites.id, pages[1]!.siteId));

    // The kept page takes a CHOSEN name, which must end held with no owner.
    const chosen = `e06-008a-${crypto.randomUUID().slice(0, 8)}`;
    const renamed = await request.patch(`${baseURL}/api/sites/${pages[2]!.siteId}/name`, {
      headers: sessionHeaders(cookie, baseURL!),
      data: { name: chosen },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    createdSlugs.add(chosen);
    pages[2] = { ...pages[2]!, slug: chosen };
    await waitForBytes(urlsFor(chosen)[0]!, pages[2].html);

    // A second account, whose page must survive all of this.
    const other = await signIn(baseURL!);
    const theirs = await ownedPage(request, baseURL!, other.cookie);
    const theirsBefore = await readSite(theirs.siteId);

    // Warm the edge, so the deletion is unwinding pages Cloudflare has cached.
    for (const page of pages.slice(2)) {
      expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);
    }

    const response = await destroy(request, baseURL!, cookie, email);
    expect(response.status(), await response.text()).toBe(200);
    const body = accountDeletionResultSchema.parse(await response.json());
    // The three still claiming their names went offline now; pages[0] already had.
    expect(body.pagesArchived).toBe(pages.length - 1);
    // ── CLAIM 6: this browser's session cookie is cleared by the response.
    const cleared = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value);
    expect(
      cleared.some((value) => /^__Host-kept\.session_token=;/.test(value) && /Max-Age=0/i.test(value)),
      cleared.join(" | "),
    ).toBe(true);

    for (const page of pages) {
      const row = await readSite(page.siteId);
      expect(row.status, `${page.slug}: owners reach archived`).toBe("archived");
      expect(row.purgeAfter, `${page.slug} must be sweepable by E07`).not.toBeNull();
      expect(row.ownerId, `${page.slug}: no owner left`).toBeNull();
      expect(row.reminderEmail).toBeNull();
      if (page !== pages[0]) {
        expect(
          Math.abs(row.purgeAfter!.getTime() - (Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY)),
          `${page.slug}: one grace window from now`,
        ).toBeLessThan(SLACK_MS);
      }
      // The edge is off. The pointer is written and deleted from the same
      // `removeManifest` call as the KV key, so its absence is the manifest's.
      expect(await r2Store().get(pointerKey(page.slug)), page.slug).toBeNull();
      // The bytes are E07's to collect, not this endpoint's.
      expect(await r2Store().get(page.objectKey), page.slug).toBe(page.html);
    }

    expect(
      (await readSite(pages[0]!.siteId)).purgeAfter,
      "a page deleted earlier keeps its own deadline",
    ).toEqual(archivedBefore.purgeAfter);

    for (const page of pages.slice(2)) {
      for (const url of urlsFor(page.slug)) await waitUntilGone(url);
    }

    // ── CLAIM 5: the chosen name is held with no owner (D16).
    const [hold] = await db
      .select()
      .from(schema.nameHolds)
      .where(eq(schema.nameHolds.name, chosen));
    expect(hold, "a chosen name is held after its account is deleted").toBeDefined();
    expect(hold!.userId).toBeNull();
    expect(hold!.reason).toBe("account_deleted");

    // CRITERION 13, deliberately unscoped — the failure mode is a row that no
    // ownership query can reach, so a query scoped by owner could not see it.
    const ownerless = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug })
      .from(schema.sites)
      .where(
        and(
          eq(schema.sites.status, "live"),
          isNull(schema.sites.ownerId),
          isNull(schema.sites.anonTokenHash),
          isNull(schema.sites.expiresAt),
        ),
      );
    expect(
      ownerless,
      "a live page with no owner, no token and no clock is unreachable by any authority in the product",
    ).toEqual([]);

    // Better Auth's rows went with the user, so every other device is signed
    // out on its next request and the same address builds a NEW account.
    expect(
      await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(eq(schema.profiles.id, userId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.session.id })
        .from(schema.session)
        .where(eq(schema.session.userId, userId)),
    ).toEqual([]);
    // The old cookie, replayed, is signed out.
    const replayed = await request.delete(`${baseURL}/api/sites/${pages[2]!.siteId}`, {
      headers: sessionHeaders(cookie, baseURL!),
    });
    expect(replayed.status()).toBe(401);

    // The other account is exactly as it was.
    expect(await readSite(theirs.siteId)).toEqual(theirsBefore);
    expect(await r2Store().get(pointerKey(theirs.slug))).not.toBeNull();
    expect((await probeEdge(urlsFor(theirs.slug)[0]!)).status).toBe(200);
  });

  test("the gates hold: signed out, foreign origin and anything but the account's email all change nothing", async ({
    request,
    baseURL,
  }) => {
    const { cookie, email } = await signIn(baseURL!);
    const other = await signIn(baseURL!);
    const page = await ownedPage(request, baseURL!, cookie);
    const before = await readSite(page.siteId);

    const signedOut = await request.delete(`${baseURL}/api/account`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ email }),
    });
    expect(signedOut.status(), "the gate must hold before any store work").toBe(401);
    studioErrorSchema.parse(await signedOut.json());
    expect(await readSite(page.siteId)).toEqual(before);

    // A real session cookie carrying a HOSTED page's origin: same-site, so
    // `SameSite=Lax` does not block it. A script on a page kept hosts destroying
    // its visitor's entire account is the worst outcome this gate prevents.
    const foreign = await request.delete(`${baseURL}/api/account`, {
      headers: {
        cookie,
        origin: `https://${page.slug}.${servingDomain()}`,
        "content-type": "application/json",
      },
      data: JSON.stringify({ email }),
    });
    expect(foreign.status()).toBe(403);
    // E05a's flat body, untouched — the gate runs before any studio code.
    expect(publishErrorSchema.parse(await foreign.json()).error).toBe("invalid_request");
    expect(await readSite(page.siteId)).toEqual(before);

    // Only this account's own address arms it — not another real one, not the
    // old phrase, not nothing.
    for (const typed of ["", "delete my account", other.email, `${email}.`, undefined]) {
      const refused = await destroy(request, baseURL!, cookie, typed);
      expect(refused.status(), String(typed)).toBe(400);
      expect(studioErrorSchema.parse(await refused.json()).error.code, String(typed)).toBe(
        "invalid_request",
      );
      expect(await readSite(page.siteId)).toEqual(before);
    }
    expect(await r2Store().get(pointerKey(page.slug))).not.toBeNull();
    expect((await probeEdge(urlsFor(page.slug)[0]!)).status).toBe(200);

    // And the account's email — trimmed, any case — from the app's own origin,
    // does the thing.
    const done = await destroy(request, baseURL!, cookie, ` ${email.toUpperCase()} `);
    expect(done.status(), await done.text()).toBe(200);
    expect(accountDeletionResultSchema.parse(await done.json()).pagesArchived).toBe(1);
    expect((await readSite(page.siteId)).status).toBe("archived");
  });
});
