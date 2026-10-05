/**
 * The host → site mapping rules — E06 task 009 (PRD §5.6, edge cases 15–16).
 *
 * `mapVisits` is a pure function, so these drills need no database and no
 * network: each one hands it Cloudflare-shaped groups (`count` +
 * `dimensions.clientRequestHTTPHost`, the exact selection `graphql.ts` makes)
 * plus a hand-built set of names and `name_events`, and asserts the exact rows.
 *
 * AC31 runs the same function over a CAPTURED real response:
 * `fixtures/visits-2026-10-04.json` is what Cloudflare answered the sync's own
 * query for the dev zone on that day, written by
 * `pnpm --filter @kept/web visits:capture` (see `scripts/capture-visits.ts`).
 * Recorded data, not a mock — it is read by the live path's own parser.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { visitGroupsOf, type VisitGroup } from "./graphql";
import { mapVisits, type NameEvent, type VisitsMapContext } from "./map";

const BASE = "kept-dev.xyz";
const DAY = "2026-10-03";

const SITE_A = "00000000-0000-4000-8000-00000000000a";
const SITE_B = "00000000-0000-4000-8000-00000000000b";
const SITE_C = "00000000-0000-4000-8000-00000000000c";

function group(host: string, count: number): VisitGroup {
  return { count, dimensions: { clientRequestHTTPHost: host } };
}

function context(
  names: Record<string, string>,
  nameEventsForDay: NameEvent[] = [],
): VisitsMapContext {
  return { day: DAY, baseDomain: BASE, currentNames: new Map(Object.entries(names)), nameEventsForDay };
}

describe("mapVisits", () => {
  test("a current name maps to its site, stamped with the context's day", () => {
    const rows = mapVisits([group(`sunny-otter.${BASE}`, 42)], context({ "sunny-otter": SITE_A }));
    assert.deepEqual(rows, [{ siteId: SITE_A, day: DAY, views: 42 }]);
  });

  test("the same host twice — an hour-split day — is summed into one row", () => {
    const rows = mapVisits(
      [group(`sunny-otter.${BASE}`, 3), group(`sunny-otter.${BASE}`, 4)],
      context({ "sunny-otter": SITE_A }),
    );
    assert.deepEqual(rows, [{ siteId: SITE_A, day: DAY, views: 7 }]);
  });

  test("edge case 16: the apex, `app.`, `www.` and reserved labels are ignored", () => {
    // `admin` is listed as a current name ON PURPOSE: the reserved check must
    // run before the lookup, so even a stale row holding a reserved label
    // (minted before the label was reserved) never collects visits.
    const rows = mapVisits(
      [
        group(BASE, 900),
        group(`app.${BASE}`, 800),
        group(`www.${BASE}`, 700),
        group(`admin.${BASE}`, 600),
        group(`sunny-otter.${BASE}`, 5),
      ],
      context({ admin: SITE_B, "sunny-otter": SITE_A }),
    );
    assert.deepEqual(rows, [{ siteId: SITE_A, day: DAY, views: 5 }]);
  });

  test("hosts outside the serving domain, unknown labels and multi-level labels are ignored", () => {
    const rows = mapVisits(
      [
        group("sunny-otter.kept.host", 10), // the other track's domain
        group(`sunny-otter.${BASE}.evil.example`, 10), // suffix must END the host
        group(`sunny-otter${BASE}`, 10), // no dot before the base domain
        group(`never-published.${BASE}`, 10), // no such name
        group(`a.sunny-otter.${BASE}`, 10), // a name never contains a dot
        group(`sunny-otter.${BASE}`, 1),
      ],
      context({ "sunny-otter": SITE_A }),
    );
    assert.deepEqual(rows, [{ siteId: SITE_A, day: DAY, views: 1 }]);
  });

  test("edge case 15: a page renamed mid-day keeps its old name's visits for that day", () => {
    // SITE_A was `old-name` until the rename and `new-name` after it. Both
    // halves of the day are its visits, summed. SITE_C renamed twice that day;
    // the intermediate name is only in `name_events` and still resolves.
    const rows = mapVisits(
      [
        group(`old-name.${BASE}`, 12),
        group(`new-name.${BASE}`, 5),
        group(`first.${BASE}`, 2),
        group(`second.${BASE}`, 3),
        group(`third.${BASE}`, 4),
      ],
      context({ "new-name": SITE_A, third: SITE_C }, [
        { siteId: SITE_A, oldName: "old-name", newName: "new-name" },
        { siteId: SITE_C, oldName: "first", newName: "second" },
        { siteId: SITE_C, oldName: "second", newName: "third" },
      ]),
    );
    assert.deepEqual(rows, [
      { siteId: SITE_A, day: DAY, views: 17 },
      { siteId: SITE_C, day: DAY, views: 9 },
    ]);
  });

  test("an old name only resolves through the events it is given — another day's rename is unknown", () => {
    // The caller passes THAT day's `name_events`; a name released on some
    // other day and held by nobody now is an unknown host here.
    const rows = mapVisits([group(`old-name.${BASE}`, 12)], context({ "new-name": SITE_A }));
    assert.deepEqual(rows, []);
  });

  test("a current name wins over the same name in that day's events", () => {
    // SITE_A released `shared` that day and SITE_B holds it now: the host's
    // visits cannot be split by time, so they go to the current holder.
    const rows = mapVisits(
      [group(`shared.${BASE}`, 8)],
      context({ shared: SITE_B, elsewhere: SITE_A }, [
        { siteId: SITE_A, oldName: "shared", newName: "elsewhere" },
      ]),
    );
    assert.deepEqual(rows, [{ siteId: SITE_B, day: DAY, views: 8 }]);
  });

  test("hosts are normalised the way the Worker resolves them: case, port, trailing dot", () => {
    const rows = mapVisits(
      [
        group(`Sunny-Otter.KEPT-DEV.XYZ`, 1),
        group(`sunny-otter.${BASE}:443`, 2),
        group(`sunny-otter.${BASE}.`, 3),
      ],
      context({ "sunny-otter": SITE_A }),
    );
    assert.deepEqual(rows, [{ siteId: SITE_A, day: DAY, views: 6 }]);
  });

  test("rows come back one per site, sorted by site id; no groups → no rows", () => {
    const names = { b: SITE_B, a: SITE_A, c: SITE_C };
    const rows = mapVisits(
      [group(`c.${BASE}`, 1), group(`a.${BASE}`, 1), group(`b.${BASE}`, 1)],
      context(names),
    );
    assert.deepEqual(
      rows.map((row) => row.siteId),
      [SITE_A, SITE_B, SITE_C],
    );
    assert.deepEqual(mapVisits([], context(names)), []);
  });
});

describe("AC31: mapVisits over a captured real Cloudflare response", () => {
  // The dev zone's `httpRequestsAdaptiveGroups` for 2026-10-04, unedited: 150
  // host groups, every host a dev test page or the apex. No hostname needed
  // anonymising — none of them is a real user's page.
  const CAPTURED_DAY = "2026-10-04";
  const captured: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/visits-${CAPTURED_DAY}.json`, import.meta.url), "utf8"),
  );

  test("hand-built names + that day's name_events → the exact page_views_daily rows", () => {
    const groups = visitGroupsOf(captured);
    assert.equal(groups.length, 150, "the capture parses whole through the live path's parser");

    // Names for four of the captured hosts, one of them renamed that day:
    //   hba6gmzr          8 views  → SITE_A, a current name
    //   rjzll → lrcqv     4 + 4    → SITE_B, renamed mid-day (edge case 15)
    //   e06-014-af78a48a  1 view   → SITE_C, a current name
    //   quiet-page        absent   → SITE_D, a name with no traffic, so no row
    // Every other page host in the capture is unknown here and is ignored, and
    // so are the apex's two groups, `kept-dev.xyz` (35) and `kept-dev.xyz:443`
    // (1, Cloudflare reports the Host header as sent, port included).
    const SITE_D = "00000000-0000-4000-8000-00000000000d";
    const rows = mapVisits(groups, {
      day: CAPTURED_DAY,
      baseDomain: BASE,
      currentNames: new Map([
        ["hba6gmzr", SITE_A],
        ["lrcqv", SITE_B],
        ["e06-014-af78a48a", SITE_C],
        ["quiet-page", SITE_D],
      ]),
      nameEventsForDay: [{ siteId: SITE_B, oldName: "rjzll", newName: "lrcqv" }],
    });

    assert.deepEqual(rows, [
      { siteId: SITE_A, day: CAPTURED_DAY, views: 8 },
      { siteId: SITE_B, day: CAPTURED_DAY, views: 8 },
      { siteId: SITE_C, day: CAPTURED_DAY, views: 1 },
    ]);
  });
});
