"use client";

/**
 * General → Danger zone — PRD §5.2 item 6, §5.3, §11. E06 task 012, replacing
 * the `[slug]` screen's actions panel.
 *
 *   · **Demote to draft** — kept `live` pages only. The confirm states the
 *     fresh `DRAFT_TTL_DAYS` clock and its deadline BEFORE anything is sent;
 *     then the toast and `router.refresh()`. Name and Explore flag survive.
 *   · **Delete** — every page the owner still has. The design's type-the-name
 *     gate (the page's name, its slug) over PRD §11's sentence, then
 *     `DELETE /api/sites/:id` and back to `/dashboard`. **No Undo** (design call
 *     5): delete archives, and there is no un-archive path — the dialog says
 *     what survives instead (the download window, a chosen name's hold).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { DRAFT_TTL_DAYS } from "@kept/shared";

import { Button } from "@/components/ui/button";
import {
  DELETE_PAGE_NOTE,
  DEMOTE_NOTE,
  DEMOTED_TOAST,
  deletePageWarning,
  demoteDeadline,
  MS_PER_DAY,
} from "@/lib/sites/display";
import { deletePage, demotePage } from "@/lib/sites/owner-client";

import { ConfirmDialog } from "./confirm-dialog";
import { Section } from "./section";

type Confirming = "none" | "demote" | "delete";

export function DangerZone({
  siteId,
  slug,
  name,
  host,
  nameChosen,
  canDemote,
}: {
  siteId: string;
  /** The page's name — what the delete gate asks to have typed. */
  slug: string;
  /** `title ?? slug`, for the dialog's question. */
  name: string;
  host: string;
  /** A chosen name is held for the owner when the page is deleted (D4). */
  nameChosen: boolean;
  /** Kept and `live`. */
  canDemote: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<Confirming>("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [deadline, setDeadline] = useState<Date | null>(null);
  const abort = useRef<AbortController | null>(null);
  const gateId = useId();

  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  function open(next: Confirming) {
    setError(null);
    setTyped("");
    // The deadline a demote WOULD set, from this click — the server's own
    // clock decides the real one.
    if (next === "demote") setDeadline(new Date(Date.now() + DRAFT_TTL_DAYS * MS_PER_DAY));
    setConfirming(next);
  }

  function controller(): AbortController {
    abort.current?.abort();
    abort.current = new AbortController();
    return abort.current;
  }

  async function demote() {
    setPending(true);
    setError(null);
    const outcome = await demotePage(siteId, controller().signal);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setConfirming("none");
    toast.success(DEMOTED_TOAST, { description: host });
    router.refresh();
  }

  async function remove() {
    setPending(true);
    setError(null);
    const outcome = await deletePage(siteId, controller().signal);
    if (!outcome.ok) {
      setPending(false);
      setError(outcome.error.message);
      return;
    }
    // `pending` stays set: this screen is about to be replaced, and a delete
    // button re-enabled on a page that no longer serves invites a second call.
    // `replace`, so Back does not return to a dead management screen.
    router.replace("/dashboard");
  }

  return (
    <Section title="Danger zone" tone="danger" testId="danger-zone" className="gap-1">
      {canDemote ? (
        <Row title="Demote to draft" note={DEMOTE_NOTE}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="demote-button"
            onClick={() => open("demote")}
            className="font-body font-medium"
          >
            Demote to draft
          </Button>
        </Row>
      ) : null}

      <Row title="Delete page" note={DELETE_PAGE_NOTE}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="delete-button"
          onClick={() => open("delete")}
          className="border-danger font-body font-medium"
        >
          <Trash2 aria-hidden="true" strokeWidth={1.5} className="text-danger" />
          Delete
        </Button>
      </Row>

      <ConfirmDialog
        open={confirming === "demote"}
        onOpenChange={(isOpen) => setConfirming(isOpen ? "demote" : "none")}
        title="Demote to draft?"
        description={`${DEMOTE_NOTE}${deadline ? ` ${demoteDeadline(deadline)}` : ""}`}
        confirmLabel={pending ? "Demoting…" : "Demote to draft"}
        testId="demote-dialog"
        pending={pending}
        error={error}
        onConfirm={demote}
      />

      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(isOpen) => setConfirming(isOpen ? "delete" : "none")}
        title={`Delete ${name}?`}
        description={deletePageWarning(nameChosen ? slug : null)}
        confirmLabel={pending ? "Deleting…" : "Delete page"}
        confirmVariant="destructive"
        confirmDisabled={typed.trim() !== slug}
        testId="delete-dialog"
        pending={pending}
        error={error}
        onConfirm={remove}
      >
        <label htmlFor={gateId} className="flex flex-col gap-1.5 text-sm text-text">
          <span>
            Type <span className="font-mono font-medium">{slug}</span> to confirm
          </span>
          <input
            id={gateId}
            data-testid="delete-gate"
            value={typed}
            disabled={pending}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            className="h-11 rounded-[var(--r-sm)] border border-border bg-surface px-3 font-mono text-sm text-text outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
      </ConfirmDialog>
    </Section>
  );
}

function Row({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-3 last-of-type:pb-0">
      <span className="flex min-w-[200px] flex-1 flex-col leading-[1.35]">
        <span className="text-[15px] text-text">{title}</span>
        <span className="text-[13px] text-text-secondary">{note}</span>
      </span>
      {children}
    </div>
  );
}
