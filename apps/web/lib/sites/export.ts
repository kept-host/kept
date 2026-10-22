/**
 * Downloads (D13) — one page, or every page as a zip. E06 task 008.
 *
 * STREAMED, NEVER STORED. Each file's bytes go from R2 to the browser through
 * the response as they arrive (`R2Store.getStream`): no whole file is held in
 * memory, nothing is written to a temp file, to R2 or to a queue. A zip — the
 * export, or the download of a multi-file version (E08) — reads its files ONE
 * AT A TIME, in the order the zip writer asks for them, so the server's memory
 * stays flat however many pages and files an account has (edge case 18, AC40;
 * E08 edge case 20). What a version's files are is `site_version_files` (E08
 * D1), never an R2 listing.
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
import { versionFiles } from "../db/queries/version-files";
import { findSiteVersion } from "../db/queries/versions";
import { sites, siteVersions } from "../db/schema";
import { withholdsBytes } from "../moderation/restriction";
import { liveUrl } from "../publish/pipeline";
import { PAGE_CONTENT_TYPE, pageObjectKey, type R2Store, r2Store, siteObjectKey } from "../storage/r2";

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

const ZIP_CONTENT_TYPE = "application/zip";

/** The version a zip reads: whose files, and when they went live. */
interface ZippedVersion {
  siteId: string;
  slug: string;
  versionId: string;
  activatedAt: Date;
}

/** One file of a zip — a stream client-zip reads to its end before asking for the next. */
interface ZipEntry {
  name: string;
  input: string | ReadableStream<Uint8Array>;
  lastModified: Date;
  size?: number;
}

/**
 * A version's files as zip entries named `{prefix}{path}`, in path order. Each
 * file's R2 read opens only when the writer asks for that entry, so one stream
 * is in flight at a time. A recorded file with no R2 object is logged and left
 * out.
 */
async function* versionEntries(
  r2: R2Store,
  version: ZippedVersion,
  prefix: string,
  signal: AbortSignal,
): AsyncGenerator<ZipEntry> {
  for (const file of await versionFiles(db, version.versionId)) {
    const body = await r2.getStream(siteObjectKey(version.siteId, version.versionId, file.path), signal);
    if (!body) {
      console.error(
        `[kept] zip: site ${version.siteId} (slug "${version.slug}") version ${version.versionId} records "${file.path}", which has no R2 object; it is left out of the zip. E07 DIVERGENCE AUDIT: Postgres is the authority (contract §7.5).`,
      );
      continue;
    }
    yield { name: `${prefix}${file.path}`, input: body, lastModified: version.activatedAt, size: file.sizeBytes };
  }
}

/**
 * A streamed zip of `entries`. The zip writer cancels by throwing into the
 * generator; aborting then releases the R2 read in flight, which the writer
 * never cancels itself.
 */
function zipStream(
  entries: (r2: R2Store, signal: AbortSignal) => AsyncGenerator<ZipEntry>,
): ReadableStream<Uint8Array> {
  async function* guarded() {
    const abort = new AbortController();
    try {
      yield* entries(r2Store(), abort.signal);
    } finally {
      abort.abort();
    }
  }
  return makeZip(guarded());
}

/**
 * One page's current version: `{name}.html` for a single file, exactly as
 * before E08; `{name}.zip` of its whole file set when it has more than one
 * (§5.7, AC38), entries named by their paths.
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

  if (site.fileCount !== null && site.fileCount > 1) {
    const version = await findSiteVersion(db, site.id, site.currentVersionId);
    if (!version) throw new SiteNotFoundError(siteId);
    const zipped = { siteId: site.id, slug: site.slug, versionId: version.id, activatedAt: version.activatedAt };
    return {
      filename: `${site.slug}.zip`,
      contentType: ZIP_CONTENT_TYPE,
      body: zipStream((r2, signal) => versionEntries(r2, zipped, "", signal)),
    };
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
 * `kept-export-{YYYY-MM-DD}.zip`: `kept-export.json` first, then each page's
 * whole current file set under `{name}/` — `{name}/index.html` for a
 * single-file page. With no pages it is a valid zip whose JSON is an empty
 * list.
 */
export async function openExport(ownerId: string, now = new Date()): Promise<Download> {
  const rows = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      title: sites.title,
      status: sites.status,
      currentVersionId: sites.currentVersionId,
      activatedAt: siteVersions.activatedAt,
      expiresAt: sites.expiresAt,
      purgeAfter: sites.purgeAfter,
      moderationReason: sites.moderationReason,
      createdAt: sites.createdAt,
      updatedAt: sites.updatedAt,
    })
    .from(sites)
    .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
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

  async function* entries(r2: R2Store, signal: AbortSignal): AsyncGenerator<ZipEntry> {
    yield {
      name: EXPORT_MANIFEST_NAME,
      input: `${JSON.stringify(manifest, null, 2)}\n`,
      lastModified: now,
    };
    for (const page of pages) {
      if (!page.currentVersionId || !page.activatedAt) {
        console.error(
          `[kept] export: site ${page.id} (slug "${page.slug}") has no current version; it is listed in ${EXPORT_MANIFEST_NAME} without a file. E07 DIVERGENCE AUDIT: Postgres is the authority (contract §7.5).`,
        );
        continue;
      }
      // Page by page, file by file, as the writer asks: one stream in flight,
      // whatever the account's size.
      yield* versionEntries(
        r2,
        { siteId: page.id, slug: page.slug, versionId: page.currentVersionId, activatedAt: page.activatedAt },
        `${page.slug}/`,
        signal,
      );
    }
  }

  return {
    filename: `kept-export-${now.toISOString().slice(0, 10)}.zip`,
    contentType: ZIP_CONTENT_TYPE,
    body: zipStream(entries),
  };
}
