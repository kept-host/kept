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
 * A highlighted card (the one a publish just made, or the one a duplicate
 * publish pointed at — AC8) scrolls into view so the ring is seen.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Ellipsis, Upload } from "lucide-react";
import { toast } from "sonner";

import type { Plan } from "@kept/shared";

import { type Browse, DropTarget } from "@/components/kept/drop-target";
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
import { pageName, siteHref } from "@/lib/sites/display";
import { replacePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

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
  highlighted,
  action,
}: {
  site: HomeSite;
  variant: HomeCardVariant;
  plan: Plan;
  highlighted: boolean;
  /** A draft's primary action (Keep / Swap…). Kept cards get copy · open · replace. */
  action?: ReactNode;
}) {
  const router = useRouter();
  const [replacing, setReplacing] = useState(false);
  const itemRef = useRef<HTMLLIElement | null>(null);
  const host = new URL(site.liveUrl).host;
  const href = siteHref(site.slug);
  const replaceable = site.status === "live";

  useEffect(() => {
    if (!highlighted) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    itemRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [highlighted]);

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
    const common = { site, href, host, actions, highlighted };
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
      data-highlighted={highlighted ? "true" : undefined}
      aria-busy={replacing || undefined}
      className="min-w-0 list-none"
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

  async function copy() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      toast.success("Link copied", { description: host });
    } catch {
      toast.error("Could not copy the link. Select it and copy manually.", { description: host });
    }
  }

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
          <DropdownMenuItem onSelect={copy}>Copy link</DropdownMenuItem>
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
