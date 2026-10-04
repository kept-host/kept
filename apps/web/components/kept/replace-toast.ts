"use client";

/**
 * The replace toast — PRD §5.5, shared by every surface that replaces a page's
 * file (the home's card drop, E06 task 011; page detail's Versions, task 012).
 *
 *   · unchanged bytes → "No changes — that's already the live version." (AC27)
 *   · a new version   → "Replaced. Same link, new version." with **Undo**, which
 *                       restores the version that was current (AC25)
 *   · pruned on Free  → the toast adds the version-limit note, once per session
 *
 * Undo is `POST …/versions/:previousVersionId/restore` — a pointer move, no
 * upload. Both outcomes end in `refresh`, because the page's card is a server
 * render (PRD §5.1: no live updates).
 */
import { limitsFor, type Plan, type ReplaceResult } from "@kept/shared";
import { toast } from "sonner";

import {
  prunedVersionsNote,
  REPLACED_TOAST,
  UNDONE_TOAST,
} from "@/lib/sites/display";
import { replaceNotice, restoreVersion } from "@/lib/sites/owner-client";

/** "Once per session" (PRD §5.5): this tab, until it reloads. */
let prunedNoteShown = false;

export function toastReplaced({
  page,
  host,
  plan,
  refresh,
}: {
  page: ReplaceResult;
  /** `{name}.{base}` — the page the toast is about. */
  host: string;
  plan: Plan;
  refresh: () => void;
}): void {
  if (page.unchanged) {
    toast(replaceNotice(page), { description: host });
    return;
  }

  const notePruned = page.pruned && plan === "free" && !prunedNoteShown;
  if (notePruned) prunedNoteShown = true;
  const { previousVersionId, siteId } = page;

  toast.success(REPLACED_TOAST, {
    description: notePruned ? prunedVersionsNote(limitsFor(plan).previousVersions) : host,
    action:
      previousVersionId === null
        ? undefined
        : {
            label: "Undo",
            onClick: async () => {
              const undone = await restoreVersion(siteId, previousVersionId);
              if (!undone.ok) {
                toast.error(undone.error.message, { description: host });
                return;
              }
              toast.success(UNDONE_TOAST, { description: host });
              refresh();
            },
          },
  });
  refresh();
}
