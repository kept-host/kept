"use client";

/**
 * One page, as a card — E06 task 010 (PRD §8). Built here, mounted by 011/012.
 *
 * The skin is Claude Design's (`kept Page Card.dc.html` and the card markup in
 * `kept Studio Screen.dc.html`), wired to props. Four studio variants:
 *
 *   · `grid`       — the kept wall's card: thumbnail, status dot, title,
 *                    address, 7-day visits; actions top right on hover / focus
 *                    (always on touch).
 *   · `list`       — the same facts as one row (`?view=list`). The design has
 *                    no list row, so it is built from the card's own language.
 *   · `draft`      — a draft as a card: thumbnail band with the countdown chip,
 *                    title, address, when it was published, and its actions.
 *                    Last `DRAFT_URGENT_HOURS` → `--warning` chip; an expired
 *                    draft in grace is muted and says how long is left.
 *   · `draft-list` — the same draft as one row, the drafts tab's default: many
 *                    drafts read better as a list than as a wall of cards.
 *
 * A draft in the drafts tab's Select mode carries a `selector` (its checkbox)
 * and, once ticked, `selected` — the accent ring.
 *
 * ── SHAPED FOR VARIANTS THAT DO NOT EXIST YET ────────────────────────────────
 * `variant` discriminates a union, the link target arrives as `href`, and the
 * controls arrive as an `actions` slot — nothing here imports a verb. E12's
 * `wall` and E15's `explore` add a member and a case; they link publicly and
 * bring their own slot contents, and these three stay as they are.
 *
 * ── THE THUMBNAIL IS THE OG CARD ─────────────────────────────────────────────
 * `<img src={ogCardPath(site)}>` with the card's own dimensions reserved — the
 * one Satori card (D10), keyed on `updated_at`, so a rename or a title edit
 * shows up here the moment the row moves. Under it, the page's own gradient
 * (`ogTheme(site.id)`, task 016 — the same one the card is drawn on) as inline
 * style data, so a card is never blank while the PNG loads or if it fails.
 *
 * ── THE PAGE ITSELF, ON HOVER (task 016) ─────────────────────────────────────
 * A grid or draft card handed a `preview` loader shows the live page over its
 * thumbnail while a mouse rests on it (`hover-preview.tsx`): sandboxed
 * `srcdoc`, scaled from a desktop width, `pointer-events-none` so a click still
 * lands on the thumbnail's link. The list row takes none — at 96 px wide a page
 * is noise, not a preview.
 *
 * ── THE CLOCK IS THE SCREEN'S, NOT THE CARD'S ────────────────────────────────
 * A draft's countdown reads `useNow()` — the screen's one minute ticker in
 * `app/(app)/dashboard/clock.tsx` — so a wall of drafts is one interval, not
 * twenty. It flips to expired when `expires_at` passes even while the row still
 * says `live` (edge case 12): the phase comes from the clock, never `status`.
 *
 * ── ARRIVING (E06 task 015) ──────────────────────────────────────────────────
 * The design's `publish()` / `keep()` with the landing's live moment: a card
 * that just landed rises in (the design's kUp), pulses one accent ring, then
 * wears the steady ring, with the landing's pulsing LIVE badge on a live page.
 * A freshly published one also says "Just published", and "New" where visits
 * would be. The screen decides when a card is arriving and for how long.
 * Every movement is `motion-safe:`; the hover lift is the design's 160 ms on
 * `translate` (what Tailwind's translate utilities set) and `box-shadow`.
 *
 * Not rendered, by design (AC10): likes, remixes, the creator, the wall link,
 * "Made with {model}", the EXPLORE pill and the FEATURED variant — all later
 * epics.
 */
import Link from "next/link";
import { type ReactNode, useState } from "react";

import { type SiteStatus, VISITS_RECENT_DAYS } from "@kept/shared";

