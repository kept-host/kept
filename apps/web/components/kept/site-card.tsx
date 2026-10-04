"use client";

/**
 * One page, as a card — E06 task 010 (PRD §8). Built here, mounted by 011/012.
 *
 * The skin is Claude Design's (`kept Page Card.dc.html` and the card markup in
 * `kept Studio Screen.dc.html`), wired to props. Three studio variants:
 *
 *   · `grid`  — the kept wall's card: thumbnail, status dot, title, address,
 *               7-day visits; actions top right on hover / focus (always on
 *               touch).
 *   · `list`  — the same facts as one row (`?view=list`). The design has no
 *               list row, so it is built from the card's own language.
 *   · `draft` — the drafts strip: thumbnail band with the countdown chip, title,
 *               address and one primary action. Last 48 h → `--warning` chip;
 *               an expired draft in grace is muted and says how long is left.
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
 * shows up here the moment the row moves. The design's per-page themes are
 * sample data and are not drawn.
 *
 * ── THE CLOCK IS THE SCREEN'S, NOT THE CARD'S ────────────────────────────────
 * A draft's countdown reads `useNow()` — the screen's one minute ticker in
 * `app/(app)/dashboard/clock.tsx` — so a wall of drafts is one interval, not
 * twenty. It flips to expired when `expires_at` passes even while the row still
 * says `live` (edge case 12): the phase comes from the clock, never `status`.
 *
 * Not rendered, by design (AC10): likes, remixes, the creator, the wall link,
 * "Made with {model}", the EXPLORE pill and the FEATURED variant — all later
 * epics.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { type SiteStatus, VISITS_RECENT_DAYS } from "@kept/shared";

import { useNow } from "@/app/(app)/dashboard/clock";
import { DraftChip, draftCountdown } from "@/components/kept/draft-chip";
import { STATUS_LABEL } from "@/components/kept/live-url";
import { Badge } from "@/components/ui/badge";
import { OG_CARD_HEIGHT, OG_CARD_WIDTH, type OgCardSubject, ogCardPath } from "@/lib/og/card-url";
import { expiredDraftNotice, isDraftUrgent, pageName, visitsLabel } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

/** What a card needs from a row. Structurally satisfied by `OwnedSite`. */
export interface SiteCardSite extends OgCardSubject {
  slug: string;
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
  /** Ring the card — the page a duplicate publish pointed at (PRD §5.1). */
  highlighted?: boolean;
  className?: string;
}

export type SiteCardProps =
  | (SiteCardBase & {
      variant: "grid";
      /** The `VISITS_RECENT_DAYS` sum; `null`/absent when there is no data yet. */
      visits?: number | null;
    })
  | (SiteCardBase & {
      variant: "list";
      visits?: number | null;
    })
  | (SiteCardBase & { variant: "draft" });

export function SiteCard(props: SiteCardProps) {
  switch (props.variant) {
    case "grid":
      return <GridCard {...props} />;
    case "list":
      return <ListRow {...props} />;
    case "draft":
      return <DraftCard {...props} />;
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
 * The thumbnail. The link is a pointer convenience only — out of the tab order
 * and hidden from assistive tech, because the title link beside it is the one
 * named, focusable way to the same place.
 */
function Thumbnail({ site, href, className }: { site: SiteCardSite; href: string; className?: string }) {
  return (
    <Link
      href={href}
      tabIndex={-1}
      aria-hidden="true"
      className={cn("block overflow-hidden bg-sunken", className)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- the OG card is
          already a sized, immutable PNG; there is nothing for next/image to do. */}
      <img
        src={ogCardPath(site)}
        alt=""
        width={OG_CARD_WIDTH}
        height={OG_CARD_HEIGHT}
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    </Link>
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

function Visits({ visits }: { visits: number | null | undefined }) {
  if (visits === null || visits === undefined) return null;
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
  "relative min-w-0 rounded-[var(--r-lg)] border border-border bg-surface shadow-[var(--shadow-sm)] motion-safe:transition-[box-shadow,transform] motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]";

function GridCard({
  site,
  href,
  host,
  actions,
  highlighted,
  visits,
  className,
}: Extract<SiteCardProps, { variant: "grid" }>) {
  const flagged = isFlagged(site.status);

  return (
    <article
      className={cn(
        CARD_SURFACE,
        "group hover:shadow-[var(--shadow-md)] motion-safe:hover:-translate-y-0.5",
        highlighted && "ring-2 ring-accent",
        className,
      )}
    >
      <Thumbnail
        site={site}
        href={href}
        className={cn(
          "aspect-[16/10] rounded-t-[calc(var(--r-lg)-1px)] border-b border-border",
          flagged && MUTED,
        )}
      />

      {flagged ? <FlagChip status={site.status} className="absolute left-2.5 top-2.5" /> : null}

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
        {visits !== null && visits !== undefined ? (
          <div className="mt-2 flex justify-end">
            <Visits visits={visits} />
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
  highlighted,
  visits,
  className,
}: Extract<SiteCardProps, { variant: "list" }>) {
  const flagged = isFlagged(site.status);

  return (
    <article
      className={cn(
        CARD_SURFACE,
        "flex items-center gap-3 p-2 pr-3 hover:shadow-[var(--shadow-md)]",
        highlighted && "ring-2 ring-accent",
        className,
      )}
    >
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

      <Visits visits={visits} />
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </article>
  );
}

function DraftCard({
  site,
  href,
  host,
  actions,
  highlighted,
  className,
}: Extract<SiteCardProps, { variant: "draft" }>) {
  const now = new Date(useNow());
  // A draft card is only ever handed a draft; a row whose clock was cleared
  // since the render (kept elsewhere) simply shows no chip.
  const expiresAt = site.expiresAt;
  const expired = expiresAt !== null && draftCountdown(expiresAt, now).phase === "expired";
  const urgent = expiresAt !== null && isDraftUrgent(expiresAt, now);
  const flagged = isFlagged(site.status);

  return (
    <article
      className={cn(
        CARD_SURFACE,
        "overflow-hidden",
        highlighted && "ring-2 ring-accent",
        className,
      )}
    >
      <div className="relative">
        <Thumbnail
          site={site}
          href={href}
          className={cn(
            // The band shows the card's brand row: the chip sits bottom left,
            // where a cropped headline would otherwise run underneath it.
            "h-[88px] border-b border-border [&_img]:object-top",
            (expired || flagged) && MUTED,
          )}
        />
        {flagged ? <FlagChip status={site.status} className="absolute left-2.5 top-2.5" /> : null}
        {expiresAt ? (
          <DraftChip
            expiresAt={expiresAt}
            now={now}
            className={cn(
              "absolute bottom-2.5 left-2.5 h-6 px-2.5 py-0 text-text shadow-none",
              urgent &&
                "border-[color-mix(in_srgb,var(--warning)_55%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_24%,var(--surface))]",
            )}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-3 py-3 pl-3.5 pr-3">
        <div className="flex min-w-0 flex-1 flex-col leading-snug">
          <div className={cn("flex min-w-0 flex-col", expired && MUTED)}>
            <TitleLink name={pageName(site)} href={href} />
            <p className="truncate font-mono text-xs text-text-secondary">{host}</p>
          </div>
          {/* Not muted: how long is left to keep it is the one thing to read. */}
          {expired && expiresAt ? (
            <p className="mt-1 text-[13px] text-text-secondary">
              {expiredDraftNotice(expiresAt, site.purgeAfter, now)}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
    </article>
  );
}
