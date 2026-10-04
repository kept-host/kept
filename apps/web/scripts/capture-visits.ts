/**
 * Probe the zone's analytics limits and capture one real visits response —
 * E06 task 009 (PRD §5.6, AC31).
 *
 *   pnpm --filter @kept/web visits:capture                 # yesterday (UTC)
 *   pnpm --filter @kept/web visits:capture --day 2026-10-03
 *
 * 1. Prints the zone's `settings` node for `httpRequestsAdaptiveGroups`:
 *    `enabled`, `availableFields`, `maxDuration`, `notOlderThan`. That is the
 *    probe the PR records — and any of the three filter fields
 *    (`edgeResponseStatus`, `edgeResponseContentTypeName`, `requestSource`)
 *    missing from `availableFields` is dropped from `lib/visits/graphql.ts`.
 * 2. Fetches that UTC day's raw response with the sync's own query and writes
 *    it to `lib/visits/fixtures/visits-<day>.json` — the captured real response
 *    AC31's mapper test runs on. Recorded data, not a mock. Read it before
 *    committing: anonymise a hostname only if it would leak a real user's page.
 *
 * Reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` from apps/web/.env.local
 * through the same accessor as the sync. The token needs `Zone → Analytics →
 * Read`; without it both steps fail on Cloudflare's `authz` error, by name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

import { fetchVisitsResponse, probeVisitsSettings, visitGroupsOf } from "../lib/visits/graphql";
import { completeUtcDays, dayBounds } from "../lib/visits/sync";
import { readOption } from "./lib/cli-args";

config({ path: ".env.local", quiet: true });

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../lib/visits/fixtures");

const FILTER_FIELDS = ["edgeResponseStatus", "edgeResponseContentTypeName", "requestSource"];

function readDay(): string {
  const day = readOption("day", "VISITS_CAPTURE_DAY") ?? completeUtcDays(1)[0]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`--day must be a UTC date as YYYY-MM-DD, got "${day}"`);
  }
  return day;
}

async function main(): Promise<void> {
  const day = readDay();

  console.log("kept · visits probe + capture\n");
  const settings = await probeVisitsSettings();
  console.log("settings.httpRequestsAdaptiveGroups:");
  console.log(JSON.stringify(settings, null, 2));
  for (const field of FILTER_FIELDS) {
    // `availableFields` names a nested field by its path (`sum_requests`), so
    // a dimension is matched on its last path segment, however it is joined.
    const present = settings.availableFields.some(
      (available) => available.split(/[._]/).at(-1) === field,
    );
    console.log(`      filter ${field}: ${present ? "available" : "NOT LISTED — drop it"}`);
  }

  const { start, end } = dayBounds(day);
  const body = await fetchVisitsResponse(start, end);
  const groups = visitGroupsOf(body);

  mkdirSync(FIXTURES, { recursive: true });
  const path = join(FIXTURES, `visits-${day}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);

  console.log(`\n      captured ${groups.length} host group(s) for ${day}`);
  console.log(`      wrote ${path}`);
}

main().catch((err: unknown) => {
  console.error(`CAPTURE FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
