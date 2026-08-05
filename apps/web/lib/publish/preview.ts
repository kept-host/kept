/**
 * The published page's own bytes, for the two screens that show a preview of it
 * — `/p/[anonToken]` (task 008) and `/keep/[anonToken]` (task 009).
 *
 * ONE READER FOR BOTH. The size cap, the failure policy and the "which store is
 * the authority" answer are the same on both screens, so they live once. A
 * second copy would drift the moment one of the three changed.
 *
 * THE BYTES COME FROM R2, not from the edge. R2 is the authority on them, and
 * the edge could not serve this purpose anyway: hosted pages go out with
 * `frame-ancestors 'none'` / `X-Frame-Options: DENY`, so a preview can only ever
 * be an iframe with `srcdoc` (see `components/kept/page-preview.tsx`).
 *
 * BEST EFFORT BY DESIGN. A preview is worth zero outages: if the object read
 * fails or the store is unconfigured, `null` comes back and the screen renders
 * with everything that actually matters.
 */
import type { AnonSite } from "../db/queries/publish";
import { pageObjectKey, r2Store } from "../storage/r2";

/**
 * Bytes of published HTML a preview will inline. `MAX_PAGE_BYTES` is 5 MB and
 * this markup is serialized into the RSC payload of every render, so a page
 * above this cap gets the card without the render rather than a slow screen.
 */
export const PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * The page's HTML, or `null` when it cannot be shown. Never throws.
 *
 * `context` names the calling screen in the failure log. The log names the site
 * id and the slug — which diagnose everything and grant nothing. The bearer
 * token is never logged.
 */
export async function readPreviewHtml(
  site: AnonSite,
  context: string,
): Promise<string | null> {
  if (!site.currentVersionId) return null;
  if (site.sizeBytes !== null && site.sizeBytes > PREVIEW_MAX_BYTES) return null;

  try {
    return await r2Store().get(pageObjectKey(site.id, site.currentVersionId));
  } catch (err) {
    console.error(
      `[kept] ${context}: preview read failed for site ${site.id} (slug "${site.slug}") — ${
        err instanceof Error ? err.message : String(err)
      }. Rendering the screen without it.`,
    );
    return null;
  }
}