import { useNow } from "@/app/(app)/dashboard/clock";
import { DraftChip, draftCountdown } from "@/components/kept/draft-chip";
import { HoverPreview, type PreviewLoader, useHoverPreview } from "@/components/kept/hover-preview";
import { STATUS_LABEL } from "@/components/kept/live-url";
import { Badge } from "@/components/ui/badge";
import { OG_CARD_HEIGHT, OG_CARD_WIDTH, type OgCardSubject, ogCardPath } from "@/lib/og/card-url";
import { ogTheme } from "@/lib/og/palette";
import {
  expiredDraftNotice,
  formatTimestamp,
  isDraftUrgent,
  JUST_PUBLISHED,
  pageName,
  publishedLabel,
  visitsLabel,
} from "@/lib/sites/display";
import { cn } from "@/lib/utils";

/**
 * How a card is arriving: `published` (a new page — rise, chip, "New"), `kept`
 * (a draft that just moved to the wall — rise) or `duplicate` (an existing page
 * a same-bytes publish pointed at — it is already on screen, so no rise).
 */
export type CardArrival = "published" | "kept" | "duplicate";

/** What a card needs from a row. Structurally satisfied by `OwnedSite`. */
export interface SiteCardSite extends OgCardSubject {
  slug: string;
  /** The first publish — a draft's "Published 3 Oct". */
  createdAt: Date;
  /** Render `title ?? slug` — `pageName`. */
  title: string | null;
  status: SiteStatus;
  /** The draft clock. Set ⇒ draft. */
  expiresAt: Date | null;
  /** End of the draft's grace window. */
  purgeAfter: Date | null;
}

interface SiteCardBase {
  site: SiteCardSite;
  /** Where the card goes. The studio passes the page-detail link. */
  href: string;
  /** `{name}.{base}` as shown — built by the caller from configuration. */
  host: string;
  /** The card's controls (copy / open / menu, or Keep / Swap…). A slot, never an import. */
  actions?: ReactNode;
  /** The card is arriving — see ARRIVING above. Absent once it has settled. */
  arrival?: CardArrival;
  className?: string;
}

/** A draft, which the drafts tab can select. */
interface Selectable {
  /** Its checkbox, in Select mode. A slot, like `actions`. */
  selector?: ReactNode;
  /** Ticked in Select mode: the accent ring. */
  selected?: boolean;
}

/** A card that can show the page itself on hover. */
interface Previewable {
  /**
   * Reads the page's HTML for the hover preview. Absent: no preview — the page
   * is not live, too large to inline, or this surface has no way to read it.
   */
  preview?: PreviewLoader;
}

export type SiteCardProps =
  | (SiteCardBase &
      Previewable & {
        variant: "grid";
        /** The `VISITS_RECENT_DAYS` sum; `null`/absent when there is no data yet. */
        visits?: number | null;
      })
  | (SiteCardBase & {
      variant: "list";
      visits?: number | null;
    })
  | (SiteCardBase & Previewable & Selectable & { variant: "draft" })
  | (SiteCardBase & Selectable & { variant: "draft-list" });

export function SiteCard(props: SiteCardProps) {
  switch (props.variant) {
    case "grid":
      return <GridCard {...props} />;
    case "list":
      return <ListRow {...props} />;
    case "draft":
      return <DraftCard {...props} />;
    case "draft-list":
      return <DraftRow {...props} />;
  }
}

/** How a flagged page, or an expired draft, recedes on its card (the design's `dim`). */
const MUTED = "opacity-50";

/** The statuses E07 writes that a card states in a chip (PRD §9.1); order unchanged. */
function isFlagged(status: SiteStatus): boolean {
  return status === "under_review" || status === "quarantined";
}

/** The title-row dot: `--live` when serving, `--warning` when flagged. */
function StatusDot({ status }: { status: SiteStatus }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "live" ? "bg-live" : isFlagged(status) ? "bg-warning" : "bg-text-muted",
      )}
    />
  );
}

