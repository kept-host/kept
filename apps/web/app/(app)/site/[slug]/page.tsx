/**
 * `(app)/site/[slug]` — everything you can do to ONE page, in one place.
 * E06 task 008.
 *
 * ── IT IS IN THE `(app)` GROUP, AND THAT IS THE WHOLE GATE ───────────────────
 * `app/(app)/layout.tsx` calls `requireSession()` for every route in the group,
 * which is why this file calls no gate of its own: "every route added under
 * `(app)` is gated the moment it exists, without its page remembering to call
 * anything." A copy of the check here would be a second thing to keep in step,
 * and putting the route at the top level to keep the URL short would ship an
 * ungated authenticated screen that renders a stranger's HTML.
 *
 * ── THE OWNER SCOPE IS IN THE SQL ────────────────────────────────────────────
 * `getOwnedSiteBySlug(profileId, slug)` puts `owner_id` in the WHERE clause. A
 * slug that belongs to somebody else returns `null`, byte-identical to a slug
 * that never existed, and both land on the ordinary `notFound()`. There is no
 * "you don't own this" anywhere on this route: that sentence is an existence
 * oracle, and this screen previews the page's actual bytes.
 *
 * ── TWO READS, ONE ROUND TRIP, AND WHY THE SECOND ONE IS NOT REDUNDANT ───────
 * The subject comes from the owner-scoped slug lookup, which is the authority
 * for the 404. The account's kept pages and its allowance come from
 * `getDashboardSites`, because at the cap the Keep button opens task 007's swap
 * chooser and that chooser needs candidates — pages this route otherwise has no
 * reason to know about. They run concurrently, so the screen still costs one
 * round trip of latency.
 *
 * ── THE OG CARD IS WIRED HERE ────────────────────────────────────────────────
 * `ogCardPath` (task 010) shipped with no call sites; this is one of them. The
 * revision token in its query string is what makes the card's year-long
 * `immutable` cache honest, and its draft/kept half matters on exactly this
 * screen: keeping a page flips the chip without moving `current_version_id`.
 *
 * DESIGNED FROM TOKENS, NOT IMPORTED. `kept Site Detail.dc.html` was not
 * available to this task; the screen is composed from `globals.css`'s tokens and
 * the existing kept components in the house language — editorial display type,
 * hairline rules, mono meta-labels, accent reserved for the one thing that has
 * been chosen. A later reconciliation pass against the export is a known
 * follow-up.
 */
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { QrCode } from "@/components/kept/qr";
import { getSession } from "@/lib/auth/session";
import { getDashboardSites, getOwnedSiteBySlug } from "@/lib/db/queries/dashboard";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { ogCardPath } from "@/lib/og/card-url";
import { liveUrl } from "@/lib/publish/pipeline";
import { PREVIEW_MAX_BYTES, readPreviewHtml } from "@/lib/publish/preview";
import { formatBytes, formatUpdatedAt, pageName } from "@/lib/sites/display";
import { appOrigin } from "@/lib/storage/env";

import { ClockProvider } from "../../dashboard/clock";
import { SiteDetail } from "./site-detail";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/**
 * The subject row, resolved once per request.
 *
 * `generateMetadata` and the component below both need it, and Next calls them
 * separately. `cache()` is React's per-request memo, so the owner-scoped lookup
 * runs once instead of twice — which also guarantees the two cannot disagree
 * about whether the page exists.
 */
