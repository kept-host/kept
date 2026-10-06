/**
 * The dashboard read drills — E06 task 002.
 *
 * NO MOCKS (project rule). Every assertion runs against the real dev Neon
 * branch: real `user`, `profiles`, `sites` and `site_versions` rows, and the
 * real join. The cross-account drill in particular is only meaningful against a
 * real database — it is asserting that a WHERE clause exists, and a fake would
 * assert nothing at all.
 *
 * The drills SKIP when `DATABASE_URL` is absent: CI runs `pnpm test` on fork PRs
 * with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  limitsFor,
  type Plan,
  type SiteStatus,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();

async function schema() {
  return import("../schema");
}

async function client() {
  const { db } = await import("../index");
  return db;
}

async function makeProfile(plan: Plan = "free"): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  await db.insert(user).values({
    id,
    name: "E06-002 drill",
    email: `e06-002-${id}@kept.invalid`,
    emailVerified: true,
  });
  await db.insert(profiles).values({ id, email: `e06-002-${id}@kept.invalid`, plan });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  ownerId: string | null;
  /** No clock → kept; clock → draft. `isDraft = expires_at != null`. */
  kept?: boolean;
  status?: SiteStatus;
  /** Also write a `site_versions` row and point `current_version_id` at it. */
  withVersion?: boolean;
  /** `sites.title` (E06 task 001). `null` is the correct state for most rows. */
  title?: string | null;
}

