/**
 * The visits sync's write half — E06 task 009 (PRD §5.6, AC32's idempotency,
 * AC35).
 *
 * NO MOCKS. The day arithmetic and `?days=` parsing are pure; everything else
 * runs against the real dev Neon branch: real `sites` rows, real
 * `page_views_daily` upserts fed by the real mapper, real `job_runs` rows. The
 * network half (Cloudflare → rows) is drilled over HTTP by
 * `e2e/visits-sync.spec.ts`, which needs the analytics-scoped token.
 *
 * `job_runs` drills use a throwaway job key, never `visits-sync`: dev Neon is
 * the deployed dev stack's database, and the studio's "as of" reads the real
 * key. Every row created here is deleted in `after`.
 *
 * The live drills SKIP when `DATABASE_URL` is absent (fork-PR CI). Run locally:
 *
 *   pnpm --filter @kept/web test:unit
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { VISITS_HISTORY_DAYS } from "@kept/shared";
import { config } from "dotenv";
import { asc, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { jobRuns, nameEvents, pageViewsDaily, sites } from "../db/schema";
import type { VisitGroup } from "./graphql";
import { mapVisits } from "./map";
import {
  completeUtcDays,
  loadNameEventsByDay,
  parseSyncDays,
  withJobRun,
  writeVisitRows,
} from "./sync";

config({ path: ".env.local", quiet: true });

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const BASE = "kept-dev.xyz";

describe("parseSyncDays — the `?days=` contract", () => {
  test("absent means one day", () => {
    assert.equal(parseSyncDays(null), 1);
  });

  test(`1 to ${VISITS_HISTORY_DAYS} pass through`, () => {
    assert.equal(parseSyncDays("1"), 1);
    assert.equal(parseSyncDays("7"), 7);
    assert.equal(parseSyncDays(String(VISITS_HISTORY_DAYS)), VISITS_HISTORY_DAYS);
  });

  test("everything else is refused (the route answers 400)", () => {
    for (const raw of [
      "0",
      String(VISITS_HISTORY_DAYS + 1),
      "-1",
      "1.5",
      "1e1",
      " 3",
      "",
      "abc",
    ]) {
      assert.equal(parseSyncDays(raw), null, JSON.stringify(raw));
    }
  });
});

describe("completeUtcDays — which days a run syncs", () => {
  test("the N most recent COMPLETE days, oldest first — never today", () => {
    assert.deepEqual(completeUtcDays(3, new Date("2026-10-04T16:00:00Z")), [
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  test("UTC, not local time: one second past midnight still syncs only yesterday", () => {
    assert.deepEqual(completeUtcDays(1, new Date("2026-10-04T00:00:01Z")), ["2026-10-03"]);
    assert.deepEqual(completeUtcDays(1, new Date("2026-10-03T23:59:59Z")), ["2026-10-02"]);
  });

  test("month and leap-year boundaries", () => {
    assert.deepEqual(completeUtcDays(2, new Date("2026-03-01T03:17:00Z")), [
      "2026-02-27",
      "2026-02-28",
    ]);
    assert.deepEqual(completeUtcDays(2, new Date("2028-03-01T03:17:00Z")), [
      "2028-02-28",
      "2028-02-29",
    ]);
  });

  test(`the backfill window is ${VISITS_HISTORY_DAYS} distinct ascending days ending yesterday`, () => {
    const days = completeUtcDays(VISITS_HISTORY_DAYS, new Date("2026-10-04T03:17:00Z"));
    assert.equal(days.length, VISITS_HISTORY_DAYS);
    assert.equal(days.at(-1), "2026-10-03");
    assert.equal(days[0], "2026-09-04");
    assert.deepEqual([...days].sort(), days);
    assert.equal(new Set(days).size, days.length);
  });
});

describe("AC35 — only the daily sync writes visits", () => {
  test("no app source outside lib/visits/sync.ts inserts or updates page_views_daily", () => {
    // Per-view counting would need a writer on (or called from) the serve
    // path. Reads are fine — the studio charts these rows — so only writes are
    // banned. Tests and e2e seed rows of their own and are excluded.
    let hits: string[] = [];
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "--untracked",
          "-liE",
          String.raw`(insert|update)\((schema\.)?pageViewsDaily\)|(insert into|update) page_views_daily`,
          "--",
          "*.ts",
          "*.tsx",
          ":!*.test.ts",
          ":!e2e",
        ],
        { cwd: WEB_ROOT, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      // `git grep` exits 1 on no match — which would itself mean the sync's
      // own writer vanished, and fails the assertion below.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    assert.deepEqual(hits, ["lib/visits/sync.ts"]);
  });
});

// ── live: real dev Postgres ──────────────────────────────────────────────────

const createdSites = new Set<string>();
const createdNameEvents = new Set<string>();
const JOB = `visits-sync-drill-${crypto.randomUUID()}`;

/** An anonymous live page — the cheapest real `sites` row a visit can map to. */
async function makeSite(): Promise<{ id: string; slug: string }> {
  const id = crypto.randomUUID();
  const slug = `e06-009-${id.slice(0, 12)}`;
  await db.insert(sites).values({
    id,
    slug,
    status: "live",
    region: "auto",
    anonTokenHash: `e06-009-${id}`,
    publisherHash: "e06-009-drill",
    contentHash: "e06-009",
    sizeBytes: 256,
  });
  createdSites.add(id);
  return { id, slug };
}

