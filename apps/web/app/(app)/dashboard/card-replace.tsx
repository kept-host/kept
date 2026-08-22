"use client";

/**
 * Drag a new file onto a card on the wall — E06 task 009.
 *
 * ── THIS IS A MOUNT, NOT AN IMPLEMENTATION ───────────────────────────────────
 * `components/kept/owner-replace-drop.tsx` is task 006's, it is the same
 * component the detail screen mounts, and nothing here re-does any of its work:
 * the file read, the abort handling, the busy state, the `MAX_PAGE_BYTES`
 * pre-flight, the flagged-page refusal and `REPLACE_CLOCK_NOTE` all live there.
 * This wrapper exists for the two things a *server* component cannot supply —
 * an `onReplaced` callback, and the drop-precedence marker below.
 *
 * ── THE PRECEDENCE MARKER ────────────────────────────────────────────────────
 * The publish drop-zone listens for drops on the whole window, because a file
 * dropped on the page background would otherwise make the browser navigate away
 * from the dashboard to the file. That listener must not also swallow a drop
 * aimed at a card. `REPLACE_TARGET_ATTR` is how the two agree who owns a drop:
 * anything inside this element belongs to the card, everything else belongs to
 * the drop-zone. One attribute, defined once, read once — a coordinate the two
 * files share rather than a rule each of them guesses at.
 *
 * ── WHY A REFRESH AND NOT A REPAINT ──────────────────────────────────────────
 * The card must show the new size, the new timestamp and the re-extracted
 * `title ?? slug`. `ReplaceResult` carries the title but neither of the other
 * two, and both are computed server-side from the row and its version. The
 * detail screen reached the same conclusion for the same reason and does the
 * same thing. The clock is untouched by a replace, so the refresh disturbs
 * nothing this screen was holding.
 */
import { useRouter } from "next/navigation";

import type { SiteStatus } from "@kept/shared";

import { OwnerReplaceDrop } from "@/components/kept/owner-replace-drop";

/**
 * Marks a region that owns its own drops. Read by `publish-dropzone.tsx`'s
 * window listener; see the header.
 */
export const REPLACE_TARGET_ATTR = "data-replace-target";

/** Whether a drop landed inside a card's replace target rather than the page. */
export function isReplaceTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${REPLACE_TARGET_ATTR}]`) !== null;
}

export function CardReplaceDrop({
  siteId,
  name,
  status,
  expiresAt,
}: {
  siteId: string;
  /** `title ?? slug` — names the control on a wall of otherwise identical ones. */
  name: string;
  status: SiteStatus;
  /** The draft clock as the server rendered it. `null` ⇒ kept, and no note. */
  expiresAt: Date | null;
}) {
  const router = useRouter();

  return (
    // `relative` for the same reason the card's action row has it: the card is
    // covered by a stretched link, and a drop target underneath it would be a
    // drop target nobody could click into.
    <div {...{ [REPLACE_TARGET_ATTR]: "" }} className="relative">
      <OwnerReplaceDrop
        siteId={siteId}
        name={name}
        expiresAt={expiresAt}
        status={status}
        variant="card"
        onReplaced={() => router.refresh()}
      />
    </div>
  );
}
