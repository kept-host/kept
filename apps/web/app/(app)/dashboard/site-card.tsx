/**
 * One page on the wall — E06 task 003.
 *
 * A SERVER COMPONENT with one client island in it (`<SiteState>`). Everything on
 * the card except the clock is settled at render time, so the browser downloads
 * the clipboard button and the countdown and nothing else.
 *
 * THE CARD IS NAMED BY ITS PAGE, NOT BY ITS ID. `title ?? slug` — migration
 * `0004` put the page's own `<title>` on the row precisely so this wall does not
 * read `k3n8vq2p · 9wtx4mbd · p7fz2h6r` on the one screen whose entire job is
 * finding your own page. Rows that predate `0004`, and pages that carried no
 * title, are `null` forever and fall back; that is a correct permanent state,
 * not a backfill waiting to happen.
 *
 * THE TITLE IS UNTRUSTED STRANGER-AUTHORED INPUT. React escapes it, task 001
 * trims and caps it at storage, and the clamp below is a *visual* limit on top
 * of that — `PAGE_TITLE_MAX_LENGTH` (80) is up to two full lines of card, so
 * the clamp keeps it to two and lets the rest go.
 *
 * WHAT THIS CARD DELIBERATELY DOES NOT HAVE: a thumbnail (task 010 mints the OG
 * card and wires it in here). Its absence is sequencing, not omission.
 *
 * TASK 009 ADDED THE DROP TARGET, through `./card-replace.tsx` — a mount of task
 * 006's shared component, never a second copy of it. A file dropped on a card
 * replaces that page's bytes at the same URL and does not touch its clock; a
 * file dropped anywhere else on the screen belongs to the publish drop-zone, and
 * that precedence is decided once, in `publish-dropzone.tsx`'s window listener.
 *
 * TASK 007 ADDED KEEP, AND ONLY TO A DRAFT. A kept page has nothing to keep, so
 * the button is absent rather than disabled there; on a flagged draft it is
 * present and disabled, pointed at the refusal sentence below. Demote lives on
 * the detail screen (task 008), not here — a wall is for finding a page, and one
 * irreversible-looking verb per card is enough.
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { CopyLinkButton } from "@/components/kept/live-url";
import { Button } from "@/components/ui/button";
import type { OwnedSite } from "@/lib/db/queries/dashboard";
import {
  formatBytes,
  formatUpdatedAt,
  managementRefusal,
  pageName,
  siteHref,
} from "@/lib/sites/display";
import { cn } from "@/lib/utils";

import { CardReplaceDrop } from "./card-replace";
import { SiteState } from "./clock";
import { KeepAction } from "./keep-action";

export function SiteCard({
  site,
  liveUrl,
  className,
}: {
  site: OwnedSite;
  /**
   * The page's public URL, built by the server component from `liveUrl()`. Not
   * derived here: the serving domain comes from configuration, and a component
   * that reached for it would be the second place that knows it.
   */
  liveUrl: string;
  className?: string;
}) {
  const name = pageName(site);
  // The slug is the part that is theirs; the suffix is ours. Split on the real
  // host so no hostname literal lands in this file.
  const hostSuffix = new URL(liveUrl).host.slice(site.slug.length);
  const size = formatBytes(site.sizeBytes);
  // When the bytes were last written, falling back to the row's own stamp for a
  // page whose current version has gone missing — the LEFT join that keeps such
  // a page on its owner's dashboard would otherwise leave this blank.
  const updatedAt = site.versionCreatedAt ?? site.updatedAt;
  const refusal = managementRefusal(site.status);
  // Stable and derived, not `useId` — this is a server component, and the id has
  // to survive into the client island that points `aria-describedby` at it.
  const refusalId = `site-refusal-${site.id}`;
  const isDraft = site.expiresAt !== null;

  return (
    <article
      className={cn(
        // `relative` anchors the stretched link below; `group` drives the hover
        // lift, which is `motion-safe:` because §6 says every animation needs a
        // static equivalent and a card that jumps is the easiest one to skip.
        "group relative flex flex-col gap-4 rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]",
        "motion-safe:transition-shadow motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]",
        "hover:shadow-[var(--shadow-md)] focus-within:shadow-[var(--shadow-md)]",
        className,
      )}
    >
      <SiteState siteId={site.id} status={site.status} expiresAt={site.expiresAt} />

      <div className="min-w-0">
        <h3 className="font-display text-lg font-semibold leading-snug text-text">
          {/* The whole card is the target, from one link with one accessible
              name — `after:inset-0` covers the article rather than nesting the
              meta and the buttons inside an anchor, which would swallow them. */}
          <Link
            href={siteHref(site.slug)}
            className="line-clamp-2 break-words rounded-[var(--r-sm)] outline-none after:absolute after:inset-0 after:rounded-[var(--r-lg)] focus-visible:after:ring-2 focus-visible:after:ring-accent focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-bg"
          >
            {name}
          </Link>
        </h3>

        <p className="mono-label mt-1.5 truncate text-[11px] text-text-secondary">
          {site.slug}
          <span className="text-text-muted">{hostSuffix}</span>
        </p>
      </div>

      {refusal ? (
        <p
          id={refusalId}
          className="rounded-[var(--r-md)] border border-border bg-sunken px-3 py-2 text-xs leading-relaxed text-text-secondary"
        >
          {refusal}
        </p>
      ) : null}

      {/* Task 006's component, mounted — task 009 wires it, task 008 mounts the
          same one on the detail screen, and neither of them re-implements it. It
          refuses with `managementRefusal`'s sentence on a flagged page rather
          than disappearing from it, and it carries `REPLACE_CLOCK_NOTE` on a
          draft, because re-dropping a file does not buy another seven days. */}
      <CardReplaceDrop
        siteId={site.id}
        name={name}
        status={site.status}
        expiresAt={site.expiresAt}
      />

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-border pt-3">
        <p className="mono-label text-[10px] leading-relaxed text-text-muted">
          <time dateTime={updatedAt.toISOString()} title={updatedAt.toUTCString()}>
            {formatUpdatedAt(updatedAt)}
          </time>
          {size ? ` · ${size}` : ""}
        </p>

        {/* `relative` lifts these above the stretched link's overlay; without it
            the card swallows its own buttons. */}
        <div className="relative flex items-end gap-1">
          <CopyLinkButton
            liveUrl={liveUrl}
            label={
              <>
                Copy
                <span className="sr-only"> the link for {site.slug}</span>
              </>
            }
            variant="ghost"
            size="sm"
            className="px-2 text-xs"
          />
          <Button asChild variant="ghost" size="sm" className="px-2 text-xs">
            {/* `noreferrer` with `noopener`: the page being opened is
                stranger-authored HTML and has no business reading where the
                click came from. */}
            <a href={liveUrl} target="_blank" rel="noopener noreferrer">
              Open
              <ArrowUpRight aria-hidden="true" />
              <span className="sr-only"> {site.slug}</span>
            </a>
          </Button>

          {isDraft ? (
            <KeepAction
              site={{
                id: site.id,
                name,
                slug: site.slug,
                liveUrl,
                status: site.status,
                // Crossing into the client, so ISO rather than a `Date`. The
                // island treats it as a seed; `useSiteClock` is the authority
                // once a keep or a swap has answered.
                expiresAt: site.expiresAt?.toISOString() ?? null,
              }}
              refusalId={refusalId}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}
