/**
 * The canonical URL of a page's OG card — E06 task 010.
 *
 * A separate, JSX-free module on purpose: the dashboard wall, the site detail
 * screen and `/site/[slug]`'s metadata all need to *link* to a card, and none of
 * them should drag `next/og`, satori or 450 KB of font bytes into their module
 * graph to do it. `lib/og/card.tsx` is the renderer; this is the address.
 *
 * ── THE CACHE KEY IS IN THE QUERY STRING, AND THAT IS THE WHOLE DESIGN ───────
 *
 * The route serves `Cache-Control: public, max-age=…, immutable`, which is a
 * promise that the bytes at *this URL* never change. That promise is only
 * keepable if the URL changes whenever the card would. So the URL carries a
 * revision token built from the two things the card draws:
 *
 *   · `currentVersionId` — a replace mints a new version row, the token moves,
 *     every cache misses, and the new card is fetched. Invalidation for free,
 *     with no purge call and nothing to remember to do at the write site.
 *   · the draft/kept bit — keeping or demoting a page does **not** touch
 *     `current_version_id`, but it does flip the chip. Without this the card
 *     would keep saying "Draft" for a year after the page was kept forever.
 *
 * The server never validates the token and never renders from it: it is a cache
 * key, not an argument. A request with a stale or absent `v` still renders the
 * page's *current* state — it will simply be stored under a key nobody asks for
 * again.
 */

/** The query parameter carrying the revision token. */
export const OG_CARD_REVISION_PARAM = "v";

/** What `ogCardPath` needs from a row. Structurally satisfied by `OwnedSite`. */
export interface OgCardSubject {
  id: string;
  currentVersionId: string | null;
  expiresAt: Date | null;
}

/**
 * The revision token: the current version plus the draft/kept bit.
 *
 * `"none"` rather than an empty segment when a row has no current version, so
 * the token is never ambiguous and never produces `v=-d`.
 */
export function ogCardRevision(site: OgCardSubject): string {
  // `isDraft = expires_at != null` — the only split there is.
  const phase = site.expiresAt === null ? "k" : "d";
  return `${site.currentVersionId ?? "none"}-${phase}`;
}

/**
 * The app-relative path a card is fetched from.
 *
 * Relative because both consumers are same-origin: an `<img src>` on the
 * dashboard, and `og:image` in `/site/[slug]`'s metadata, which Next resolves
 * against `metadataBase`. Nothing here needs to know the app's own origin, so
 * nothing here reads it.
 */
export function ogCardPath(site: OgCardSubject): string {
  const params = new URLSearchParams({
    [OG_CARD_REVISION_PARAM]: ogCardRevision(site),
  });
  return `/api/og/${site.id}?${params.toString()}`;
}
