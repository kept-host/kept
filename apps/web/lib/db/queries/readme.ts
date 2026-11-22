/**
 * The row a README page (E10 D6) is rendered from — read by
 * `lib/readme/page.ts` after the caller's commit, so it is the row as it now is.
 */
import { eq } from "drizzle-orm";

import { db } from "../index";
import { sites } from "../schema";

export interface ReadmeSource {
  slug: string;
  title: string | null;
  /** Set ⇒ draft, which never has a README page (Q6). */
  expiresAt: Date | null;
  model: string | null;
  tool: string | null;
  prompt: string | null;
  readme: string | null;
  sourceUrl: string | null;
  showMadeWith: boolean;
  showPrompt: boolean;
}

/** `null` when the row is gone (purged meanwhile). */
export async function readReadmeSource(siteId: string): Promise<ReadmeSource | null> {
  const [row] = await db
    .select({
      slug: sites.slug,
      title: sites.title,
      expiresAt: sites.expiresAt,
      model: sites.model,
      tool: sites.tool,
      prompt: sites.prompt,
      readme: sites.readme,
      sourceUrl: sites.sourceUrl,
      showMadeWith: sites.showMadeWith,
      showPrompt: sites.showPrompt,
    })
    .from(sites)
    .where(eq(sites.id, siteId));
  return row ?? null;
}
