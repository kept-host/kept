"use client";

/**
 * Your data — "Export everything" (PRD §5.7, D13). E06 task 013.
 *
 * The design has this card inside its danger section; the PRD gives it a
 * section of its own, and the card keeps the design's look.
 *
 * ⚠️ A NATIVE DOWNLOAD, NEVER A BLOB. The button points the browser at
 * `GET /api/export` through an anchor, so the zip streams from R2 to disk and
 * the tab holds none of it. `fetch` + `Blob` would buffer the whole archive in
 * tab memory and defeat D13.
 *
 * "Preparing…" runs from the click until the download begins. The start signal
 * is the route's own cookie (`lib/sites/export-ready.ts`): it arrives with the
 * response headers — the moment the browser starts saving — and says whether
 * the zip started. If no answer arrives in `START_TIMEOUT_MS`, the request
 * never got one, and that is said too.
 *
 * Disabled with "Nothing to export yet." when the account has no page to put in
 * the zip; the count is the server component's.
 */
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { EXPORT_READY_PARAM, readExportStart } from "@/lib/sites/export-ready";
import { COULD_NOT_SAVE } from "@/lib/sites/owner-client";

import { SettingsCard } from "./settings-card";

/** How often the button looks for the route's answer. */
const POLL_MS = 250;
/** The route answers after one owner-scoped read; a minute of nothing is a failure. */
const START_TIMEOUT_MS = 60_000;

export function ExportPanel({ empty }: { empty: boolean }) {
  /** The in-flight attempt's token; `null` when idle. */
  const [attempt, setAttempt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!attempt) return;
    const since = Date.now();
    const timer = window.setInterval(() => {
      const start = readExportStart(document.cookie, attempt);
      if (start === null && Date.now() - since < START_TIMEOUT_MS) return;
      window.clearInterval(timer);
      setAttempt(null);
      if (start !== "started") setError(COULD_NOT_SAVE.message);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [attempt]);

  function download() {
    const token = crypto.randomUUID();
    setError(null);
    setAttempt(token);
    // A detached anchor with `download`: the browser saves the response rather
    // than navigating away from the screen, whatever it turns out to be.
    const anchor = document.createElement("a");
    anchor.href = `/api/export?${EXPORT_READY_PARAM}=${token}`;
    anchor.download = "";
    anchor.click();
  }

  return (
    <SettingsCard title="Export everything" data-testid="export-panel">
      <p className="text-[15px] text-text-secondary">
        A zip of every page as it is now, with a list of their names, titles and dates. Yours to
        keep, any time.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          type="button"
          variant="secondary"
          data-testid="export-download"
          disabled={empty || attempt !== null}
          aria-busy={attempt !== null}
          onClick={download}
          className="h-10 rounded-[var(--r-md)] px-4 font-body font-medium"
        >
          <Download aria-hidden="true" strokeWidth={1.5} />
          {attempt ? "Preparing…" : "Download export"}
        </Button>
        {empty ? (
          <span className="text-[13px] text-text-secondary">Nothing to export yet.</span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" data-testid="export-error" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  );
}