async function makeSite({
  ownerId,
  kept = false,
  status = "live",
  withVersion = false,
  title = null,
}: MakeSite): Promise<{ id: string; slug: string; versionCreatedAt: Date | null }> {
  const db = await client();
  const { siteVersions, sites } = await schema();
  const id = crypto.randomUUID();
  const slug = `e06-002-${id.slice(0, 12)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);

  await db.insert(sites).values({
    id,
    slug,
    title,
    status,
    region: "auto",
    ownerId,
    anonTokenHash: ownerId === null ? `e06-002-${id}` : null,
    publisherHash: "e06-002-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: ownerId === null ? null : now,
    contentHash: "e06-002",
    sizeBytes: 256,
  });
  createdSites.add(id);

  if (!withVersion) return { id, slug, versionCreatedAt: null };

  const versionId = crypto.randomUUID();
  const [version] = await db
    .insert(siteVersions)
    .values({
      id: versionId,
      siteId: id,
      region: "auto",
      r2Key: `sites/${id}/${versionId}/index.html`,
      contentHash: "e06-002",
      sizeBytes: 256,
    })
    .returning({ createdAt: siteVersions.createdAt });

  const { eq } = await import("drizzle-orm");
  await db.update(sites).set({ currentVersionId: versionId }).where(eq(sites.id, id));

  return { id, slug, versionCreatedAt: version?.createdAt ?? null };
}

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { profiles, sites, user } = await schema();
  const { inArray } = await import("drizzle-orm");

  if (createdSites.size > 0) {
    // `site_versions.site_id` cascades, so the versions go with the sites.
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdProfiles.size > 0) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.$client.end();
});

test(
  "the split is expires_at != null; flagged pages are shown, archived and past-grace ones are not",
  { skip: skipLive },
  async () => {
    const { getDashboardSites } = await import("./dashboard");
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();

    const keptLive = await makeSite({
      ownerId: profileId,
      kept: true,
      withVersion: true,
      title: "A page with a name",
    });
    const draft = await makeSite({ ownerId: profileId, kept: false });
    const quarantined = await makeSite({
      ownerId: profileId,
      kept: true,
      status: "quarantined",
    });
    const reviewedDraft = await makeSite({ ownerId: profileId, kept: false, status: "under_review" });
    await makeSite({ ownerId: profileId, kept: true, status: "archived" });
    const expiredInGrace = await makeSite({ ownerId: profileId, kept: false, status: "expired" });
    const expiredPastGrace = await makeSite({ ownerId: profileId, kept: false, status: "expired" });
    await db
      .update(sites)
      .set({ purgeAfter: new Date(Date.now() - MS_PER_DAY) })
      .where(eq(sites.id, expiredPastGrace.id));

    const { kept, drafts, quota, names } = await getDashboardSites(profileId);

    assert.deepEqual(
      [...kept.map((s) => s.id)].sort(),
      [keptLive.id, quarantined.id].sort(),
      "the wall is isKeptCondition: a flagged kept page stays, an archived one does not",
    );
    assert.deepEqual(
      [...drafts.map((s) => s.id)].sort(),
      [draft.id, reviewedDraft.id, expiredInGrace.id].sort(),
      "drafts: serving or flagged, plus expired inside the grace window — not past it",
    );

    // The wall and the counter are the same predicate now, so they agree.
    const { keptPages } = limitsFor("free");
    assert.deepEqual(quota, { limit: keptPages, used: 2, remaining: keptPages - 2 });
    assert.equal(kept.length, quota.used);
    assert.equal(names, 0, "no page here has a chosen name");

    const row = kept.find((s) => s.id === keptLive.id);
    assert.ok(row, "the kept page is present");
    assert.equal(row.slug, keptLive.slug);
    assert.equal(row.title, "A page with a name", "the card has a human name to render");
    assert.equal(row.status, "live");
    assert.equal(row.expiresAt, null);
    assert.equal(row.purgeAfter, null);
    assert.equal(row.sizeBytes, 256);
    assert.equal(row.visits, null, "no page_views_daily rows → null, never 0");
    assert.ok(row.currentVersionId, "the join key is projected");
    assert.equal(
      row.versionCreatedAt?.getTime(),
      keptLive.versionCreatedAt?.getTime(),
      "the current version joined in on one round trip",
    );

    const versionless = kept.find((s) => s.id === quarantined.id);
    assert.ok(versionless, "a row with no current version is NOT dropped by the join");
    assert.equal(versionless.currentVersionId, null);
    assert.equal(versionless.versionCreatedAt, null);
    assert.equal(
      versionless.title,
      null,
      "a titleless page is a permanent, correct state — the caller renders `title ?? slug`",
    );
  },
);

test(
  "a LIVE draft past its grace window — no expiry sweep ran — is not on the home, and its detail screen is not found",
  { skip: skipLive },
  async () => {
    // The deployed-dev bug: no E07 sweep exists, so a draft whose clock ran out
    // 40 days ago still says `live`, and the home listed it with a Keep button.
    const { getDashboardSites, getOwnedSiteById } = await import("./dashboard");
    const { isDownloadable } = await import("../../sites/export");
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();

    const inGrace = await makeSite({ ownerId: profileId, kept: false });
    const pastGrace = await makeSite({ ownerId: profileId, kept: false });
    const expiresAt = new Date(Date.now() - 40 * MS_PER_DAY);
    await db
      .update(sites)
      .set({ expiresAt, purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY) })
      .where(eq(sites.id, pastGrace.id));

    const { kept, drafts } = await getDashboardSites(profileId);
    assert.deepEqual(kept, []);
    assert.deepEqual(
      drafts.map((s) => s.id),
      [inGrace.id],
      "a draft past its grace never reaches the home — not the list, not the counts",
    );

    // `/site/[id]` shows exactly what its Download link can still serve.
    const detail = await getOwnedSiteById(profileId, pastGrace.id);
    assert.ok(detail);
    assert.equal(isDownloadable(detail, new Date()), false, "the detail screen answers not found");
  },
);

test(
  "drafts come back soonest expires_at first, and each page carries its recent visits",
  { skip: skipLive },
  async () => {
    const { getDashboardSites } = await import("./dashboard");
    const db = await client();
    const { pageViewsDaily, sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();

    const later = await makeSite({ ownerId: profileId, kept: false });
    const sooner = await makeSite({ ownerId: profileId, kept: false });
    await db
      .update(sites)
      .set({ expiresAt: new Date(Date.now() + 2 * MS_PER_DAY) })
      .where(eq(sites.id, sooner.id));
    // Touched last, so an `updated_at` order would put it first — it must not.
    await db.update(sites).set({ updatedAt: new Date() }).where(eq(sites.id, later.id));

    const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().slice(0, 10);
    await db.insert(pageViewsDaily).values({ siteId: sooner.id, day: yesterday, views: 9 });

    const { drafts, visitsFailed } = await getDashboardSites(profileId);
    assert.deepEqual(
      drafts.map((s) => s.id),
      [sooner.id, later.id],
    );
    assert.equal(drafts[0]?.visits, 9);
    assert.equal(drafts[1]?.visits, null);
    assert.equal(visitsFailed, false);
  },
);

test(
  "rows come back most-recently-updated first",
  { skip: skipLive },
  async () => {
    const { getDashboardSites } = await import("./dashboard");
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();

    const older = await makeSite({ ownerId: profileId, kept: true });
    const newer = await makeSite({ ownerId: profileId, kept: true });

    const now = Date.now();
    await db
      .update(sites)
      .set({ updatedAt: new Date(now - 2 * MS_PER_DAY) })
      .where(eq(sites.id, older.id));
    await db.update(sites).set({ updatedAt: new Date(now) }).where(eq(sites.id, newer.id));

    const { kept } = await getDashboardSites(profileId);
    assert.deepEqual(
      kept.map((s) => s.id),
      [newer.id, older.id],
    );
  },
);

test(
  "another account's page is invisible on the home and by id, indistinguishably from missing",
  { skip: skipLive },
  async () => {
    const { getDashboardSites, getOwnedSiteById } = await import("./dashboard");
    const owner = await makeProfile();
    const stranger = await makeProfile();

    const theirs = await makeSite({ ownerId: owner, kept: true });
    const anonymous = await makeSite({ ownerId: null });

    const seen = await getDashboardSites(stranger);
    assert.deepEqual([...seen.kept, ...seen.drafts], [], "the stranger owns nothing");
    assert.ok(
      ![...seen.kept, ...seen.drafts].some((s) => s.id === theirs.id),
      "and cannot see the owner's page by id",
    );

    // A real id owned by someone else, an anonymous page's id, and an id that
    // never existed all answer identically: null. There is nothing in the
    // return value to tell the three apart, because the scope is in the SQL.
    assert.equal(await getOwnedSiteById(stranger, theirs.id), null);
    assert.equal(await getOwnedSiteById(stranger, anonymous.id), null);
    assert.equal(await getOwnedSiteById(stranger, crypto.randomUUID()), null);

    // The owner still reaches their own page by the same call, with the two
    // fields only the detail screen edits.
    const mine = await getOwnedSiteById(owner, theirs.id);
    assert.ok(mine);
    assert.equal(mine.id, theirs.id);
    assert.equal(mine.expiresAt, null);
    assert.equal(mine.listedPublic, false);
    assert.equal(mine.nameKind, "generated");
  },
);

test(
  "getOwnedSiteById returns the owner's archived row too — the detail screen decides what it may still show",
  { skip: skipLive },
  async () => {
    const { getOwnedSiteById } = await import("./dashboard");
    const owner = await makeProfile();
    const archived = await makeSite({ ownerId: owner, kept: true, status: "archived" });

    const row = await getOwnedSiteById(owner, archived.id);
    assert.equal(row?.status, "archived");
  },
);

test(
  "an account with zero pages returns empty lists and a 0-of-limit quota — its OWN plan's limit — never a throw",
  { skip: skipLive },
  async () => {
    const { getDashboardSites, getOwnedSiteById } = await import("./dashboard");

    // Both plans, because the number on the dashboard is the plan's (D1): a
    // quota that printed the free number to a premium account would be the
    // header lying about the one figure it exists to state.
    for (const plan of ["free", "premium"] as const) {
      const profileId = await makeProfile(plan);
      const { keptPages } = limitsFor(plan);

      const result = await getDashboardSites(profileId);
      assert.deepEqual(result.kept, []);
      assert.deepEqual(result.drafts, []);
      assert.equal(result.names, 0);
      assert.deepEqual(result.quota, { limit: keptPages, used: 0, remaining: keptPages }, plan);

      assert.equal(await getOwnedSiteById(profileId, crypto.randomUUID()), null);
    }
  },
);

test(
  "bug 5: an archived kept row is absent from both arrays",
  { skip: skipLive },
  async () => {
    const { getDashboardSites } = await import("./dashboard");
    const profileId = await makeProfile();

    const live = await makeSite({ ownerId: profileId, kept: true });
    const archivedKept = await makeSite({ ownerId: profileId, kept: true, status: "archived" });
    const archivedDraft = await makeSite({ ownerId: profileId, kept: false, status: "archived" });

    const { kept, drafts } = await getDashboardSites(profileId);
    const ids = [...kept, ...drafts].map((s) => s.id);

    assert.ok(ids.includes(live.id), "the live kept page is on the home");
    assert.ok(!ids.includes(archivedKept.id), "an archived kept page is not on the home");
    assert.ok(!ids.includes(archivedDraft.id), "an archived draft is not on the home");
  },
);
