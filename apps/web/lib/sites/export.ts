/**
 * Downloads (D13) — one page, or every page as a zip. E06 task 008.
 *
 * STREAMED, NEVER STORED. Each page's bytes go from R2 to the browser through
 * the response as they arrive (`R2Store.getStream`): no whole file is held in
 * memory, nothing is written to a temp file, to R2 or to a queue. The export
 * reads its pages ONE AT A TIME, in the order the zip writer asks for them, so
 * the server's memory stays flat however many pages an account has (edge case
 * 18, AC40).
 *
 * The zip writer is `client-zip` (MIT, no dependencies, no native code): Web
 * Streams in, a `ReadableStream` out, entries STORED rather than compressed so
 * every chunk passes straight through. Chosen at this task over `fflate`'s
 * streaming `Zip`, whose callback API needs hand-written glue to become a Web
 * stream.
 *
 * What an owner may download: every page that is theirs, in every status,
 * until its `purge_after` (§5.7) — an `archived` page inside its window (D14)
 * and, since E07's D13, a `removed` one inside its window too. Never a page
 * restricted for child sexual abuse material (`withholdsBytes`, D13): nothing
 * serves those bytes to anyone. The export is the same set without `archived`
 * pages.
 */
import type { ModerationReason, SiteStatus } from "@kept/shared";
import { makeZip } from "client-zip";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { db } from "../db";
import { findSiteForOwner } from "../db/queries/publish";
import { sites } from "../db/schema";
import { withholdsBytes } from "../moderation/restriction";
import { liveUrl } from "../publish/pipeline";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } from "../storage/r2";

import { isPastGrace, SiteNotFoundError } from "./keep";

/** A file ready to hand to the browser: its name, its type and its bytes, as a stream. */
export interface Download {
  filename: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

/** The metadata file at the root of every export. */
export const EXPORT_MANIFEST_NAME = "kept-export.json";

/** One page in `kept-export.json` (§5.7). */
export interface ExportEntry {
  name: string;
  title: string | null;
  status: SiteStatus;
  /** `isDraft = expires_at != null`. */
  kind: "kept" | "draft";
  created_at: string;
  updated_at: string;
  /** Built from `servingBaseDomain()` — never from the request. */
  url: string;
}

/**
 * Whether an owner may still download this page: any status until
 * `purge_after` — after which the page is the purge job's to collect, not the
 * owner's — except a page whose bytes are withheld (D13). Exported for the
 * page-detail screen, whose Download links follow it.
 */
export function isDownloadable(
  site: { purgeAfter: Date | null; moderationReason: ModerationReason | null },
  now: Date,
): boolean {
  return !withholdsBytes(site) && !isPastGrace(site, now);
}

/**
 * One page's current version, as `{name}.html`.
 *
 * @throws {SiteNotFoundError} not this owner's, past `purge_after`, withheld (D13), or no bytes to give
 */
export async function openPageDownload(
  siteId: string,
  ownerId: string,
  now = new Date(),
): Promise<Download> {
  const site = await findSiteForOwner(siteId, ownerId);
  if (!site || !site.currentVersionId || !isDownloadable(site, now)) {
    throw new SiteNotFoundError(siteId);
  }

  const body = await r2Store().getStream(pageObjectKey(site.id, site.currentVersionId));
  if (!body) {
    console.error(
      `[kept] download: site ${site.id} (slug "${site.slug}") points at version ${site.currentVersionId}, which has no R2 object. E07 DIVERGENCE AUDIT: Postgres is the authority (contract §7.5).`,
    );
    throw new SiteNotFoundError(siteId);
  }
  return { filename: `${site.slug}.html`, contentType: PAGE_CONTENT_TYPE, body };
}

/**
 * Every page the owner can still download, except archived ones, as
 * `kept-export-{YYYY-MM-DD}.zip`: `kept-export.json` first, then
 * `{name}/index.html` per page. With no pages it is a valid zip whose JSON is
 * an empty list.
 */
export async function openExport(ownerId: string, now = new Date()): Promise<Download> {
  const rows = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      title: sites.title,
      status: sites.status,
      currentVersionId: sites.currentVersionId,
      expiresAt: sites.expiresAt,
      purgeAfter: sites.purgeAfter,
      moderationReason: sites.moderationReason,
      createdAt: sites.createdAt,
      updatedAt: sites.updatedAt,
    })
    .from(sites)
    // Withheld bytes (D13) are left out in the SQL as well as by
    // `isDownloadable`: the predicate sits beside the archived filter, so no
    // later edit to the JS can put one into a zip (Risk 13).
    .where(
      and(
        eq(sites.ownerId, ownerId),
        ne(sites.status, "archived"),
        or(isNull(sites.moderationReason), ne(sites.moderationReason, "child_sexual_abuse")),
      ),
    )
    .orderBy(asc(sites.createdAt), asc(sites.id));
  const pages = rows.filter((page) => isDownloadable(page, now));

  const manifest: ExportEntry[] = pages.map((page) => ({
    name: page.slug,
    title: page.title,
    status: page.status,
    kind: page.expiresAt === null ? "kept" : "draft",
    created_at: page.createdAt.toISOString(),
    updated_at: page.updatedAt.toISOString(),
    url: liveUrl(page.slug),
  }));

  async function* entries() {
    // The zip writer cancels by throwing into this generator; aborting releases
    // the R2 read in flight, which it never cancels itself.
    const abort = new AbortController();
    try {
      yield {
        name: EXPORT_MANIFEST_NAME,
        input: `${JSON.stringify(manifest, null, 2)}\n`,
        lastModified: now,
      };
      const r2 = r2Store();
      for (const page of pages) {
        // Opened only when the writer asks for the next file: one page in
        // flight, whatever the account's size.
        const body = page.currentVersionId
          ? await r2.getStream(pageObjectKey(page.id, page.currentVersionId), abort.signal)
          : null;
        if (!body) {
          console.error(
            `[kept] export: site ${page.id} (slug "${page.slug}") has no current R2 object; it is listed in ${EXPORT_MANIFEST_NAME} without a file. E07 DIVERGENCE AUDIT: Postgres is the authority (contract §7.5).`,
          );
          continue;
        }
        yield { name: `${page.slug}/index.html`, input: body, lastModified: page.updatedAt };
      }
    } finally {
      abort.abort();
    }
  }

  return {
    filename: `kept-export-${now.toISOString().slice(0, 10)}.zip`,
    contentType: "application/zip",
    body: makeZip(entries()),
  };
}
