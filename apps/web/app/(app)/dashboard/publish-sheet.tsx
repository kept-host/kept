"use client";

/**
 * The publish sheet and its form — PRD §5.1, D9 (E06 task 011).
 *
 * `kept Studio Screen.dc.html`, `sheet: true`: a dialog on desktop, a bottom
 * sheet on a phone. Of the design's three ways in, only the first ships in E06:
 * drop or choose a file, or paste HTML (design ↔ PRD call 9 — paste posts
 * `{ html }` to the same route). The agent prompt and MCP blocks are E08/E09's
 * and are not rendered (AC10), so the numbered "01 ·" structure goes with them.
 *
 * `PublishForm` is also the empty state's large drop zone, so the two cannot
 * drift: same zone, same paste, same inline error.
 *
 * The sheet closes the moment a request leaves (`usePublish`'s `onSend`, task
 * 015), so the mint card on the wall is what the owner watches; only a
 * pre-flight refusal — nothing sent — is shown here.
 */
import { useState } from "react";

import { DRAFT_TTL_DAYS } from "@kept/shared";

import { DropTarget } from "@/components/kept/drop-target";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { Publisher } from "./use-publish";

export function PublishSheet({
  open,
  onOpenChange,
  publisher,
  atLimit,
  keptLimit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publisher: Publisher;
  atLimit: boolean;
  keptLimit: number;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) publisher.clearError();
        onOpenChange(next);
      }}
    >
      <DialogContent
        data-testid="publish-sheet"
        className={cn(
          "gap-6 bg-bg p-8 md:top-16 md:max-w-[560px] md:translate-y-0 md:rounded-[var(--r-xl)]",
          // The dialog's zoom is movement; under reduced motion it just appears.
          "motion-reduce:!animate-none",
          // A bottom sheet on a phone (the design's `mobile` sheet).
          "max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:max-h-[92dvh] max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-b-none max-md:rounded-t-[var(--r-xl)] max-md:px-4 max-md:pb-7 max-md:pt-3",
        )}
      >
        <span
          aria-hidden="true"
          className="mx-auto -mb-2 h-1 w-9 rounded-full bg-border md:hidden"
        />
        <DialogHeader className="gap-1.5 pr-10">
          <DialogTitle className="text-[28px] tracking-[-0.03em]">Publish a page</DialogTitle>
          <DialogDescription className="text-[15px] text-text-secondary">
            {atLimit
              ? `You're keeping ${keptLimit} pages, so this one lands as a draft for ${DRAFT_TTL_DAYS} days.`
              : "It's live the moment it lands — and kept, because you're signed in."}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-[var(--r-lg)] border border-border bg-surface p-5">
          <PublishForm publisher={publisher} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The drop zone, the paste box and the inline error under them. */
export function PublishForm({
  publisher,
  zoneClassName,
}: {
  publisher: Publisher;
  zoneClassName?: string;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const busy = publisher.busy;

  return (
    <div className="flex flex-col gap-3">
      <DropTarget
        scope="zone"
        disabled={busy}
        onFile={publisher.publishFile}
        onRefuse={publisher.refuse}
        className={zoneClassName}
      />

      {publisher.error ? (
        <p role="alert" data-testid="publish-error" className="text-sm leading-relaxed text-danger">
          {publisher.error}
        </p>
      ) : null}

      {pasteOpen ? (
        <>
          <Textarea
            aria-label="Paste HTML"
            rows={4}
            placeholder="<!doctype html> …"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            className="resize-y rounded-[var(--r-sm)] font-mono text-xs leading-normal shadow-none"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || paste.trim() === ""}
            onClick={() => void publisher.publishHtml(paste)}
            className="self-start font-body font-medium"
          >
            Publish pasted HTML
          </Button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setPasteOpen(true)}
          className="self-start rounded-[var(--r-sm)] font-mono text-xs text-text underline underline-offset-[3px] outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          Or paste HTML
        </button>
      )}
    </div>
  );
}