async function viewsFor(siteId: string): Promise<Array<{ day: string; views: number }>> {
  return db
    .select({ day: pageViewsDaily.day, views: pageViewsDaily.views })
    .from(pageViewsDaily)
    .where(eq(pageViewsDaily.siteId, siteId))
    .orderBy(asc(pageViewsDaily.day));
}

async function jobRow() {
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.job, JOB));
  return row;
}

after(async () => {
  if (skipLive) return;
  await db.delete(jobRuns).where(eq(jobRuns.job, JOB));
  if (createdNameEvents.size > 0) {
    await db.delete(nameEvents).where(inArray(nameEvents.id, [...createdNameEvents]));
  }
  // `page_views_daily.site_id` cascades, so the visit rows go with the sites.
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  await closeDb();
});

const groups = (slug: string, count: number): VisitGroup[] => [
  // Two groups for one host — the shape an hour-split day produces.
  { count: count - 1, dimensions: { clientRequestHTTPHost: `${slug}.${BASE}` } },
  { count: 1, dimensions: { clientRequestHTTPHost: `${slug}.${BASE}` } },
];

describe("writeVisitRows — the idempotent upsert", { skip: skipLive }, () => {
  test("re-writing a day overwrites `views`; it never adds to them", async () => {
    const site = await makeSite();
    const [older, yesterday] = completeUtcDays(2);
    const currentNames = new Map([[site.slug, site.id]]);
    const rowsFor = (day: string, count: number) =>
      mapVisits(groups(site.slug, count), {
        day,
        baseDomain: BASE,
        currentNames,
        nameEventsForDay: [],
      });

    assert.equal(await writeVisitRows(rowsFor(older!, 40)), 1);
    assert.equal(await writeVisitRows(rowsFor(yesterday!, 9)), 1);
    assert.deepEqual(await viewsFor(site.id), [
      { day: older, views: 40 },
      { day: yesterday, views: 9 },
    ]);

    // The same day again, same counts: unchanged — not 18.
    assert.equal(await writeVisitRows(rowsFor(yesterday!, 9)), 1);
    assert.deepEqual(await viewsFor(site.id), [
      { day: older, views: 40 },
      { day: yesterday, views: 9 },
    ]);

    // Cloudflare's number for a day moved (late data, a re-sample): the new
    // count replaces the old one, and the other day is untouched.
    assert.equal(await writeVisitRows(rowsFor(yesterday!, 11)), 1);
    assert.deepEqual(await viewsFor(site.id), [
      { day: older, views: 40 },
      { day: yesterday, views: 11 },
    ]);
  });

  test("an empty mapping writes nothing and touches nothing", async () => {
    assert.equal(await writeVisitRows([]), 0);
  });
});

