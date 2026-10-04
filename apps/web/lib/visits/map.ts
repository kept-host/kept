/**
 * Hostname → site mapping for the visits sync — E06 task 009 (D8, PRD §5.6).
 *
 * PURE. No database, no network, no clock, no environment: everything it needs
 * arrives as arguments, which is what lets AC31 run it over a captured real
 * Cloudflare response with a hand-built set of names and assert the exact rows.
 * `sync.ts` loads the names and writes the rows; this only decides.
 *
 * THE RULES, in order, per hostname:
 *   1. Normalise it the way the Worker does (lowercase, no `:port`, no
 *      trailing FQDN dot) and require the `.{baseDomain}` suffix. The apex and
 *      any host outside the serving domain are ignored.
 *   2. The label left over must not be a `RESERVED_NAMES` member (edge case
 *      16). That covers `app.` — the control plane — and `www.`; `RESERVED_NAMES`
 *      deliberately lists `app` for exactly this kind of reader.
 *   3. Resolve it through the CURRENT names first, then through that day's
 *      `name_events`, old and new names both (edge case 15): a page renamed
 *      mid-day was served under its old name for part of the day and its new
 *      name for the rest, and both halves are its visits. A multi-level label
 *      (`a.b.{base}`) contains a dot no name can contain, so it simply misses.
 *   4. Anything still unresolved is ignored, never guessed at.
 *
 * Several hosts landing on one site — the old and new name of a rename, or the
 * hour windows of a split day — are summed into one row.
 */
import { RESERVED_NAMES } from "@kept/shared";

import type { VisitGroup } from "./graphql";

/** One `name_events` row, reduced to what the mapping reads. */
export interface NameEvent {
  siteId: string;
  oldName: string;
  newName: string;
}

/** One `page_views_daily` row. `day` is a UTC calendar date, `YYYY-MM-DD`. */
export interface VisitRow {
  siteId: string;
  day: string;
  views: number;
}

export interface VisitsMapContext {
  /** The UTC day the groups were counted over, `YYYY-MM-DD`. */
  day: string;
  /** `KEPT_BASE_DOMAIN`: `kept-dev.xyz` on dev, `kept.host` on prod. */
  baseDomain: string;
  /** Every active name today → the site that holds it. */
  currentNames: ReadonlyMap<string, string>;
  /** `name_events` created during `day`, in any order. */
  nameEventsForDay: readonly NameEvent[];
}

const RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMES);

/** Lowercase, drop a trailing `:port`, drop one trailing FQDN dot. */
function normalizeHost(host: string): string {
  const withoutPort = host.trim().toLowerCase().replace(/:\d+$/, "");
  return withoutPort.endsWith(".") ? withoutPort.slice(0, -1) : withoutPort;
}

/** Rows for one day's groups, one per site, sorted by site id. */
export function mapVisits(groups: readonly VisitGroup[], context: VisitsMapContext): VisitRow[] {
  const suffix = `.${normalizeHost(context.baseDomain)}`;

  const byName = new Map(context.currentNames);
  for (const event of context.nameEventsForDay) {
    for (const name of [event.oldName, event.newName]) {
      if (!byName.has(name)) byName.set(name, event.siteId);
    }
  }

  const views = new Map<string, number>();
  for (const group of groups) {
    const host = normalizeHost(group.dimensions.clientRequestHTTPHost);
    if (!host.endsWith(suffix)) continue;

    const label = host.slice(0, -suffix.length);
    if (RESERVED.has(label)) continue;

    const siteId = byName.get(label);
    if (siteId === undefined) continue;

    views.set(siteId, (views.get(siteId) ?? 0) + group.count);
  }

  return [...views]
    .map(([siteId, count]) => ({ siteId, day: context.day, views: count }))
    .sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0));
}
