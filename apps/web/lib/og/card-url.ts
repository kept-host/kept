/**
 * The canonical URL of a page's OG card, and its size — E06 task 010.
 *
 * A separate, JSX-free module on purpose: the studio's `SiteCard` thumbnail and
 * the page detail screen's metadata both need to *link* to a card, and neither
 * should drag `next/og`, satori or the vendored font bytes into its module graph
 * to do it. `lib/og/card.tsx` is the renderer; this is the address.
 *
 * ── THE CACHE KEY IS IN THE QUERY STRING, AND THAT IS THE WHOLE DESIGN ───────
 *
 * The route serves `Cache-Control: public, max-age=…, immutable`, which is a
 * promise that the bytes at *this URL* never change. That promise is only
 * keepable if the URL changes whenever the card would. So the URL carries a
 * revision token: **`sites.updated_at`, as epoch milliseconds** (D10), plus
 * the card template's version (`OG_TEMPLATE_VERSION`) — `?v=<ms>-t2`.
 *
 * Every write that can change what the card draws — a replace (a new title
 * from the new bytes), a rename (a new name and host line), an owner title
 * edit, a status change (only a `live` page is named) — is an `UPDATE sites`,
 * and `sites.updatedAt` carries Drizzle's `$onUpdate` (migration `0005`, task
 * 002), so every one of them moves the token. Invalidation for free: no purge
 * call, and nothing to remember at the write site.
 *
 * The token used to be the current version id plus a draft/kept letter. A
 * rename and a title edit touch neither half, so a card cached `immutable` for
 * a year kept showing the old name (latent bug 4). `updated_at` is the one
 * column every such write already moves.
 *
 * The template version is the other half, for the change no row records: a new
 * card *design*. Task 016 replaced the mascot card with the per-page gradients
 * (`./palette.ts`); without a new key every card already fetched would keep
 * showing the mascot for a year. Bump it whenever the drawing changes —
 * `./card.tsx`'s layout or `./palette.ts`'s list.
 *
 * The server never validates the token and never renders from it: it is a cache
 * key, not an argument. A request with a stale or absent `v` still renders the
 * page's *current* state — it will simply be stored under a key nobody asks for
 * again.
 */

/** The `og:image` aspect every crawler expects, and the `<img>` box the studio reserves. */
export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

/** The query parameter carrying the revision token. */
export const OG_CARD_REVISION_PARAM = "v";

/**
 * The card template's version — the second half of the revision token. Bump it
 * when what the card draws changes for every page at once (layout, palette).
 * `t1` was the mascot card (task 010), never written into a URL.
 */
export const OG_TEMPLATE_VERSION = "t2";

/** What `ogCardPath` needs from a row. Structurally satisfied by `OwnedSite`. */
export interface OgCardSubject {
  id: string;
  updatedAt: Date;
}

/** The revision token: `updated_at` as epoch milliseconds, then the template version. */
export function ogCardRevision(site: OgCardSubject): string {
  return `${site.updatedAt.getTime()}-${OG_TEMPLATE_VERSION}`;
}

/**
 * The app-relative path a card is fetched from.
 *
 * Relative because every consumer is same-origin: an `<img src>` on a studio
 * card, and `og:image` in the page detail screen's metadata, which Next resolves
 * against `metadataBase`. Nothing here needs to know the app's own origin, so
 * nothing here reads it.
 */
export function ogCardPath(site: OgCardSubject): string {
  const params = new URLSearchParams({
    [OG_CARD_REVISION_PARAM]: ogCardRevision(site),
  });
  return `/api/og/${site.id}?${params.toString()}`;
}
