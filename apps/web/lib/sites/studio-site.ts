/**
 * A site row as the studio sees it — the `site` in a studio response (D9).
 *
 * ONE COLUMN LIST AND ONE MAPPER, so `POST /api/sites`'s new page and its
 * duplicate answer (and every later studio verb that returns "the updated
 * site") cannot drift into two shapes. Growing `studioSiteSchema` in
 * `@kept/shared` means growing `STUDIO_SITE_COLUMNS` here, and nothing else.
 *
 * Takes the caller's transaction: the publish reads the row it just wrote, or
 * the duplicate it found, inside the same `lockOwner` transaction that decided
 * either — never a second snapshot taken after another tab committed.
 */
import type { StudioSite } from "@kept/shared";
import { eq } from "drizzle-orm";

import type { Tx } from "../db";
import { sites } from "../db/schema";
import { liveUrl } from "../publish/pipeline";

const STUDIO_SITE_COLUMNS = {
  id: sites.id,
  slug: sites.slug,
  title: sites.title,
  status: sites.status,
  nameKind: sites.nameKind,
  expiresAt: sites.expiresAt,
  purgeAfter: sites.purgeAfter,
  updatedAt: sites.updatedAt,
} as const;

/** @throws when the row does not exist — the caller just wrote or found it. */
export async function readStudioSite(tx: Tx, siteId: string): Promise<StudioSite> {
  const [row] = await tx.select(STUDIO_SITE_COLUMNS).from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Site ${siteId} is not readable inside the transaction that holds it.`);
  return {
    id: row.id,
    slug: row.slug,
    liveUrl: liveUrl(row.slug),
    title: row.title,
    status: row.status,
    nameKind: row.nameKind,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    purgeAfter: row.purgeAfter?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
