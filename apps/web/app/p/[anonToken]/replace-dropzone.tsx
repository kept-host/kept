"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import { REPLACE_CLOCK_NOTE } from "@/components/kept/draft-chip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FILE_UNREADABLE, publishErrorText } from "@/lib/publish/client";
import { DROP_HINT, packing } from "@/lib/publish/fileset/copy";
import {
  collectDrop,
  collectInput,
  inlineArchiveForm,
  isRefusal,
  toIntent,
  UPLOAD_ACCEPT,
  type PackEntry,
} from "@/lib/publish/pack";
import { cn } from "@/lib/utils";
import {
  replaceWithArchive,
  replaceWithFile,
  replaceWithHtml,
  type ManageResult,
} from "./manage-client";

/**
 * Drop or paste new bytes for a page that already exists — the screen's half of
 * `POST /api/anon/:token/replace`.
 *
 * THREE WAYS IN, ONE ENDPOINT, because that endpoint already accepts all three:
 * one dropped HTML file goes up as a multipart `html` part, a folder or a `.zip`
 * as one multipart `archive` part (E08 §5.8 — packed in the browser by
 * `lib/publish/pack.ts`, inline only, so anything over the inline ceiling is
 * refused before a request), and pasted markup as JSON. Beyond the pre-flight
 * every drop surface shares (`toIntent` → `checkPageFile`), nothing here
 * re-validates the document — size, HTML-ness, the set's rules and the replace
 * limit all live behind the API, which is also what E08's agents call.
 *
 * KEYBOARD FIRST. The drop target is a real `<input type="file">` inside a
 * `<label>`, so it focuses, activates on Enter/Space and announces itself
 * without a single key handler; the drag events are an enhancement on top of a
 * control that already works without a mouse. A folder has its own picker, a
 * real button below the zone.
 */
export function ReplaceDropzone({
  anonToken,
  onReplaced,
}: {
  anonToken: string;
  /** Called after the API confirms the new version is live. */
  onReplaced: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  /** "Packing {n} files…" while a folder packs; empty otherwise. */
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pasted, setPasted] = useState("");
  const folderRef = useRef<HTMLInputElement | null>(null);

  async function run(attempt: () => Promise<ManageResult>) {
    setBusy(true);
    setError("");

    const result = await attempt();
    setBusy(false);
    setNotice("");

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setPasted("");
    onReplaced();
  }

  /** What was dropped or chosen, as one replace — or the sentence refusing it. */
  async function take(collected: Promise<PackEntry[]> | PackEntry[]) {
    let entries: PackEntry[];
    try {
      entries = await collected;
    } catch {
      setError(FILE_UNREADABLE);
      return;
    }
    if (entries.length === 0) return;

    const intent = toIntent(entries);
    if (isRefusal(intent)) {
      setError(publishErrorText(intent));
      return;
    }
    if (intent.kind === "html") {
      await run(() => replaceWithFile(anonToken, intent.file));
      return;
    }
    await run(async () => {
      const form = await inlineArchiveForm(intent, (files) => setNotice(packing(files)));
      if (!(form instanceof FormData)) return { ok: false, message: publishErrorText(form) };
      setNotice("");
      return replaceWithArchive(anonToken, form);
    });
  }

  function onPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const entries = collectInput(event.target.files ?? []);
    // Cleared so choosing the SAME file again still fires `change`.
    event.target.value = "";
    void take(entries);
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          // Synchronously, here: the item list empties when this handler returns.
          void take(collectDrop(event.dataTransfer));
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-[var(--r-md)] border border-dashed border-border bg-sunken px-4 py-6 text-center transition-colors duration-150",
          dragging && "border-accent bg-accent-soft",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload aria-hidden="true" className="size-4 text-text-muted" />
        <span className="text-sm text-text-secondary">
          {busy ? notice || "Replacing…" : `${DROP_HINT}, or browse`}
        </span>
        <input
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          disabled={busy}
          onChange={onPicked}
          className="sr-only"
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => folderRef.current?.click()}
        className="self-start rounded-[var(--r-sm)] font-mono text-xs text-text underline underline-offset-[3px] outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-60"
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
        disabled={busy}
        onChange={onPicked}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="replace-html">…or paste the HTML</Label>
        <Textarea
          id="replace-html"
          rows={4}
          value={pasted}
          disabled={busy}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="<!doctype html>…"
          className="font-mono text-xs"
        />
        <div className="flex justify-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || pasted.trim() === ""}
            onClick={() => void run(() => replaceWithHtml(anonToken, pasted))}
          >
            Replace with this
          </Button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        {REPLACE_CLOCK_NOTE}
      </p>

      <p aria-live="polite" className="text-xs text-danger">
        {error}
      </p>
    </div>
  );
}
