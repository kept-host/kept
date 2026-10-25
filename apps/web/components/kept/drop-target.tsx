"use client";

/**
 * Drop a file to publish or to replace — E06 task 010 (PRD §8, §9.1).
 *
 * ONE COMPONENT FOR EVERY DROP SURFACE IN THE STUDIO, in three scopes:
 *
 *   · `window` — the whole screen is a publish target. A file dropped on the
 *     page background is not a no-op: without a handler the browser navigates
 *     to the file and the studio is gone. So the listeners are on the window,
 *     and while a file is held anywhere that is not a card, a full-window
 *     overlay says "Drop to publish".
 *   · `card` — wraps one page's card. A file held over it shows "Drop to
 *     replace this page" over that card, and the window overlay stands down.
 *   · `zone` — the dashed box in the publish sheet and the empty state: a real
 *     `<button>` that is a drop target and opens the file picker when pressed.
 *
 * It replaced the three per-screen drop zones the dashboard and the old
 * slug-keyed detail screen each carried (deleted by tasks 011 and 012); their
 * drag listeners are carried over.
 *
 * ── ONE DROP, ONE OWNER ──────────────────────────────────────────────────────
 * A card or a zone that takes a drag cancels it (`preventDefault` — which it
 * must anyway, or `drop` never fires on it), and the window takes only a drag
 * nothing inside it cancelled: `event.defaultPrevented` is the whole precedence
 * rule, for the overlay and for the drop alike. It is read off the event, never
 * off the DOM, because the DOM has moved by then: a browser-dispatched drop
 * runs React's listener, then a microtask checkpoint in which the card renders
 * itself busy (and stops being a target), and only then the window's listener.
 * A rule that asked the DOM "was this inside a card?" got "no" there, and the
 * window published the file the card was already replacing (E06 task 015,
 * post-test fix).
 *
 * ── A KEYBOARD PATH FOR EVERY DROP ───────────────────────────────────────────
 * Every scope owns a real `<input type="file">`. `zone` IS its own browse
 * button. `window` and `card` hand `browse` to their children, which put it on
 * a visible control — the card's "Replace file" action, the empty state's zone.
 * A drop target only a mouse can reach would be a control half this product's
 * users could not use.
 *
 * ── REFUSED BEFORE ANY REQUEST (AC7, client half; edge case 11) ─────────────
 * Whatever arrives — one file, several, a folder (dragged, or through the
 * zone's "Browse folder"), a `.zip` — becomes ONE `UploadIntent`
 * (`lib/publish/pack.ts`, E08 §5.7): one HTML page, a zip sent as it is, or a
 * set of files at their relative paths. A single file that is neither a page
 * nor a zip goes through `checkPageFile`, the same pre-flight the landing and
 * the anonymous replace read: a `.png` gets `NOT_A_PAGE` ("kept needs an HTML
 * file. Drop an .html file, or a folder or .zip with an index.html in it."),
 * an oversize page gets the `MAX_PAGE_BYTES`
 * sentence, and `onUpload` is never called, so the caller never sends anything.
 * The server re-validates every byte regardless; this is a courtesy, not a
 * gate.
 *
 * The component hands over an intent; it does not pack, publish or replace and
 * holds no request. What happens next — the plan's size pre-flight, packing,
 * the upload, and where a refusal is shown — is the caller's (`onUpload`,
 * `onRefuse`; `lib/sites/owner-upload.ts`).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";

import { FILE_UNREADABLE, publishErrorText } from "@/lib/publish/client";
import { DROP_HINT } from "@/lib/publish/fileset/copy";
import {
  collectDrop,
  collectInput,
  isRefusal,
  toIntent,
  UPLOAD_ACCEPT,
  type PackEntry,
  type UploadIntent,
} from "@/lib/publish/pack";
import { cn } from "@/lib/utils";

/** Whether a drag is carrying files at all, rather than selected text. */
function draggingFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes("Files");
}

/** Opens this target's file picker. Handed to children so a visible control can. */
export type Browse = () => void;

type DropTargetProps = {
  /** What was dropped or chosen, as one upload. Never called for a refused drop. */
  onUpload: (intent: UploadIntent) => void;
  /** The sentence for a refused file, for the caller to show where it belongs. */
  onRefuse: (message: string) => void;
  /** Ignore drops and the picker — while a publish or replace is in flight. */
  disabled?: boolean;
} & (
  | { scope: "window"; children: (browse: Browse) => ReactNode }
  | {
      scope: "card";
      /** `{name}.{base}` — shown in the overlay, so the drop names its page. */
      host: string;
      children: (browse: Browse) => ReactNode;
      className?: string;
    }
  | { scope: "zone"; className?: string }
);

