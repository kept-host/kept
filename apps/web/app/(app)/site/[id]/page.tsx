/**
 * `(app)/site/[id]` — everything you can do to ONE page (PRD §5.2, §9.2). E06
 * task 012: routed by the page's UUID (D2), because names change — a rename,
 * and every draft's generated name — and a route keyed by name breaks every
 * bookmark on every rename.
 *
 * ── IT IS IN THE `(app)` GROUP, AND THAT IS THE WHOLE GATE ───────────────────
 * `app/(app)/layout.tsx` calls `requireSession()` for every route in the group,
 * so this file calls no gate of its own.
 *
 * ── THE OWNER SCOPE IS IN THE SQL ────────────────────────────────────────────
 * `getOwnedSiteById(profileId, id)` puts `owner_id` in the WHERE clause. An id
 * that belongs to somebody else returns `null`, byte-identical to one that
 * never existed, and both land on the same `notFound()` — as does an id that is
 * not a UUID (a 404, never a 500), a `removed` page and one past `purge_after`:
 * whatever the owner's Download link can no longer serve, this screen does not
 * show (`isDownloadable`). There is no "you don't own this" on this route —
 * that sentence is an existence oracle, and this screen previews the bytes.
 *
 * ── READS ONLY ───────────────────────────────────────────────────────────────
 * Every read is here, concurrently: the account's kept pages, quota and names
 * (the swap chooser's candidates and the Name section's count), the preview
 * bytes, the versions and the visits. Every mutation is the client's, through
 * the owner routes, then `router.refresh()` re-runs this (D17). Links read
 * `servingBaseDomain()` / `appOrigin()` — configuration, never the request.
 *
 * An `archived` page renders the reduced view: when it was deleted, until when
 * it can be downloaded, and the download.
 */
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { limitsFor, VISITS_HISTORY_DAYS } from "@kept/shared";

import { QrCode } from "@/components/kept/qr";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";
import { getDashboardSites, getOwnedSiteById } from "@/lib/db/queries/dashboard";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { listVersions } from "@/lib/db/queries/versions";
import { dailyVisits, lastVisitsSync } from "@/lib/db/queries/visits";
import { ogCardPath } from "@/lib/og/card-url";
import { liveUrl } from "@/lib/publish/pipeline";
import { PREVIEW_MAX_BYTES, readPreviewHtml } from "@/lib/publish/preview";
import { qrSvg } from "@/lib/qr/qr-code";
import { archivedNotice, pageName } from "@/lib/sites/display";
import { isDownloadable } from "@/lib/sites/export";
import { siteIdSchema } from "@/lib/sites/owner-routes";
import { visitsView, type VisitsView } from "@/lib/sites/visits-view";
import { appOrigin, servingBaseDomain } from "@/lib/storage/env";

import { ClockProvider } from "../../dashboard/clock";
import { Wordmark } from "../../wordmark";
import { BackLink, TOP_BAR } from "./back-link";
import { PageDetail } from "./page-detail";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/**
 * The subject, resolved once per request — `generateMetadata` and the page both
 * need it, and `cache()` makes them agree on whether it exists.
 */
const subject = cache(async (id: string) => {
  if (!siteIdSchema.safeParse(id).success) return null;
  const profile = await getProfileForSession(await getSession());
  if (!profile) return null;
  const site = await getOwnedSiteById(profile.id, id);
  return site && isDownloadable(site, new Date()) ? { profile, site } : null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const found = await subject((await params).id);
  // A missing page gets metadata for the 404 it is about to render — naming it
  // would answer the question `notFound()` exists to refuse.
  if (!found) return { title: "Page not found", robots: { index: false, follow: false } };

  const name = pageName(found.site);
  return {
    title: name,
    // A per-account management screen has no business in a search index.
    robots: { index: false, follow: false },
    // `ogCardPath` is app-relative; the base is configuration, never the
    // request (root CLAUDE.md). A malformed value drops the base rather than
    // turning a card into a 500.
    metadataBase: configuredBase(),
    openGraph: { title: name, images: [{ url: ogCardPath(found.site) }] },
  };
}

function configuredBase(): URL | undefined {
  try {
    return new URL(appOrigin());
  } catch {
    return undefined;
  }
}

/** The visits tab's state. A failed read is "not available", never the whole screen's failure. */
async function readVisits(siteId: string, now: Date): Promise<VisitsView> {
  try {
    const [rows, sync] = await Promise.all([dailyVisits(siteId, VISITS_HISTORY_DAYS), lastVisitsSync()]);
    return visitsView(rows, sync, now);
  } catch (err) {
    console.error(
      `[site-detail] visits read failed for site ${siteId}; rendering without visits — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "unavailable" };
  }
}

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const found = await subject((await params).id);
  if (!found) notFound();

  const { profile, site } = found;
  const url = liveUrl(site.slug);
  const host = new URL(url).host;
  const name = pageName(site);

  if (site.status === "archived") {
    return (
      <>
        <header className={TOP_BAR}>
          <Wordmark className="text-[22px] md:hidden" />
          <BackLink />
        </header>
        <main className="flex max-w-[640px] flex-col gap-5 px-4 pt-7 pb-24 md:px-10">
          <h1 className="font-display text-[clamp(32px,6vw,40px)] leading-[1.1] font-bold tracking-[-0.03em] break-words text-text">
            {name}
          </h1>
          <p data-testid="archived-notice" className="text-[15px] leading-relaxed text-text">
            {archivedNotice(site.updatedAt, site.purgeAfter)}
          </p>
          <Button asChild variant="secondary" className="self-start font-body font-medium">
            <a href={`/api/sites/${site.id}/download`} data-testid="download-page" download>
              <Download aria-hidden="true" strokeWidth={1.5} />
              Download
            </a>
          </Button>
        </main>
      </>
    );
  }

  const now = new Date();
  const [home, html, versions, visits] = await Promise.all([
    getDashboardSites(profile.id),
    readPreviewHtml(site, "site-detail"),
    listVersions(site.id, profile.id),
    readVisits(site.id, now),
  ]);

  return (
    <ClockProvider initialNow={now.getTime()}>
      <PageDetail
        site={{
          id: site.id,
          slug: site.slug,
          name,
          title: site.title,
          status: site.status,
          expiresAt: site.expiresAt,
          nameKind: site.nameKind,
          listedPublic: site.listedPublic,
          liveUrl: url,
          host,
        }}
        plan={profile.plan}
        quota={home.quota}
        names={home.names}
        nameQuota={limitsFor(profile.plan).chosenNames}
        // Every kept page the account has. Flagged or unserved ones are
        // listed and refused by `swapRefusal` inside the chooser, not dropped.
        candidates={home.kept.map((page) => ({
          id: page.id,
          name: pageName(page),
          slug: page.slug,
          liveUrl: liveUrl(page.slug),
          status: page.status,
          visits: page.visits,
        }))}
        baseDomain={servingBaseDomain()}
        html={html}
        previewTooLarge={site.sizeBytes !== null && site.sizeBytes > PREVIEW_MAX_BYTES}
        thumbnail={ogCardPath(site)}
        versions={versions}
        visits={visits}
        // Encoded HERE, so the encoder never reaches the client bundle.
        qr={<QrCode value={url} label={`QR code for ${host}`} />}
        qrSvg={qrSvg(url)}
      />
    </ClockProvider>
  );
}