/** "Under review", on the thumbnail of a flagged page. */
function FlagChip({ status, className }: { status: SiteStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-6 bg-surface text-text", className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * The thumbnail: the page's gradient, the OG card over it, and — while a mouse
 * rests on the card — the page itself over both.
 *
 * The link is a pointer convenience only — out of the tab order and hidden from
 * assistive tech, because the title link beside it is the one named, focusable
 * way to the same place. The preview is its sibling, not its child (an iframe
 * may not sit inside a link), and lets every click through to it.
 */
function Thumbnail({
  site,
  href,
  preview = null,
  className,
}: {
  site: SiteCardSite;
  href: string;
  /** The page's HTML while its hover preview is showing. */
  preview?: string | null;
  className?: string;
}) {
  const src = ogCardPath(site);
  // A card URL that failed to load is dropped, so the gradient shows instead of
  // a browser's broken-image glyph. A new URL (the row moved) is tried afresh.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <div
      data-testid="card-thumbnail"
      className={cn("relative overflow-hidden", className)}
      style={{ backgroundImage: ogTheme(site.id).image }}
    >
      <Link href={href} tabIndex={-1} aria-hidden="true" className="block size-full">
        {failedSrc === src ? null : (
          // The OG card is already a sized, immutable PNG; nothing for next/image to do.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            width={OG_CARD_WIDTH}
            height={OG_CARD_HEIGHT}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSrc(src)}
            className="size-full object-cover"
          />
        )}
      </Link>
      {preview === null ? null : <HoverPreview html={preview} name={pageName(site)} />}
    </div>
  );
}

function TitleLink({ name, href }: { name: string; href: string }) {
  return (
    <Link
      href={href}
      className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] text-[15px] font-medium leading-snug text-text outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {name}
    </Link>
  );
}

/** The visits sum — or, on a fresh card that has none yet, "New" (the design's label). */
function Visits({ visits, fresh }: { visits: number | null | undefined; fresh: boolean }) {
  if (visits === null || visits === undefined) {
    return fresh ? <span className="whitespace-nowrap font-mono text-xs text-text-secondary">New</span> : null;
  }
  return (
    <span
      title={`Visits in the last ${VISITS_RECENT_DAYS} days`}
      className="whitespace-nowrap font-mono text-xs text-text-secondary"
    >
      {visitsLabel(visits)}
    </span>
  );
}

const CARD_SURFACE =
  "relative min-w-0 rounded-[var(--r-lg)] border border-border bg-surface shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] motion-safe:hover:-translate-y-0.5 motion-safe:transition-[box-shadow,translate] motion-safe:duration-160 motion-safe:ease-[ease]";

/** A ticked draft in Select mode. */
const SELECTED = "ring-2 ring-accent";

/** "Published 3 Oct", with the full stamp on hover and for machines. */
function PublishedOn({ at }: { at: Date }) {
  return (
    <time dateTime={at.toISOString()} title={formatTimestamp(at)} className="whitespace-nowrap">
      {publishedLabel(at)}
    </time>
  );
}

/** What a draft's clock says now: the phase, and whether the chip turns `--warning`. */
function useDraftClock(expiresAt: Date | null) {
  const now = new Date(useNow());
  return {
    now,
    expired: expiresAt !== null && draftCountdown(expiresAt, now).phase === "expired",
    urgent: expiresAt !== null && isDraftUrgent(expiresAt, now),
  };
}

/** The countdown chip, `--warning`-tinted in the draft's last hours. */
function Countdown({
  expiresAt,
  now,
  urgent,
  className,
}: {
  expiresAt: Date;
  now: Date;
  urgent: boolean;
  className?: string;
}) {
  return (
    <DraftChip
      expiresAt={expiresAt}
      now={now}
      className={cn(
        "h-6 whitespace-nowrap px-2.5 py-0 text-text shadow-none",
        urgent &&
          "border-[color-mix(in_srgb,var(--warning)_55%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_24%,var(--surface))]",
        className,
      )}
    />
  );
}

/** The arriving card's classes: the steady ring, and the rise unless it was already here. */
function arrivalClasses(arrival: CardArrival | undefined): string | false {
  return (
    arrival !== undefined &&
    cn(
      "ring-2 ring-accent",
      arrival !== "duplicate" && "motion-safe:animate-[keptRise_250ms_var(--ease-out)_both]",
    )
  );
}

/**
 * One accent ring that expands and fades as the card lands, after its rise. Its
 * own element, so the pulse never fights the card's box-shadow (the hover
 * shadow, the steady ring).
 */
function RingPulse() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -inset-px rounded-[inherit] motion-safe:animate-[keptRingPulse_700ms_var(--ease-out)_250ms_both]"
    />
  );
}