describe("withJobRun — job_runs bookkeeping", { skip: skipLive }, () => {
  test("success stamps attempt and success and clears the error; failure records it and re-throws", async () => {
    const site = await makeSite();
    const [day] = completeUtcDays(1);
    const rows = mapVisits(groups(site.slug, 3), {
      day: day!,
      baseDomain: BASE,
      currentNames: new Map([[site.slug, site.id]]),
      nameEventsForDay: [],
    });

    // 1. First success: the row is created with both stamps and no error.
    const written = await withJobRun(JOB, () => writeVisitRows(rows));
    assert.equal(written, 1);
    const first = await jobRow();
    assert.ok(first?.lastAttemptAt, "last_attempt_at stamped");
    assert.ok(first?.lastSuccessAt, "last_success_at stamped");
    assert.equal(first?.lastError, null);

    // 2. A REAL failure, not a thrown stub: a row for a site that does not
    //    exist violates `page_views_daily_site_id_*_fk` in Postgres.
    const orphan = [{ siteId: crypto.randomUUID(), day: day!, views: 1 }];
    await assert.rejects(() => withJobRun(JOB, () => writeVisitRows(orphan)));
    const failed = await jobRow();
    assert.ok(failed?.lastError, "last_error recorded");
    assert.ok(
      failed!.lastAttemptAt!.getTime() >= first!.lastAttemptAt!.getTime(),
      "last_attempt_at moved for the failed run",
    );
    assert.equal(
      failed?.lastSuccessAt?.getTime(),
      first?.lastSuccessAt?.getTime(),
      "a failure never advances last_success_at",
    );

    // 3. The next success advances last_success_at and clears the error.
    await withJobRun(JOB, () => writeVisitRows(rows));
    const recovered = await jobRow();
    assert.equal(recovered?.lastError, null);
    assert.ok(recovered!.lastSuccessAt!.getTime() >= first!.lastSuccessAt!.getTime());

    // And the replay of the same rows left the count where it was.
    assert.deepEqual(await viewsFor(site.id), [{ day, views: 3 }]);
  });
});

describe("loadNameEventsByDay — renames the sync maps a past day through", { skip: skipLive }, () => {
  test("a rename whose page has since been purged is left out — its visit row would break the run", async () => {
    // `name_events.site_id` has no FK: the history outlives the page. Found on
    // the real dev zone: e2e cleanup hard-deletes renamed pages, the next
    // morning's sync mapped their hosts through those events, and the upsert
    // failed on `page_views_daily_site_id_*_fk` — a whole day lost to one
    // purged page.
    const live = await makeSite();
    const purgedSiteId = crypto.randomUUID();
    const [day] = completeUtcDays(2);
    const createdAt = new Date(`${day}T12:00:00.000Z`);
    const tag = live.id.slice(0, 8);
    const inserted = await db
      .insert(nameEvents)
      .values([
        { siteId: live.id, oldName: `e06-009-was-${tag}`, newName: live.slug, createdAt },
        {
          siteId: purgedSiteId,
          oldName: `e06-009-gone-${tag}`,
          newName: `e06-009-gone-now-${tag}`,
          createdAt,
        },
      ])
      .returning({ id: nameEvents.id });
    for (const { id } of inserted) createdNameEvents.add(id);

    const events = (await loadNameEventsByDay([day!])).get(day!) ?? [];
    const ours = events.filter((event) => event.oldName.endsWith(tag));
    assert.deepEqual(ours, [
      { siteId: live.id, oldName: `e06-009-was-${tag}`, newName: live.slug },
    ]);
    assert.ok(
      events.every((event) => event.siteId !== purgedSiteId),
      "an event for a page that no longer exists must not reach the mapper",
    );
  });
});