const subject = cache(async (slug: string) => {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return null;
  const site = await getOwnedSiteBySlug(profile.id, slug);
  return site ? { profileId: profile.id, site } : null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const found = await subject(slug);

  // A missing page gets metadata for the 404 it is about to render. Naming the
  // slug in the title of a page the reader does not own would answer the
  // question `notFound()` exists to refuse.
  if (!found) return { title: "Page not found", robots: { index: false, follow: false } };

  return {
    title: pageName(found.site),
    description: `Manage ${found.site.slug} — rename it, replace the file, keep it forever or delete it.`,
    // A per-account management screen. A manage URL in a search index is
    // somebody's rename button sitting in a results list.
    robots: { index: false, follow: false },
    // `ogCardPath` is app-relative on purpose, so it needs a base to resolve
    // against. Read from configuration, NEVER derived from the request: on
    // Railway `new URL(request.url)` is the listen address, which is the bug
    // class `lib/routing/configured-origins.test.ts` guards. Absent or
    // malformed configuration drops the base rather than throwing — a card is
    // worth zero 500s on a screen that manages real pages.
    metadataBase: configuredBase(),
    openGraph: {
      title: pageName(found.site),
      // The card the route mints for this exact row, at the URL that changes
      // whenever the card would: a replace moves `current_version_id`, and
      // keeping the page flips the draft/kept half without touching it.
      images: [{ url: ogCardPath(found.site) }],
    },
  };
}

/**
 * A date as the aside renders it: the pinned human label and the machine
 * instant, formatted HERE so the server's string and the hydrated one cannot
 * differ.
 */
function stamp(date: Date): { label: string; iso: string } {
  return { label: formatUpdatedAt(date), iso: date.toISOString() };
}

function configuredBase(): URL | undefined {
  try {
    return new URL(appOrigin());
  } catch {
    return undefined;
  }
}

export default async function SiteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  /**
   * `?renamedFrom=` is where a successful rename lands its own navigation, so
   * the success copy survives the remount that navigation causes. Read here and
   * handed down as a prop, exactly as `/settings` does with `?linked=`, so no
   * client component parses the URL itself.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const params_ = await searchParams;
  const renamedFromParam = params_.renamedFrom;
  const renamedFrom = Array.isArray(renamedFromParam)
    ? (renamedFromParam[0] ?? null)
    : (renamedFromParam ?? null);

  // A read, not a gate — the group layout already turned a signed-out visitor
  // away. `null` here is "no such page of yours", and says nothing more.
  const found = await subject(slug);
  if (!found) notFound();

  const { profileId, site } = found;

  const [{ kept, quota }, html] = await Promise.all([
    getDashboardSites(profileId),
    readPreviewHtml(site, "site-detail"),
  ]);

  const url = liveUrl(site.slug);
  const name = pageName(site);
  const size = formatBytes(site.sizeBytes);
  // The one honest reason a preview can be absent that is not a failure.
  const tooLarge = site.sizeBytes !== null && site.sizeBytes > PREVIEW_MAX_BYTES;

  // One reading of the clock for the whole screen, taken here so the server's
  // countdown label and the first client render agree exactly.
  const now = Date.now();

  return (
    <ClockProvider initialNow={now}>
      <main className="mx-auto w-full max-w-[1100px] px-6 pb-28 pt-10 md:px-8 md:pt-14">
        <Link
          href="/dashboard"
          className="mono-label inline-flex items-center gap-2 rounded-[var(--r-sm)] text-[11px] text-text-muted outline-none hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          All pages
        </Link>

        <SiteDetail
          site={{
            id: site.id,
            name,
            slug: site.slug,
            liveUrl: url,
            status: site.status,
            expiresAt: site.expiresAt?.toISOString() ?? null,
          }}
          size={size}
          // Null when the row's current version has gone missing — the LEFT
          // join keeps such a page on its owner's screens, and the aside says
          // "not recorded" rather than borrowing the row's own stamp and
          // calling it the file's.
          fileWrittenAt={
            site.versionCreatedAt ? stamp(site.versionCreatedAt) : null
          }
          changedAt={stamp(site.updatedAt)}
          // The bytes cross ONCE and are used twice — the sandboxed preview
          // frame and the download control both read this one string. Rendering
          // `PagePreview` on the server and *also* handing the download its own
          // copy would put up to `PREVIEW_MAX_BYTES` in the RSC payload twice;
          // `PagePreview` is presentational and imports nothing server-only, so
          // the client component below can render it from the same value.
          html={html}
          previewTooLarge={tooLarge}
          quota={quota}
          // Every clockless page the account owns — the chooser's candidate
          // list. Not filtered on status here: `swapRefusal` disables and
          // explains the ones that cannot free a slot, because a kept page that
          // silently vanishes from the list reads as a page that has gone.
          candidates={kept.map((page) => ({
            id: page.id,
            name: pageName(page),
            slug: page.slug,
            liveUrl: liveUrl(page.slug),
            status: page.status,
          }))}
          // The QR is rendered HERE, on the server, so the encoder never reaches
          // the client bundle — the same posture `/p/[anonToken]` takes. Task
          // 003 deferred it to this screen rather than pay for N encoded SVGs in
          // the wall's RSC payload.
          qr={<QrCode value={url} label={`QR code for ${url}`} />}
          renamedFrom={renamedFrom}
        />
      </main>
    </ClockProvider>
  );
}
