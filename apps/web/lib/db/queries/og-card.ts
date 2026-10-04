/**
 * The one read behind `GET /api/og/:siteId` — E06 task 010.
 *
 * ── WHY THIS IS NOT IN `./dashboard.ts` ─────────────────────────────────────
 *
 * That module's contract, written in its own header, is "every SQL statement the
 * signed-in owner's screens read", and every query in it is owner-scoped —
 * `owner_id` is in the WHERE clause precisely so a forgotten check in a caller
 * cannot become a cross-account read. This query is the opposite shape by
 * necessity: the OG route has **no session** (it is fetched as an `<img>` and by
 * crawlers), so it looks a row up by primary key with no owner scope at all.
 * Filing an unscoped read inside a module whose invariant is "always scoped"
 * would break the invariant for every future reader of that file.
 *
 * ── WHAT IT IS ALLOWED TO SELECT ────────────────────────────────────────────
 *
 * Three columns, and no more: slug, title, status. It does not reuse
 * `getDashboardSites`' projection, does not join anything it does not draw, and
 * **does not read R2** — the card is a generated still, not a screenshot, so the
 * page's bytes are never fetched.
 *
 * `updated_at` is deliberately absent: it is the cache key in `?v=`
 * (`lib/og/card-url.ts`), which the route never reads — a stale or absent token
 * still renders the row's current state. `size_bytes`, `owner_id`,
 * `anon_token_hash`, the draft clocks and every other timestamp are absent too.
 * Nothing on the card can show them, so nothing here should be able to.
 */
import type { SiteStatus } from "@kept/shared";
import { eq } from "drizzle-orm";

import { db } from "../index";
import { sites } from "../schema";

/** Exactly what the card can draw, and nothing the card cannot draw. */
export interface OgCardSite {
  slug: string;
  /** The page's title, or `null`. The route renders `title ?? slug`. */
  title: string | null;
  /** Only a `live` page is named on its card (D10). */
  status: SiteStatus;
}

/**
 * One page by id, or `null`.
 *
 * `null` covers "no such row" and nothing else — a malformed id never reaches
 * here, because the route validates the UUID shape before calling and a
 * malformed value handed to Postgres would raise `22P02` rather than returning
 * empty. The route collapses both into the same generic card regardless.
 */
export async function getOgCardSite(siteId: string): Promise<OgCardSite | null> {
  const [row] = await db
    .select({
      slug: sites.slug,
      title: sites.title,
      status: sites.status,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);

  return row ?? null;
}
