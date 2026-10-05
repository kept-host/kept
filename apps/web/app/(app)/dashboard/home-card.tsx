"use client";

/**
 * One page on the Pages home: `SiteCard` inside its card-level drop target —
 * E06 task 011 (PRD §5.1, §5.5).
 *
 * Dropping a file on a card replaces that page (`POST /api/sites/:id/replace`,
 * task 007): "Drop to replace this page" while the file is held, then the
 * shared replace toast — "No changes…" for identical bytes, otherwise
 * "Replaced…" with Undo. Only a `live` page takes a drop: `under_review` and
 * `quarantined` refuse replace (edge case 10), so over them the window's
 * "Drop to publish" shows instead and the card says nothing it cannot do.
 *
 * An arriving card (the one a publish just made, a draft just kept, or the one
 * a duplicate publish pointed at — AC8) scrolls into view so the ring is seen,
 * and times its own arrival from the moment it MOUNTS — the rise, then the
 * design's 2.4 s ring — so a slow refresh never eats into it (task 015). A
 * draft that was just kept fades where it stands until the wall takes it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Ellipsis, Upload } from "lucide-react";
import { toast } from "sonner";

import type { Plan } from "@kept/shared";

import { type Browse, DropTarget } from "@/components/kept/drop-target";
import { copyLink } from "@/components/kept/link-toast";
import { CopyLinkButton } from "@/components/kept/live-url";
import { toastReplaced } from "@/components/kept/replace-toast";
import { SiteCard } from "@/components/kept/site-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DashboardSite } from "@/lib/db/queries/dashboard";
import { prefersReducedMotion } from "@/lib/motion";
import { pageName, siteHref } from "@/lib/sites/display";
import { replacePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import type { Arrival } from "./use-arrival";

/** An arrival lasts the card's rise (250 ms, `site-card.tsx`) plus the design's 2.4 s ring. */
const ARRIVAL_MS = 250 + 2400;

/**
 * Where an arriving card (or the mint card) scrolls to: clear of the sticky
 * 64 px top bar, and on a phone of the fixed tab bar.
 */
export const ARRIVAL_SCROLL_MARGIN = "scroll-mt-20 max-md:scroll-mb-28";

/** A page as the home renders it: the row, its visits and its public URL. */
export interface HomeSite extends DashboardSite {
  /** `https://{slug}.{base}` — built on the server from configuration. */
  liveUrl: string;
}

export type HomeCardVariant = "grid" | "list" | "draft";

export function HomeCard({
  site,
  variant,
  plan,
  arrival,
  onSettled,
  leaving = false,
  action,
}: {
  site: HomeSite;
  variant: HomeCardVariant;
  plan: Plan;
  /** This card is arriving (`useArrival().current`, when it names this card). */
  arrival?: Arrival;
  /** Called with the card's id when its arrival is over. Stable. */
  onSettled: (id: string) => void;
  /** A draft just kept: it fades until the wall takes it. */
  leaving?: boolean;
  /** A draft's primary action (Keep / Swap…). Kept cards get copy · open · replace. */
  action?: ReactNode;
}) {
  const router = useRouter();
  const [replacing, setReplacing] = useState(false);
  const itemRef = useRef<HTMLLIElement | null>(null);
  const host = new URL(site.liveUrl).host;
  const href = siteHref(site.id);
  const replaceable = site.status === "live";

  useEffect(() => {
    if (!arrival) return;
    itemRef.current?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    const timer = setTimeout(() => onSettled(arrival.id), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, [arrival, onSettled]);

  async function replace(file: File) {
    setReplacing(true);
    let html: string;
    try {
      html = await file.text();
    } catch {
      setReplacing(false);
      toast.error("That file could not be read. Try choosing it again.", { description: host });
      return;
    }
    const outcome = await replacePage(site.id, html);
    setReplacing(false);
    if (!outcome.ok) {
      toast.error(outcome.error.message, { description: host });
      return;
    }
    toastReplaced({ page: outcome.page, host, plan, refresh: () => router.refresh() });
  }

  const card = (browse: Browse) => {
    const actions =
      variant === "draft" ? (
        action
      ) : (
        <KeptActions
          name={pageName(site)}
          liveUrl={site.liveUrl}
          onReplace={replaceable ? browse : null}
          busy={replacing}
        />
      );
    const common = { site, href, host, actions, arrival: arrival?.kind };
    return variant === "draft" ? (
      <SiteCard variant="draft" {...common} />
    ) : (
      <SiteCard variant={variant} visits={site.visits} {...common} />
    );
  };

  return (
    <li
      ref={itemRef}
      data-testid="home-card"
      data-site-id={site.id}
      data-highlighted={arrival ? "true" : undefined}
      data-arrival={arrival?.kind}
      aria-busy={replacing || undefined}
      className={cn(
        "min-w-0 list-none motion-safe:transition-opacity motion-safe:duration-400 motion-safe:ease-[ease]",
        ARRIVAL_SCROLL_MARGIN,
        leaving && "opacity-55",
      )}
    >
      <DropTarget
        scope="card"
        host={host}
        disabled={!replaceable || replacing}
        onFile={replace}
        onRefuse={(message) => toast.error(message, { description: host })}
      >
        {card}
      </DropTarget>
    </li>
  );
}

const ICON_ACTION =
  "h-8 min-w-8 rounded-[var(--r-sm)] px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] shadow-[var(--shadow-sm)]";

/**
 * Copy link · Open ↗ · Replace file, from the design's card actions: buttons on
 * desktop, one ⋯ menu on a phone (the design's `mobile` card). The design's
 * menu also holds later epics' verbs (Share kit, List in Explore) and the
 * page-detail screen's (rename, make draft, delete) — none of which is wired
 * here. Replace file is the keyboard and touch path to the card's drop target.
 */
function KeptActions({
  name,
  liveUrl,
  onReplace,
  busy,
}: {
  name: string;
  liveUrl: string;
  /** Opens the file picker; `null` when the page cannot be replaced. */
  onReplace: Browse | null;
  busy: boolean;
}) {
  const host = new URL(liveUrl).host;

  return (
    <>
      <div className="hidden gap-1.5 md:flex">
        <CopyLinkButton
          liveUrl={liveUrl}
          variant="secondary"
          className={ICON_ACTION}
          label={<span className="sr-only">Copy link to {name}</span>}
        />
        <Button asChild variant="secondary" className={ICON_ACTION}>
          {/* `noreferrer`: the page is stranger-authored HTML and has no business
              reading where the click came from. */}
          <a href={liveUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${host} in a new tab`}>
            <ArrowUpRight aria-hidden="true" strokeWidth={1.5} />
          </a>
        </Button>
        {onReplace ? (
          <Button
            type="button"
            variant="secondary"
            className={ICON_ACTION}
            disabled={busy}
            onClick={onReplace}
            aria-label={`Replace file for ${name}`}
            title="Replace file"
          >
            <Upload aria-hidden="true" strokeWidth={1.5} />
          </Button>
        ) : null}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            aria-label={`More actions for ${name}`}
            className={cn(ICON_ACTION, "size-9 md:hidden")}
          >
            <Ellipsis aria-hidden="true" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copyLink(liveUrl)}>Copy link</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={liveUrl} target="_blank" rel="noopener noreferrer">
              Open ↗
            </a>
          </DropdownMenuItem>
          {onReplace ? (
            <DropdownMenuItem disabled={busy} onSelect={onReplace}>
              Replace file
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
