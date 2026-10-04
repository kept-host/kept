/**
 * The studio's visits reads — E06 task 011.
 *
 * NO MOCKS (project rule): real `page_views_daily` and `job_runs` rows on the
 * dev Neon branch, deleted in `after`. Skips when `DATABASE_URL` is absent.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { VISITS_RECENT_DAYS } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();
const JOB = `visits-read-drill-${crypto.randomUUID()}`;

async function schema() {
  return import("../schema");
}

async function client() {
  const { db } = await import("../index");
  return db;
}

async function makeProfile(): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  const email = `e06-011-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "E06-011 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

async function makeSite(ownerId: string): Promise<string> {
  const db = await client();
  const { sites } = await schema();
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug: `e06-011-${id.slice(0, 12)}`,
    ownerId,
    publisherHash: "e06-011-drill",
    claimedAt: new Date(),
    contentHash: "e06-011",
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

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { jobRuns, profiles, sites, user } = await schema();
  const { eq, inArray } = await import("drizzle-orm");
  // `page_views_daily.site_id` cascades, so the visit rows go with the sites.
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdProfiles.size > 0) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.delete(jobRuns).where(eq(jobRuns.job, JOB));
  await db.$client.end();
});

test(
  "recentVisitsByOwner sums the last VISITS_RECENT_DAYS days per page, owner-scoped, and omits pages with no rows",
  { skip: skipLive },
  async () => {
    const { recentVisitsByOwner } = await import("./visits");
    const db = await client();
    const { pageViewsDaily } = await schema();

    const owner = await makeProfile();
    const stranger = await makeProfile();
    const visited = await makeSite(owner);
    const unvisited = await makeSite(owner);
    const theirs = await makeSite(stranger);

    await db.insert(pageViewsDaily).values([
      { siteId: visited, day: utcDayAgo(1), views: 10 },
      { siteId: visited, day: utcDayAgo(VISITS_RECENT_DAYS), views: 5 },
      // One day past the window: not counted.
      { siteId: visited, day: utcDayAgo(VISITS_RECENT_DAYS + 1), views: 100 },
      { siteId: theirs, day: utcDayAgo(1), views: 7 },
    ]);

    const visits = await recentVisitsByOwner(owner);
    assert.equal(visits.get(visited), 15, "the two in-window days, and not the one before");
    assert.equal(visits.has(unvisited), false, "no rows is absent — the caller renders null, never 0");
    assert.equal(visits.has(theirs), false, "another account's page is not in this owner's map");
  },
);

test(
  "lastVisitsSync is the job's last success, and null when the job never ran",
  { skip: skipLive },
  async () => {
    const { lastVisitsSync } = await import("./visits");
    const db = await client();
    const { jobRuns } = await schema();

    assert.equal(await lastVisitsSync(JOB), null, "never ran → null");

    const at = new Date("2026-10-03T03:17:00.000Z");
    await db.insert(jobRuns).values({ job: JOB, lastAttemptAt: at, lastSuccessAt: at });
    assert.equal((await lastVisitsSync(JOB))?.toISOString(), at.toISOString());
  },
);
