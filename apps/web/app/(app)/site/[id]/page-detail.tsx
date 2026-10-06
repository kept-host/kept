"use client";

/**
 * The page-detail screen — everything you can do to ONE page (PRD §5.2, §9.2).
 * E06 task 012.
 *
 * The skin is `kept Page Screen.dc.html` (`status: kept / draft / review`,
 * `mobile`), imported rather than redesigned: the 64px top bar, the title row
 * with its status chip and primary action, the sticky live preview with its
 * link chip and width toggle, and the tabbed settings column. The PRD's calls
 * on it:
 *
 *   · tabs **General · Visits · Versions** — the design's General / Stats /
 *     Versions; its Credit and Share kit tabs are later epics and are not in
 *     the tree (AC10). General holds the PRD's Details (title + the Explore
 *     flag — the design's Explore card), Name and link (its Address card),
 *     Share (QR + downloads) and the Danger zone. No password section.
 *   · on a phone, the page's thumbnail and "Open ↗" instead of the live frame.
 *   · the header's action is **Keep** / **Swap…** on a draft, none otherwise.
 *   · under review / quarantined: the banner, its appeal a `mailto:` to
 *     `ABUSE_CONTACT_EMAIL` naming the page until E07 builds the flow.
 *
 * ── WHAT THE STATUS ALLOWS (PRD §5.2 — the server enforces it; this mirrors) ──
 * Disallowed actions are ABSENT, never disabled — except the Explore toggle,
 * which stays, disabled, with the reason. The status is the EFFECTIVE one: a
 * draft whose clock ran out reads as expired on the next tick even while the
 * row still says `live` (edge case 12).
 *
 * Reads arrive as props from the server component; every mutation goes through
 * the owner client to a route handler, then `router.refresh()` (D17).
 */
import { useState, type ReactNode } from "react";
import { ArrowUpRight, Monitor, QrCode as QrIcon, Smartphone } from "lucide-react";

import { ABUSE_CONTACT_EMAIL, type KeptQuota, type NameKind, type Plan, type SiteStatus } from "@kept/shared";

import { draftCountdown } from "@/components/kept/draft-chip";
import { CopyLinkButton } from "@/components/kept/live-url";
import { PagePreview } from "@/components/kept/page-preview";
import type { SwapPage } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { VersionListItem } from "@/lib/db/queries/versions";
import { effectiveStatus, managementRefusal } from "@/lib/sites/display";
import type { VisitsView } from "@/lib/sites/visits-view";
import { cn } from "@/lib/utils";

import { useNow } from "../../dashboard/clock";
import { KeepAction } from "../../dashboard/keep-action";
import { Wordmark } from "../../wordmark";
import { BackLink, TOP_BAR } from "./back-link";
import { DangerZone } from "./danger-zone";
import { DetailsSection } from "./details-section";
import { NameSection } from "./name-section";
import { ShareSection } from "./share-section";
import { StatusChip } from "./status-chip";
import { VersionsPanel } from "./versions-panel";
import { VisitsPanel } from "./visits-panel";

/** The subject, serialised for the browser. */
export interface DetailSite {
  id: string;
  slug: string;
  /** `title ?? slug` — `pageName`. */
  name: string;
  title: string | null;
  status: SiteStatus;
  /** The draft clock; `null` ⇒ kept. */
  expiresAt: Date | null;
  nameKind: NameKind;
  listedPublic: boolean;
  /** `https://{slug}.{base}`, built on the server from configuration. */
  liveUrl: string;
  /** `{slug}.{base}`. */
  host: string;
}

/** The design's three listing helpers (`exploreNote`), by what the page is. */
const LISTING_NOTE = {
  flagged: "Paused while this page is under review.",
  draft: "Keep this page first. Only kept pages that passed safety checks can be listed.",
  kept: "Only kept pages that passed safety checks can be listed.",
} as const;

/** Where an appeal goes until E07 builds the flow: the one abuse address, naming the page. */
function appealHref(host: string): string {
  const subject = encodeURIComponent(`Review appeal: ${host}`);
  return `mailto:${ABUSE_CONTACT_EMAIL}?subject=${subject}`;
}

type Device = "desktop" | "mobile";