/** The landing's LIVE badge, on a live page while it arrives. The status dot already says "Live". */
function LiveBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-badge"
      className={cn(
        "pointer-events-none inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--text)_70%,transparent)] px-2 py-1 font-mono text-[10px] font-medium leading-none tracking-[0.08em] text-bg backdrop-blur-sm",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-live motion-safe:animate-[keptLive_2s_ease-in-out_infinite]" />
      LIVE
    </span>
  );
}

/** "Just published" — the design's kicker, as a chip while a new card arrives. */
function FreshChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-accent-soft px-[7px] font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-accent-hover",
        className,
      )}
    >
      {JUST_PUBLISHED}
    </span>
  );
}

function GridCard({
  site,
  href,
  host,
  actions,
  arrival,
  visits,
  preview,
  className,
}: Extract<SiteCardProps, { variant: "grid" }>) {
  const flagged = isFlagged(site.status);
  const fresh = arrival === "published";
  const hover = useHoverPreview(site, preview);

  return (
    <article
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      className={cn(CARD_SURFACE, "group", arrivalClasses(arrival), className)}
    >
      {arrival ? <RingPulse /> : null}
      <Thumbnail
        site={site}
        href={href}
        preview={hover.html}
        className={cn(
          "aspect-[16/10] rounded-t-[calc(var(--r-lg)-1px)] border-b border-border",
          flagged && MUTED,
        )}
      />

      {flagged ? <FlagChip status={site.status} className="absolute left-2.5 top-2.5" /> : null}
      {/* Sized to sit over the OG card's wordmark corner rather than half on it. */}
      {arrival && site.status === "live" ? (
        <LiveBadge className="absolute left-1.5 top-1.5 px-2.5 py-1.5" />
      ) : null}

      {actions ? (
        <div className="absolute right-2.5 top-2.5 flex gap-1.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          {actions}
        </div>
      ) : null}

      <div className="flex flex-col gap-0.5 px-3.5 pb-3.5 pt-3">
        <div className={cn("flex items-center gap-2", flagged && MUTED)}>
          <StatusDot status={site.status} />
          <TitleLink name={pageName(site)} href={href} />
        </div>
        <p className={cn("truncate font-mono text-xs text-text-secondary", flagged && MUTED)}>
          {host}
        </p>
        {fresh || (visits !== null && visits !== undefined) ? (
          <div className="mt-2 flex items-center justify-end gap-2">
            {fresh ? <FreshChip className="mr-auto" /> : null}
            <Visits visits={visits} fresh={fresh} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ListRow({
  site,
  href,
  host,
  actions,
  arrival,
  visits,
  className,
}: Extract<SiteCardProps, { variant: "list" }>) {
  const flagged = isFlagged(site.status);
  const fresh = arrival === "published";

  return (
    <article className={cn(CARD_SURFACE, "flex items-center gap-3 p-2 pr-3", arrivalClasses(arrival), className)}>
      {arrival ? <RingPulse /> : null}
      {arrival && site.status === "live" ? <LiveBadge className="absolute left-3 top-3 px-1.5" /> : null}
      <Thumbnail
        site={site}
        href={href}
        className={cn(
          "aspect-[16/10] w-24 shrink-0 rounded-[var(--r-sm)] border border-border",
          flagged && MUTED,
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <StatusDot status={site.status} />
          <TitleLink name={pageName(site)} href={href} />
          {flagged ? <FlagChip status={site.status} className="shrink-0" /> : null}
        </div>
        <p className="truncate font-mono text-xs text-text-secondary">{host}</p>
      </div>

      {/* A phone's row has no room for the chip beside the title; "New", the
          ring and the LIVE badge carry the arrival there. */}
      {fresh ? <FreshChip className="max-md:hidden" /> : null}
      <Visits visits={visits} fresh={fresh} />
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </article>
  );
}

function DraftCard({
  site,
  href,
  host,
  actions,
  arrival,
  preview,
  selector,
  selected,
  className,
}: Extract<SiteCardProps, { variant: "draft" }>) {
  // A draft card is only ever handed a draft; a row whose clock was cleared
  // since the render (kept elsewhere) simply shows no chip.
  const expiresAt = site.expiresAt;
  const { now, expired, urgent } = useDraftClock(expiresAt);
  const flagged = isFlagged(site.status);
  // A draft whose clock ran out on screen stops serving, so it stops previewing.
  const hover = useHoverPreview(site, expired ? undefined : preview);

  return (
    <article
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      className={cn(CARD_SURFACE, arrivalClasses(arrival), selected && SELECTED, className)}
    >
      {arrival ? <RingPulse /> : null}
      {/* The band clips to the card's corners itself, so the ring pulse can
          spread past the card. */}
      <div className="relative overflow-hidden rounded-t-[calc(var(--r-lg)-1px)]">
        <Thumbnail
          site={site}
          href={href}
          preview={hover.html}
          className={cn(
            // The band shows the card's brand row: the chip sits bottom left,
            // where a cropped headline would otherwise run underneath it.
            "h-[88px] border-b border-border [&_img]:object-top",
            (expired || flagged) && MUTED,
          )}
        />
        {flagged ? <FlagChip status={site.status} className="absolute left-2.5 top-2.5" /> : null}
        {arrival === "published" && !flagged ? <FreshChip className="absolute left-2.5 top-2.5" /> : null}
        {selector ? <div className="absolute right-1.5 top-1.5">{selector}</div> : null}
        {expiresAt ? (
          <Countdown expiresAt={expiresAt} now={now} urgent={urgent} className="absolute bottom-2.5 left-2.5" />
        ) : null}
      </div>

      <div className="flex items-center gap-3 py-3 pl-3.5 pr-3">
        <div className="flex min-w-0 flex-1 flex-col leading-snug">
          <div className={cn("flex min-w-0 flex-col", expired && MUTED)}>
            <TitleLink name={pageName(site)} href={href} />
            <p className="truncate font-mono text-xs text-text-secondary">{host}</p>
          </div>
          <p className="mt-1 text-[13px] text-text-secondary">
            <PublishedOn at={site.createdAt} />
          </p>
          {/* Not muted: how long is left to keep it is the one thing to read. */}
          {expired && expiresAt ? (
            <p className="text-[13px] text-text-secondary">
              {expiredDraftNotice(expiresAt, site.purgeAfter, now)}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
    </article>
  );
}

/**
 * A draft as one row — the drafts tab's list. The countdown chip sits on the
 * meta line beside "Published …", so a phone keeps both without a second row
 * of controls.
 */
function DraftRow({
  site,
  href,
  host,
  actions,
  arrival,
  selector,
  selected,
  className,
}: Extract<SiteCardProps, { variant: "draft-list" }>) {
  const expiresAt = site.expiresAt;
  const { now, expired, urgent } = useDraftClock(expiresAt);
  const flagged = isFlagged(site.status);

  return (
    <article
      className={cn(
        CARD_SURFACE,
        "flex items-center gap-3 p-2 pr-3",
        arrivalClasses(arrival),
        selected && SELECTED,
        className,
      )}
    >
      {arrival ? <RingPulse /> : null}
      {selector}
      <Thumbnail
        site={site}
        href={href}
        className={cn(
          // A phone gives the row's width to the name and the two actions.
          "aspect-[16/10] w-24 shrink-0 rounded-[var(--r-sm)] border border-border max-sm:hidden",
          (expired || flagged) && MUTED,
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className={cn("flex items-center gap-2", expired && MUTED)}>
          <TitleLink name={pageName(site)} href={href} />
          {flagged ? <FlagChip status={site.status} className="shrink-0" /> : null}
          {arrival === "published" && !flagged ? <FreshChip className="max-md:hidden" /> : null}
        </div>
        <p className={cn("truncate font-mono text-xs text-text-secondary", expired && MUTED)}>{host}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-secondary">
          {expiresAt ? <Countdown expiresAt={expiresAt} now={now} urgent={urgent} /> : null}
          <PublishedOn at={site.createdAt} />
        </div>
        {expired && expiresAt ? (
          <p className="text-[13px] text-text-secondary">{expiredDraftNotice(expiresAt, site.purgeAfter, now)}</p>
        ) : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </article>
  );
}
