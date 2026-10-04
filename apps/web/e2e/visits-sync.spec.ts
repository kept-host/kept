import { RESERVED_NAMES, VISITS_HISTORY_DAYS, VISITS_SYNC_JOB } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { servingBaseDomain } from "../lib/storage/env";
import { fetchVisitGroups, probeVisitsSettings } from "../lib/visits/graphql";
import { completeUtcDays, dayBounds } from "../lib/visits/sync";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * `POST /api/cron/visits-sync` over the wire — E06 task 009 (AC32, AC33).
 *
 * `lib/visits/map.test.ts` drills the mapping rules and
 * `lib/visits/sync.test.ts` the upsert and `job_runs` on real Postgres. What
 * they cannot do is the network half: the route reading Cloudflare's real
 * aggregates for this zone and writing what they say. That needs
 * `CLOUDFLARE_API_TOKEN` to carry `Zone → Analytics → Read` (human step 2,
 * DEFERRED-HUMAN at the time of writing). Until it does, the live drills SKIP
 * with that reason, decided by the zone's own `settings` probe answering
 * `authz` — the exact refusal the route would hit. The refusal drills need
 * only `CRON_SECRET` and always run.
 *
 * NO MOCKS: real dev Neon branch, real HTTP, real Cloudflare GraphQL. The live
 * drills write real `page_views_daily` rows and advance the real
 * `job_runs('visits-sync')` — the same effect as the workflow's own run, which
 * is what they are proving.
 */
config({ path: ".env.local", quiet: true });

const SKIP_CRON: string | false = process.env.CRON_SECRET?.trim()
  ? false
  : "CRON_SECRET absent — run locally with apps/web/.env.local";