export function DropTarget(props: DropTargetProps) {
  const { onUpload, onRefuse, disabled = false } = props;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  // `collectDrop` is called synchronously by each drop handler (the item list
  // empties when the handler returns); only its walk of folders is awaited here.
  const take = useCallback(
    async (collected: Promise<PackEntry[]> | PackEntry[]) => {
      let entries: PackEntry[];
      try {
        entries = await collected;
      } catch {
        onRefuse(FILE_UNREADABLE);
        return;
      }
      const intent = toIntent(entries);
      if (isRefusal(intent)) onRefuse(publishErrorText(intent));
      else onUpload(intent);
    },
    [onUpload, onRefuse],
  );

  const browse = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const isWindow = props.scope === "window";

  // ── The window: everything that is not a card or a zone ───────────────────
  useEffect(() => {
    if (!isWindow) return;

    function onDragOver(event: DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      // A card or a zone has claimed this drag (one drop, one owner).
      const claimed = event.defaultPrevented;
      // Required for `drop` to fire at all — and what stops the browser
      // navigating away from the studio to the dropped file.
      event.preventDefault();
      setDragging(!disabled && !claimed);
    }

    function onDrop(event: DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      const claimed = event.defaultPrevented;
      event.preventDefault();
      setDragging(false);
      // A card or a zone owns this one; its own handler has already taken it.
      if (claimed || disabled || !event.dataTransfer) return;
      void take(collectDrop(event.dataTransfer));
    }

    // `relatedTarget === null` is the drag leaving the window rather than moving
    // between two elements inside it, which fires constantly.
    function onDragLeave(event: DragEvent) {
      if (event.relatedTarget === null) setDragging(false);
    }

    function onDragEnd() {
      setDragging(false);
    }

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [disabled, isWindow, take]);

  // ── A card or a zone: its own React handlers ──────────────────────────────
  // Each cancels the drag it takes, which is what the window stands down for.
  const region = {
    onDragOver(event: React.DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (!disabled) setDragging(true);
    },
    onDragLeave(event: React.DragEvent) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop(event: React.DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(false);
      if (!disabled) void take(collectDrop(event.dataTransfer));
    },
  };

  /** The picked files, read before the input is cleared. */
  function onPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const entries = collectInput(event.target.files ?? []);
    // Cleared so choosing the SAME file twice fires `change` again — a second
    // attempt after a refusal is the common case.
    event.target.value = "";
    if (entries.length > 0 && !disabled) void take(entries);
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={UPLOAD_ACCEPT}
      multiple
      hidden
      disabled={disabled}
      onChange={onPicked}
    />
  );

  if (props.scope === "window") {
    return (
      <>
        {props.children(browse)}
        {input}
        {dragging ? (
          <div
            aria-hidden="true"
            data-testid="drop-overlay-window"
            className="pointer-events-none fixed inset-0 z-50 flex p-4"
          >
            <DropMessage className="flex-1 rounded-[var(--r-xl)]" title="Drop to publish" note={DROP_HINT} />
          </div>
        ) : null}
      </>
    );
  }

  if (props.scope === "card") {
    // A card that cannot be replaced (`under_review`, `quarantined` — edge case
    // 10) is not a drop target at all: a file held over it gets the window's
    // "Drop to publish", so the overlay always says what the drop will do.
    return (
      <div {...(disabled ? {} : region)} className={cn("relative", props.className)}>
        {props.children(browse)}
        {input}
        {dragging ? (
          <DropMessage
            className="absolute -inset-px z-10 rounded-[var(--r-lg)]"
            title="Drop to replace this page"
            detail={props.host}
            note="Same link, new file. The old version is saved."
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        {...region}
        disabled={disabled}
        onClick={browse}
        className={cn(
          "flex min-h-40 w-full flex-col items-center justify-center gap-1.5 rounded-[var(--r-md)] border-[1.5px] border-dashed p-4 text-text",
          "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]",
          "disabled:pointer-events-none disabled:opacity-50",
          dragging
            ? "border-accent bg-accent-soft"
            : "border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent-soft)_45%,var(--surface))]",
          props.className,
        )}
      >
        <Upload aria-hidden="true" className="size-6 text-accent" strokeWidth={1.5} />
        <span className="text-[15px] font-medium">{DROP_HINT}</span>
        <span className="text-[13px] text-text-secondary">or click to choose files</span>
      </button>
      {input}
      <button
        type="button"
        disabled={disabled}
        onClick={() => folderRef.current?.click()}
        className="self-start rounded-[var(--r-sm)] font-mono text-xs text-text underline underline-offset-[3px] outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50"
      >
        Browse folder
      </button>
      <input
        // `webkitdirectory` is not in React's attribute types; every current
        // browser supports it, and each chosen file carries `webkitRelativePath`.
        ref={(element) => {
          folderRef.current = element;
          element?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        data-testid="folder-input"
        hidden
        disabled={disabled}
        onChange={onPicked}
      />
    </>
  );
}

/** The held-file overlay: the design's "Drop to replace" card state. */
function DropMessage({
  title,
  detail,
  note,
  className,
}: {
  title: string;
  detail?: string;
  note: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-accent bg-accent-soft/95 p-4 text-center text-text",
        className,
      )}
    >
      <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-surface text-accent shadow-[var(--shadow-md)]">
        <Upload aria-hidden="true" className="size-5" strokeWidth={1.5} />
      </span>
      <span className="font-display text-lg leading-tight font-semibold tracking-[-0.02em]">
        {title}
      </span>
      {detail ? <span className="font-mono text-xs">{detail}</span> : null}
      <span className="text-[13px] text-text-secondary">{note}</span>
    </div>
  );
}