export function PageDetail({
  site,
  plan,
  quota,
  names,
  nameQuota,
  candidates,
  baseDomain,
  html,
  previewTooLarge,
  thumbnail,
  versions,
  visits,
  qr,
  qrSvg,
}: {
  site: DetailSite;
  plan: Plan;
  quota: KeptQuota;
  /** Chosen names in use (`chosenNameCount`). */
  names: number;
  nameQuota: number;
  /** The account's kept pages — the swap chooser's list. */
  candidates: SwapPage[];
  baseDomain: string;
  /** The page's bytes for the `srcdoc` preview, or `null`. */
  html: string | null;
  /** Why `html` is `null`: over `PREVIEW_MAX_BYTES`, rather than a failed read. */
  previewTooLarge: boolean;
  /** The OG card path — the phone's thumbnail. */
  thumbnail: string;
  versions: VersionListItem[];
  visits: VisitsView;
  /** The QR, rendered on the server. */
  qr: ReactNode;
  /** The same QR as a standalone SVG document. */
  qrSvg: string;
}) {
  const now = new Date(useNow());
  const [device, setDevice] = useState<Device>("desktop");

  const isDraft = site.expiresAt !== null;
  const shown = effectiveStatus(site.status, draftCountdown(site.expiresAt, now).phase === "expired");
  const live = shown === "live";
  const flagged = shown === "under_review" || shown === "quarantined";
  const can = {
    keep: isDraft && (live || shown === "expired"),
    change: live,
    title: live || shown === "under_review",
    keptLive: live && !isDraft,
    reachable: live || shown === "under_review",
  };
  const listingNote = flagged ? LISTING_NOTE.flagged : isDraft ? LISTING_NOTE.draft : LISTING_NOTE.kept;

  return (
    <>
      <header className={TOP_BAR}>
        <Wordmark className="text-[22px] md:hidden" />
        <BackLink />
        <span className="flex-1" />
        <Button asChild variant="secondary" className="h-10 px-3.5 font-body text-sm font-medium">
          {/* `noreferrer`: the page is stranger-authored HTML. */}
          <a href={site.liveUrl} target="_blank" rel="noopener noreferrer">
            Open
            <ArrowUpRight aria-hidden="true" strokeWidth={1.5} />
          </a>
        </Button>
      </header>

      <main className="flex flex-col gap-6 px-4 pt-7 pb-24 @container md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          {/* The page's title is untrusted stranger-authored input: React
              escapes it, and storage caps it at PAGE_TITLE_MAX_LENGTH. */}
          <h1 className="min-w-0 font-display text-[clamp(32px,6cqw,40px)] leading-[1.1] font-bold tracking-[-0.03em] break-words text-text">
            {site.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip shown={shown} expiresAt={site.expiresAt} now={now} />
            {can.keep ? (
              <KeepAction
                page={{ id: site.id, name: site.name, slug: site.slug, liveUrl: site.liveUrl, status: site.status }}
                atLimit={quota.remaining === 0}
                candidates={candidates}
                quota={quota}
                className="h-11 rounded-[var(--r-md)] px-[18px] text-[15px]"
              />
            ) : null}
          </div>
        </div>

        {/* Two columns once there is room for both (the design's 3 : 2), and
            only then is the preview sticky — a sticky column stacked ABOVE the
            settings would paint over them as they scroll past. */}
        <div className="flex flex-col gap-8 @min-[860px]:grid @min-[860px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @min-[860px]:items-start">
          <div className="flex min-w-0 flex-col gap-3 @min-[860px]:sticky @min-[860px]:top-[88px]">
            <LinkBar site={site} shown={shown} qr={qr} />

            <div className="hidden flex-col gap-3 rounded-[var(--r-lg)] border border-border bg-sunken p-3 md:flex">
              <div className="flex items-center justify-between gap-3">
                <span className="pl-1 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
                  Live preview
                </span>
                <div role="group" aria-label="Preview width" className="flex gap-0.5 rounded-[var(--r-sm)] bg-border p-0.5">
                  {(
                    [
                      ["desktop", "Desktop width", Monitor],
                      ["mobile", "Mobile width", Smartphone],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={device === value}
                      aria-label={label}
                      onClick={() => setDevice(value)}
                      className={cn(
                        "flex h-7 w-9 items-center justify-center rounded-[6px] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        device === value && "bg-surface",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-center">
                <PagePreview
                  liveUrl={site.liveUrl}
                  html={html}
                  className={cn(
                    "rounded-[var(--r-md)] shadow-[var(--shadow-md)] motion-safe:transition-[width] motion-safe:duration-200",
                    device === "mobile" ? "w-[300px] max-w-full" : "w-full",
                  )}
                  frameClassName={device === "mobile" ? "h-[540px] w-full" : "h-[420px] w-full"}
                />
              </div>
              {html === null ? (
                <p className="px-1 text-xs leading-relaxed text-text-secondary">
                  {previewTooLarge
                    ? "This page is too large to render here. Open it at its link to see it — the page itself is unaffected."
                    : "kept couldn't read this page's file just now, so there is nothing to render. The page itself is unaffected."}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 md:hidden">
              {/* eslint-disable-next-line @next/next/no-img-element -- the OG
                  card is our own immutable route, sized by its own dimensions. */}
              <img
                src={thumbnail}
                alt=""
                width={1200}
                height={630}
                className="h-auto w-full rounded-[var(--r-md)] border border-border bg-sunken"
              />
              <Button asChild variant="secondary" className="h-11 font-body text-sm font-medium">
                <a href={site.liveUrl} target="_blank" rel="noopener noreferrer">
                  Open ↗<span className="sr-only"> {site.host}</span>
                </a>
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {flagged ? (
              <div
                role="status"
                data-testid="review-banner"
                className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[color-mix(in_srgb,var(--warning)_45%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] px-5 py-4"
              >
                <span className="text-[15px] font-medium text-text">This page is under review.</span>
                <span className="text-sm leading-relaxed text-pretty text-text">{managementRefusal(shown)}</span>
                <a
                  href={appealHref(site.host)}
                  data-testid="appeal-link"
                  className="self-start font-mono text-xs text-text underline underline-offset-[3px] outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Appeal this review
                </a>
              </div>
            ) : null}

            <Tabs defaultValue="general" className="gap-4">
              <TabsList
                aria-label="Page settings"
                className="sticky top-16 z-10 flex h-auto w-full justify-start overflow-x-auto rounded-[var(--r-md)] border border-border"
              >
                {(
                  [
                    ["general", "General"],
                    ["visits", "Visits"],
                    ["versions", "Versions"],
                  ] as const
                ).map(([value, label]) => (
                  <TabsTrigger key={value} value={value} className="h-9 flex-[1_0_auto] text-text-secondary">
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="general" className="flex flex-col gap-4">
                <DetailsSection
                  siteId={site.id}
                  title={site.title}
                  fallbackName={site.slug}
                  listedPublic={site.listedPublic}
                  canEditTitle={can.title}
                  canList={can.keptLive}
                  listingNote={listingNote}
                />
                <NameSection
                  siteId={site.id}
                  slug={site.slug}
                  baseDomain={baseDomain}
                  nameChosen={site.nameKind === "chosen"}
                  canRename={can.keptLive}
                  isDraft={isDraft}
                  names={names}
                  nameQuota={nameQuota}
                />
                <ShareSection
                  siteId={site.id}
                  slug={site.slug}
                  host={site.host}
                  qr={qr}
                  qrSvg={qrSvg}
                  reachable={can.reachable}
                />
                <DangerZone
                  siteId={site.id}
                  slug={site.slug}
                  name={site.name}
                  host={site.host}
                  nameChosen={site.nameKind === "chosen"}
                  canDemote={can.keptLive}
                />
              </TabsContent>

              <TabsContent value="visits">
                <VisitsPanel view={visits} />
              </TabsContent>

              <TabsContent value="versions">
                <VersionsPanel
                  siteId={site.id}
                  host={site.host}
                  plan={plan}
                  versions={versions}
                  canChange={can.change}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </>
  );
}

/**
 * The link chip over the preview: status dot, the address in mono, Copy, QR
 * and Open (the design's pill). The QR opens in a popover; its downloads live
 * in General → Share.
 */
function LinkBar({ site, shown, qr }: { site: DetailSite; shown: SiteStatus; qr: ReactNode }) {
  const flagged = shown === "under_review" || shown === "quarantined";
  const dot = flagged ? "bg-warning" : shown === "live" && site.expiresAt === null ? "bg-live" : "bg-text-muted";
  const ICON = "size-9 rounded-[var(--r-pill)] p-0 text-text hover:bg-sunken [&_svg]:size-4";

  return (
    <div className="flex h-11 min-w-0 items-center gap-2 rounded-[var(--r-pill)] border border-border bg-surface pr-1 pl-3.5">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dot)} />
      <span data-testid="link-chip" className="min-w-0 flex-1 truncate font-mono text-[13px] text-text">
        {site.host}
      </span>
      <CopyLinkButton
        liveUrl={site.liveUrl}
        variant="ghost"
        className="h-9 rounded-[var(--r-pill)] px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-text [&_svg]:size-4"
        label={<span className="sr-only">Copy link</span>}
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" aria-label="Show QR code" className={ICON}>
            <QrIcon aria-hidden="true" strokeWidth={1.5} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-[220px] flex-col items-center gap-3 rounded-[var(--r-lg)]">
          {qr}
          <span className="text-center text-[13px] text-text-secondary">
            Scan to open <span className="font-mono text-text">{site.host}</span>
          </span>
        </PopoverContent>
      </Popover>
      <Button asChild variant="ghost" className={ICON}>
        <a href={site.liveUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab">
          <ArrowUpRight aria-hidden="true" strokeWidth={1.5} />
        </a>
      </Button>
    </div>
  );
}
