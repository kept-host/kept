"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, QrCode as QrIcon } from "lucide-react";

import type { SiteStatus } from "@kept/shared";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The live URL and the three things a publisher does with it — copy, QR, open.
 * Shared by `/p/[anonToken]` (task 008) and `/keep/[anonToken]` (task 009);
 * neither screen may grow its own copy of this block.
 *
 * THE QR ARRIVES AS A PROP, ALREADY RENDERED. The encoder runs in a server
 * component and the finished SVG is passed down (`components/kept/qr.tsx`), so
 * this client bundle carries no encoder and this screen makes no request for an
 * image. Toggling the panel is state; generating the code is not.
 *
 * THE LIVE DOT IS DATA. It is driven by the row's `status`, not switched on
 * because the screen rendered — a page that is not `live` must not claim to be.
 *
 * ── E06 task 003 split two pieces out, and did not copy them ─────────────────
 * The dashboard card needs the same status dot and the same clipboard behaviour
 * at card scale, but emphatically not `LiveUrlBlock` itself: that block is a
 * hero — an `<h1>` at `clamp(1.9rem, 5.2vw, 2.9rem)` — and a wall of twenty of
 * them would be twenty `<h1>`s and no wall. So `SiteStatusDot` and
 * `CopyLinkButton` are exported and `LiveUrlBlock` is composed from them. The
 * alternative was a second copy of the clipboard's failure handling and its live
 * region on a screen that would be the one to get it wrong.
 */

const STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Live",
  archived: "Not serving",
  expired: "Expired",
  quarantined: "Under review",
  under_review: "Under review",
  removed: "Removed",
};

/** Only `live` gets the green pulse; everything else is a stated problem. */
function statusTone(status: SiteStatus): { dot: string; text: string } {
  return status === "live"
    ? { dot: "bg-live motion-safe:animate-[keptLive_2s_ease-in-out_infinite]", text: "text-live" }
    : { dot: "bg-text-muted", text: "text-text-muted" };
}

/**
 * The status dot and its word — the smallest honest statement about a page.
 *
 * Exported for the dashboard card (task 003), which shows the same fact at a
 * different size. It takes the status it should *display*, which on a draft
 * whose clock has run out is not the status on the row: see
 * `lib/sites/display.ts`'s `effectiveStatus`.
 */
export function SiteStatusDot({
  status,
  className,
}: {
  status: SiteStatus;
  className?: string;
}) {
  const tone = statusTone(status);

  return (
    <span
      className={cn(
        "mono-label inline-flex items-center gap-2 text-xs",
        tone.text,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", tone.dot)} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Copy the link, and say what happened — including when it did not happen.
 *
 * The flash timer, the refused-clipboard branch and the live region travel with
 * the button rather than with whichever screen mounted it, so the card and the
 * hero cannot drift on the one interaction the whole product is built around.
 */
export function CopyLinkButton({
  liveUrl,
  label = "Copy link",
  size,
  variant,
  className,
}: {
  liveUrl: string;
  /**
   * Resting label. The copied/failed states are owned here and are not props.
   *
   * A `ReactNode` so a caller rendering many of these — the dashboard wall — can
   * hang an `sr-only` slug off it and give twenty otherwise identical "Copy"
   * buttons twenty distinct accessible names.
   */
  label?: React.ReactNode;
  size?: React.ComponentProps<typeof Button>["size"];
  variant?: React.ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending flash timer after unmount would set state on a dead component.
  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  function flash(result: "done" | "failed") {
    setCopied(result);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setCopied("idle"), 1600);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      flash("done");
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure
      // context). Say so instead of flashing a "Copied" that did not happen —
      // this link is the only handle the visitor has.
      flash("failed");
    }
  }

  return (
    <>
      <Button
        type="button"
        onClick={copy}
        size={size}
        variant={variant}
        className={className}
      >
        {copied === "done" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : label}
      </Button>

      {/* One polite live region for both outcomes, so a screen reader hears the
          result of a copy it cannot see flash. */}
      <span aria-live="polite" className="sr-only">
        {copied === "done"
          ? "Link copied to the clipboard."
          : copied === "failed"
            ? "Could not copy the link. Select it and copy manually."
            : ""}
      </span>
    </>
  );
}

export function LiveUrlBlock({
  liveUrl,
  slug,
  status,
  qr,
  className,
}: {
  liveUrl: string;
  slug: string;
  status: SiteStatus;
  /** The pre-rendered QR SVG. Omit to hide the QR control entirely. */
  qr?: React.ReactNode;
  className?: string;
}) {
  const [qrOpen, setQrOpen] = useState(false);
  const qrPanelId = useId();

  // The slug is the part that is theirs; the suffix is ours. Splitting on the
  // real host keeps the domain out of this file — no hostname literal.
  const hostSuffix = new URL(liveUrl).host.slice(slug.length);

  return (
    <div className={cn("flex flex-col items-center gap-5", className)}>
      <SiteStatusDot status={status} />

      <h1 className="break-words font-display text-[clamp(1.9rem,5.2vw,2.9rem)] font-bold text-text">
        {slug}
        <span className="text-text-muted">{hostSuffix}</span>
      </h1>

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <CopyLinkButton liveUrl={liveUrl} className="min-w-[8.5rem]" />

        {qr ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setQrOpen((open) => !open)}
            aria-expanded={qrOpen}
            aria-controls={qrPanelId}
          >
            <QrIcon aria-hidden="true" />
            QR
          </Button>
        ) : null}

        <Button variant="secondary" asChild>
          {/* `noreferrer` alongside `noopener`: the manage URL carries a bearer
              token in its path, and a `Referer` header would hand that token to
              the hosted page. */}
          <a href={liveUrl} target="_blank" rel="noopener noreferrer">
            Open
            <ArrowUpRight aria-hidden="true" />
          </a>
        </Button>
      </div>

      {qr ? (
        <div id={qrPanelId} hidden={!qrOpen}>
          <div className="inline-flex flex-col items-center gap-2 rounded-[var(--r-lg)] border border-border bg-surface p-4 shadow-[var(--shadow-md)]">
            {qr}
            <span className="mono-label text-[10px] text-text-muted">
              Scan to open
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
