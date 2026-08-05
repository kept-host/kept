"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import type { SiteStatus } from "@kept/shared";

import {
  DELETE_GRACE_NOTE,
  DRAFT_PROMISE,
} from "@/components/kept/draft-chip";
import { LiveUrlBlock } from "@/components/kept/live-url";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stopServing } from "./manage-client";
import { ReminderForm } from "./reminder-form";
import { ReplaceDropzone } from "./replace-dropzone";

/**
 * The result screen's interactive half.
 *
 * WHAT IS SERVER-RENDERED AND ARRIVES AS A PROP: the countdown chip, the page
 * preview and the QR code. All three are `ReactNode`s built in `./page.tsx` —
 * the chip so a hydrated clock cannot disagree with the rendered one, the QR so
 * the encoder never enters this bundle, the preview so the page's bytes are read
 * with a credential the browser never sees. This component owns state, not data.
 *
 * DELETE IS DESTRUCTIVE AND GETS A REAL CONFIRMATION — a shadcn/Radix dialog,
 * never `window.confirm`: the native dialog cannot be styled, cannot be tested
 * in-page, and is suppressible by the browser. Radix supplies the focus trap,
 * the restore-focus-on-close and the Escape handling; kept supplies the words.
 * The words matter here — the page STOPS SERVING, it is not destroyed, and
 * saying "deleted forever" would be a lie the grace window contradicts.
 */
export function ResultScreen({
  anonToken,
  liveUrl,
  slug,
  status,
  chip,
  preview,
  qr,
}: {
  anonToken: string;
  liveUrl: string;
  slug: string;
  status: SiteStatus;
  chip: ReactNode;
  preview: ReactNode;
  qr: ReactNode;
}) {
  const router = useRouter();
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleted, setDeleted] = useState(false);

  const host = new URL(liveUrl).host;

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError("");

    const result = await stopServing(anonToken);
    setDeleting(false);

    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }

    setConfirmOpen(false);
    setDeleted(true);
  }

  // The terminal state. Everything else on the screen acts on a page that is
  // still being served, so none of it may stay on offer once it is not.
  if (deleted) {
    return (
      <section className="flex w-full max-w-[560px] flex-col items-center gap-5 text-center">
        <span className="mono-label inline-flex items-center gap-2 text-xs text-text-muted">
          <span aria-hidden="true" className="size-2 rounded-full bg-text-muted" />
          Not serving
        </span>
        <h1 className="break-words font-display text-[clamp(1.6rem,4.4vw,2.4rem)] font-bold text-text">
          {host} has stopped serving
        </h1>
        <p className="text-text-secondary">{DELETE_GRACE_NOTE}</p>
        <p className="text-sm text-text-muted">
          This manage link is closed now — it will not open the page again.
        </p>
        <Button asChild variant="secondary">
          <Link href="/">Publish another page</Link>
        </Button>
      </section>
    );
  }

  return (
    <section className="flex w-full max-w-[560px] flex-col items-center gap-8">
      {preview}

      <div className="flex flex-col items-center gap-5">
        {chip}
        <LiveUrlBlock liveUrl={liveUrl} slug={slug} status={status} qr={qr} />
      </div>

      <p className="max-w-[46ch] text-center leading-relaxed text-text-secondary">
        {DRAFT_PROMISE}
      </p>

      {/* The one thing that turns a draft into a page that outlasts the week. */}
      <div className="w-full rounded-[var(--r-lg)] border border-border bg-surface p-6 text-left shadow-[var(--shadow-sm)]">
        <div className="mb-1.5 flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-accent" />
          <h2 className="font-display text-lg font-semibold text-text">
            Keep it forever
          </h2>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-text-secondary">
          Keeping attaches this page to an account and clears the clock. The page
          stays exactly where it is — same link, same file, no downtime.
        </p>
        <Button asChild className="mb-5 w-full">
          <Link href={`/keep/${anonToken}`}>Keep it forever →</Link>
        </Button>

        <ReminderForm anonToken={anonToken} />
      </div>

      {/* The edge case the PRD names outright: the visitor closes this tab. */}
      <p className="flex w-full items-start gap-2.5 rounded-[var(--r-md)] border border-border bg-sunken px-4 py-3 text-left text-xs leading-relaxed text-text-secondary">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          <b className="font-semibold text-text">
            This link is the only handle on this page.
          </b>{" "}
          Bookmark it, or leave an address above. Without one of the two, closing
          this tab means you can no longer replace or delete the page — it stays
          live, but it is out of your hands.
        </span>
      </p>

      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => setReplaceOpen((open) => !open)}
            aria-expanded={replaceOpen}
            aria-controls="replace-panel"
            className="mono-label inline-flex items-center gap-2 rounded-[var(--r-sm)] text-xs text-text-secondary transition-colors hover:text-text"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Replace
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="mono-label inline-flex items-center gap-2 rounded-[var(--r-sm)] text-xs text-danger transition-opacity hover:opacity-75"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete
          </button>
        </div>

        <p aria-live="polite" className="text-xs text-text-secondary">
          {replacedAt === null
            ? ""
            : "Replaced. The new version is live at the same link."}
        </p>
      </div>

      <div
        id="replace-panel"
        hidden={!replaceOpen}
        className="w-full rounded-[var(--r-lg)] border border-border bg-surface p-5 text-left shadow-[var(--shadow-sm)]"
      >
        <ReplaceDropzone
          anonToken={anonToken}
          onReplaced={() => {
            setReplacedAt(Date.now());
            setReplaceOpen(false);
            // Re-read the row and the stored bytes so the preview shows the
            // version that is actually being served now.
            router.refresh();
          }}
        />
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop serving this page?</DialogTitle>
            <DialogDescription>
              {host} stops answering straight away, and this manage link closes
              with it. {DELETE_GRACE_NOTE}
            </DialogDescription>
          </DialogHeader>

          <p aria-live="polite" className="text-sm text-danger">
            {deleteError}
          </p>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={deleting}>
                Keep it online
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleting ? "Stopping…" : "Stop serving it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