const LIVE_REQUIRED = [
  "DATABASE_URL",
  "CRON_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;
const missingLive = LIVE_REQUIRED.filter((name) => !process.env[name]?.trim());

const ENDPOINT = "/api/cron/visits-sync";

const auth = () => ({ authorization: `Bearer ${process.env.CRON_SECRET}` });

test.describe("the visits-sync cron endpoint — refusals", () => {
  test.skip(!!SKIP_CRON, SKIP_CRON || undefined);

  test("an unauthenticated call is refused, in one shape, before any work", async ({
    request,
  }) => {
    const secret = process.env.CRON_SECRET!;
    const bodies = new Set<string>();
    for (const headers of [
      {},
      { authorization: "Bearer not-the-secret" },
      { authorization: `Basic ${secret}` },
      { authorization: secret },
    ] as Record<string, string>[]) {
      const response = await request.post(`${ENDPOINT}?days=1`, { headers });
      expect(response.status(), JSON.stringify(headers)).toBe(401);
      expect(response.headers()["cache-control"]).toContain("no-store");
      bodies.add(JSON.stringify(await response.json()));
    }
    expect(bodies.size).toBe(1);

    // A link prefetcher must not be able to fire a sync.
    expect((await request.get(ENDPOINT)).status()).toBeGreaterThanOrEqual(400);
  });

  test(`?days outside 1–${VISITS_HISTORY_DAYS} is a 400, before any sync work`, async ({
    request,
  }) => {
    for (const days of ["0", String(VISITS_HISTORY_DAYS + 1), "-3", "1.5", "abc"]) {
      const response = await request.post(`${ENDPOINT}?days=${days}`, { headers: auth() });
      expect(response.status(), days).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_days" });
    }
  });
});

test.describe("the visits-sync cron endpoint — live against Cloudflare", () => {
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  /** Why the live drills skip, or `false` once the token can read analytics. */
  let skipLive: string | false =
    missingLive.length > 0
      ? `live credentials absent (${missingLive.join(", ")}) — run locally with apps/web/.env.local`
      : false;

  const createdSiteIds: string[] = [];

  test.beforeAll(async () => {
    if (skipLive) return;
    try {
      await probeVisitsSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a missing scope is a reason to skip. Anything else — a network
      // failure, a schema change — is a real failure and must stay red.
      if (!/\bauthz\b|HTTP 40[13]\b/.test(message)) throw error;
      skipLive =
        "CLOUDFLARE_API_TOKEN lacks Zone → Analytics → Read (Cloudflare answered authz) — " +
        "DEFERRED-HUMAN, E06 task 009 human step 2";
      return;
    }
    await warmDb();
  });

  test.afterAll(async () => {
    if (createdSiteIds.length > 0) {
      // `page_views_daily.site_id` cascades, so the visit rows go with them.
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (!missingLive.includes("DATABASE_URL")) await closeDb();
  });

  async function jobRun() {
    const [row] = await db
      .select()
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.job, VISITS_SYNC_JOB));
    return row;
  }

  async function rowsForDay(day: string) {
    return db
      .select({ siteId: schema.pageViewsDaily.siteId, views: schema.pageViewsDaily.views })
      .from(schema.pageViewsDaily)
      .where(eq(schema.pageViewsDaily.day, day))
      .orderBy(asc(schema.pageViewsDaily.siteId));
  }

  test("AC32: a day syncs, success is recorded, and a re-run leaves views unchanged", async ({
    request,
  }) => {
    test.skip(!!skipLive, skipLive || undefined);

    const before = await jobRun();
    const [yesterday] = completeUtcDays(1);

    const first = await request.post(`${ENDPOINT}?days=1`, { headers: auth() });
    expect(first.status(), await first.text()).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; days: number; rows: number };
    expect(firstBody).toMatchObject({ ok: true, days: 1 });

    const after = await jobRun();
    expect(after?.lastError ?? null).toBeNull();
    expect(after?.lastSuccessAt?.getTime() ?? 0).toBeGreaterThan(
      before?.lastSuccessAt?.getTime() ?? 0,
    );
    const snapshot = await rowsForDay(yesterday!);
    expect(snapshot.length).toBeGreaterThanOrEqual(firstBody.rows);

    // The same day again: an upsert that REPLACES views — nothing doubles.
    const second = await request.post(`${ENDPOINT}?days=1`, { headers: auth() });
    expect(second.status(), await second.text()).toBe(200);
    expect(((await second.json()) as { rows: number }).rows).toBe(firstBody.rows);
    expect(await rowsForDay(yesterday!)).toEqual(snapshot);
  });

  test(`AC33: ?days=${VISITS_HISTORY_DAYS} backfills — rows exist for older days after one call`, async ({
    request,
  }) => {
    test.skip(!!skipLive, skipLive || undefined);

    // Find real traffic on a day OLDER than yesterday: a page host the mapper
    // would accept. Newest first, so the scan is short on an active zone.
    const baseDomain = servingBaseDomain();
    const reserved: ReadonlySet<string> = new Set(RESERVED_NAMES);
    const olderDays = completeUtcDays(VISITS_HISTORY_DAYS).slice(0, -1).reverse();
    let target: { day: string; label: string } | undefined;
    for (const day of olderDays) {
      const { start, end } = dayBounds(day);
      const label = (await fetchVisitGroups(start, end))
        .map((group) => group.dimensions.clientRequestHTTPHost.toLowerCase())
        .filter((host) => host.endsWith(`.${baseDomain}`))
        .map((host) => host.slice(0, -(baseDomain.length + 1)))
        .find((candidate) => /^[a-z0-9-]+$/.test(candidate) && !reserved.has(candidate));
      if (label) {
        target = { day, label };
        break;
      }
    }
    test.skip(
      !target,
      `no HTML traffic to any page host on ${baseDomain} in the ${olderDays.length} older days — nothing for a backfill to write`,
    );

    // The host must map to a site: the active page holding that name, or —
    // when the page behind the traffic is gone — a page this drill creates
    // under it. Either way the row is the backfill's to write.
    const { day, label } = target!;
    const [holder] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(
        and(
          eq(schema.sites.slug, label),
          notInArray(schema.sites.status, ["archived", "removed"]),
        ),
      );
    let siteId = holder?.id;
    if (!siteId) {
      siteId = crypto.randomUUID();
      await db.insert(schema.sites).values({
        id: siteId,
        slug: label,
        status: "live",
        region: "auto",
        anonTokenHash: `e06-009-${siteId}`,
        publisherHash: "e06-009-backfill",
        contentHash: "e06-009",
        sizeBytes: 128,
      });
      createdSiteIds.push(siteId);
    }

    const response = await request.post(`${ENDPOINT}?days=${VISITS_HISTORY_DAYS}`, {
      headers: auth(),
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, days: VISITS_HISTORY_DAYS });

    const [row] = await db
      .select({ views: schema.pageViewsDaily.views })
      .from(schema.pageViewsDaily)
      .where(and(eq(schema.pageViewsDaily.siteId, siteId), eq(schema.pageViewsDaily.day, day)));
    expect(row?.views ?? 0, `${label} on ${day}`).toBeGreaterThan(0);
  });
});
