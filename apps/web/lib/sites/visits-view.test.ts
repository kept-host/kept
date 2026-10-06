/**
 * AC34 — what the page-detail Visits tab shows, from REAL rows. E06 task 012.
 *
 * NO MOCKS (project rule): every state is reached by seeding
 * `page_views_daily` and `job_runs` in the dev Neon branch, reading them back
 * through the screen's own reads (`dailyVisits`, `lastVisitsSync`) and handing
 * them to `visitsView` — the function the tab paints. The drills run under their
 * own `job_runs` key, never the real `visits-sync` row the deployed dev stack
 * reads. Task 009's sync is not needed for any of this.
 *
 *   · no rows, never synced  → "—" + the explainer   (never a bare 0)
 *   · no rows, sync failed and never succeeded → "Visits aren't available right now."
 *   · rows                   → the 30-day series, gaps as 0, "As of" the last success
 *   · last success > VISITS_STALE_HOURS ago → the same numbers, "as of" emphasised
 *
 * SKIPS when `DATABASE_URL` is absent; every row is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { VISITS_HISTORY_DAYS, VISITS_STALE_HOURS } from "@kept/shared";
import { config } from "dotenv";

import { formatDay, VISITS_EMPTY_NOTE, VISITS_PRIVACY_LINE, visitsView } from "./visits-view";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_HOUR = 60 * 60 * 1000;
const JOB = `visits-view-drill-${crypto.randomUUID()}`;
const createdSites = new Set<string>();
const createdProfiles = new Set<string>();

async function deps() {
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { jobRuns, pageViewsDaily, profiles, sites, user } = await import("../db/schema");
  const { dailyVisits, lastVisitsSync } = await import("../db/queries/visits");
  return { eq, inArray, db, jobRuns, pageViewsDaily, profiles, sites, user, dailyVisits, lastVisitsSync };
}

async function makeSite(): Promise<string> {
  const { db, profiles, sites, user } = await deps();
  const owner = crypto.randomUUID();
  const email = `e06-012v-${owner.slice(0, 8)}@kept.invalid`;
  await db.insert(user).values({ id: owner, name: "E06-012 visits drill", email, emailVerified: true });
  await db.insert(profiles).values({ id: owner, email, plan: "free" });
  createdProfiles.add(owner);
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug: `e06-012v-${id.slice(0, 12)}`,
    ownerId: owner,
    publisherHash: "e06-012-drill",
    claimedAt: new Date(),
    contentHash: "e06-012",
    sizeBytes: 64,
  });
  createdSites.add(id);
  return id;
}

/** `YYYY-MM-DD`, `daysAgo` UTC days before today. */
function utcDayAgo(daysAgo: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - daysAgo);
  return day.toISOString().slice(0, 10);
}

/** What the tab would show for `siteId` right now, through the screen's reads. */
async function shown(siteId: string, now = new Date()) {
  const { dailyVisits, lastVisitsSync } = await deps();
  const [rows, sync] = await Promise.all([dailyVisits(siteId, VISITS_HISTORY_DAYS), lastVisitsSync(JOB)]);
  return visitsView(rows, sync, now);
}

async function recordRun(run: { lastSuccessAt: Date | null; lastError: string | null }) {
  const { db, jobRuns } = await deps();
  const at = new Date();
  await db
    .insert(jobRuns)
    .values({ job: JOB, lastAttemptAt: at, ...run })
    .onConflictDoUpdate({ target: jobRuns.job, set: { lastAttemptAt: at, ...run } });
}

after(async () => {
  if (skipLive) return;
  const { db, eq, inArray, jobRuns, profiles, sites, user } = await deps();
  // `page_views_daily.site_id` cascades, so the visit rows go with the sites.
  if (createdSites.size) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdProfiles.size) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.delete(jobRuns).where(eq(jobRuns.job, JOB));
  await db.$client.end();
});

test("AC34: never synced and no rows → the explainer, never a bare 0", { skip: skipLive }, async () => {
  const siteId = await makeSite();
  assert.deepEqual(await shown(siteId), { kind: "empty" });
  assert.equal(VISITS_EMPTY_NOTE, "Visits appear the day after your page is first opened.");
});

test("AC34: the sync failed and never succeeded, and the page has no rows → not available", { skip: skipLive }, async () => {
  const siteId = await makeSite();
  await recordRun({ lastSuccessAt: null, lastError: "authz: token lacks Zone → Analytics → Read" });
  assert.deepEqual(await shown(siteId), { kind: "unavailable" });
});

test("AC34: rows → the full window of days, gaps as 0, as of the last success", { skip: skipLive }, async () => {
  const { db, pageViewsDaily } = await deps();
  const siteId = await makeSite();
  const lastSuccessAt = new Date(Date.now() - 3 * MS_PER_HOUR);
  await recordRun({ lastSuccessAt, lastError: null });
  await db.insert(pageViewsDaily).values([
    { siteId, day: utcDayAgo(1), views: 12 },
    { siteId, day: utcDayAgo(5), views: 30 },
    { siteId, day: utcDayAgo(VISITS_HISTORY_DAYS), views: 4 },
  ]);

  const view = await shown(siteId);
  assert.equal(view.kind, "series");
  if (view.kind !== "series") return;
  assert.equal(view.days.length, VISITS_HISTORY_DAYS, "one bar per day of the window");
  assert.deepEqual(view.days[0], { day: utcDayAgo(VISITS_HISTORY_DAYS), visits: 4 }, "oldest first");
  assert.deepEqual(view.days.at(-1), { day: utcDayAgo(1), visits: 12 }, "yesterday last; today never has a row");
  assert.equal(view.days.reduce((sum, day) => sum + day.visits, 0), 46);
  assert.equal(view.days.filter((day) => day.visits === 0).length, VISITS_HISTORY_DAYS - 3, "gaps are zero days");
  assert.equal(view.asOf?.toISOString(), lastSuccessAt.toISOString());
  assert.equal(view.stale, false);
});

test(`AC34: a last success older than ${VISITS_STALE_HOURS} h keeps the numbers and marks them stale`, { skip: skipLive }, async () => {
  const { db, pageViewsDaily } = await deps();
  const siteId = await makeSite();
  await recordRun({ lastSuccessAt: new Date(Date.now() - (VISITS_STALE_HOURS + 1) * MS_PER_HOUR), lastError: "a later run failed" });
  await db.insert(pageViewsDaily).values({ siteId, day: utcDayAgo(2), views: 7 });

  const view = await shown(siteId);
  assert.equal(view.kind, "series", "an error WITH data still shows the data");
  if (view.kind !== "series") return;
  assert.equal(view.stale, true);
  assert.equal(view.days.reduce((sum, day) => sum + day.visits, 0), 7);
});

test("the privacy line and the axis labels are fixed and pinned", () => {
  assert.equal(
    VISITS_PRIVACY_LINE,
    "Counted from total traffic, approximately. kept never tracks who your visitors are.",
  );
  assert.equal(formatDay("2026-09-04"), "Sep 4");
});
