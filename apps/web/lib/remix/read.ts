/**
 * The one read behind `/remix/{slug}` (E10 D7, D8, AC12): a public, unscoped
 * look-up by slug, so it selects only what the remix page shows.
 *
 * `null` unless the page is KEPT, `live` and `remixAllowed` — a draft, a page
 * whose owner turned remix off, a removed, archived or restricted page and an
 * unknown slug all 404 alike. The prompt is returned only when the owner shows
 * it (`show_prompt`), the model only when "Made with" is on (`show_made_with`).
 */
import { remixAllowed } from "@kept/shared";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db";
import { sites } from "../db/schema";
import { ogCardPath } from "../og/card-url";
import { liveUrl } from "../publish/pipeline";
import { appOrigin } from "../storage/env";

export interface RemixPageData {
  /** The page's title, or its slug. */
  title: string;
  model?: string;
  shownPrompt?: string;
  /** `https://{slug}.{servingBaseDomain()}` — configuration, never the request. */
  pageUrl: string;
  /** Absolute: the card route is served on the `app.` host only. */
  ogImageUrl: string;
}

export async function remixPageData(slug: string): Promise<RemixPageData | null> {
  const [row] = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      title: sites.title,
      updatedAt: sites.updatedAt,
      model: sites.model,
      prompt: sites.prompt,
      showMadeWith: sites.showMadeWith,
      showPrompt: sites.showPrompt,
      allowRemix: sites.allowRemix,
    })
    .from(sites)
    .where(and(eq(sites.slug, slug), eq(sites.status, "live"), isNull(sites.expiresAt)))
    .limit(1);

  if (!row || !remixAllowed({ allowRemix: row.allowRemix, kept: true, model: row.model })) return null;

  return {
    title: row.title ?? row.slug,
    ...(row.showMadeWith && row.model ? { model: row.model } : {}),
    ...(row.showPrompt && row.prompt ? { shownPrompt: row.prompt } : {}),
    pageUrl: liveUrl(row.slug),
    ogImageUrl: `${appOrigin()}${ogCardPath(row)}`,
  };
}
