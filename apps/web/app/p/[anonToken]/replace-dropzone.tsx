"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import { REPLACE_CLOCK_NOTE } from "@/components/kept/draft-chip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { replaceWithFile, replaceWithHtml, type ManageResult } from "./manage-client";

/**
 * Drop or paste new bytes for a page that already exists — the screen's half of
 * `POST /api/anon/:token/replace`.
 *
 * TWO WAYS IN, ONE ENDPOINT, because that endpoint already accepts both: a
 * dropped file goes up as `multipart/form-data` and pasted markup as JSON.
 * Nothing here re-validates the document — size, HTML-ness and the content check
 * all live behind the API, which is also what E08's agents call, so a
 * browser-only rule would be a rule that does not exist.
 *
 * KEYBOARD FIRST. The drop target is a real `<input type="file">` inside a
 * `<label>`, so it focuses, activates on Enter/Space and announces itself
 * without a single key handler; the drag events are an enhancement on top of a
 * control that already works without a mouse.
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
  const [error, setError] = useState("");
  const [pasted, setPasted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function run(attempt: Promise<ManageResult>) {
    setBusy(true);
    setError("");

    const result = await attempt;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setPasted("");
    // Clear the file input so choosing the SAME file again still fires `change`.
    if (inputRef.current) inputRef.current.value = "";
    onReplaced();
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
          const file = event.dataTransfer.files[0];
          if (file) void run(replaceWithFile(anonToken, file));
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-[var(--r-md)] border border-dashed border-border bg-sunken px-4 py-6 text-center transition-colors duration-150",
          dragging && "border-accent bg-accent-soft",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload aria-hidden="true" className="size-4 text-text-muted" />
        <span className="text-sm text-text-secondary">
          {busy ? "Replacing…" : "Drop an HTML file, or browse"}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".html,.htm,text/html"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(replaceWithFile(anonToken, file));
          }}
          className="sr-only"
        />
      </label>

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
            onClick={() => void run(replaceWithHtml(anonToken, pasted))}
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
