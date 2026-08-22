"use client";

/**
 * The inline rename — E06 task 008. Four states, and the fourth one is specific.
 *
 * ── idle → editing → checking → resolved ─────────────────────────────────────
 * **idle** shows the address as text with one button. **editing** is the field
 * with something typed in it that has not settled. **checking** is the debounce
 * window — a real state, not a flicker, because a verdict that changes on every
 * keystroke reads as noise. **resolved** is either *accepted* or one of four
 * named refusals: bad shape, reserved, not allowed, or taken. Never a single
 * generic "invalid": a person who typed `My Page` and a person who typed `admin`
 * have different problems and only one of them is fixable by trying harder.
 *
 * ── THE INDICATOR IS ADVISORY. IT DOES NOT GATE SUBMIT. ──────────────────────
 * `checkChosenSlug` is pure — shape, reserved labels, profanity — and the PATCH
 * handler runs the identical function, so the local verdict is a courtesy that
 * saves a round trip, not a permission. **Availability is not in it at all**:
 * `owner-routes.ts` states the rule — "there is no pre-flight availability query,
 * and adding one would be a bug" — because `sites_slug_key` is the only authority
 * and a check that gates the write is a TOCTOU bug with a nice spinner. So Save
 * stays live, the request is always allowed to happen, and a name that was free
 * when this field last looked comes back from the server as **taken**.
 *
 * ── THE URL MOVES UNDER THE USER, SO THE CLIENT MUST NAVIGATE ────────────────
 * `/site/[slug]` is keyed by slug. `RenameResult` carries the new one precisely
 * so this component can `router.replace` onto it; without that the next
 * navigation 404s on the user's own page. `replace`, not `push` — the old
 * address is not a place to go Back to.
 *
 * ── ON ANY REFUSAL, NOTHING CHANGED ──────────────────────────────────────────
 * No navigation, no optimistic slug swap, no repainted address. The field keeps
 * what was typed so it can be corrected, and the page is still at the name it
 * was at. `renameSite` rolls its transaction back, so that is also true of the
 * database.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { siteHref } from "@/lib/sites/display";
import {
  checkChosenSlug,
  renameNotice,
  renamePage,
  type SlugRefusalReason,
} from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

/**
 * How long a typed name has to settle before the advisory verdict is computed.
 *
 * Long enough that the verdict does not strobe mid-word, short enough that it
 * has landed by the time a hand reaches the button. The **checking** state is
 * what is on screen for this window, so it is deliberately visible rather than
 * hidden behind an imperceptible delay.
 */
const SETTLE_MS = 350;

/** What the field is doing. The four states, named. */
type Phase = "idle" | "editing" | "checking" | "resolved" | "saving";

/**
 * Why a resolved name was refused.
 *
 * `shape`, `reserved` and `profanity` are `checkChosenSlug`'s three, computed in
 * the browser. `taken` and `refused` can only come back from the PATCH — the
 * first because `sites_slug_key` is the only authority on availability, the
 * second for every other answer the handler gives (a page under review, a store
 * that could not be written). Carried separately from the message so the state
 * is machine-readable in `data-reason` without anything parsing prose.
 */
type RefusalKind = SlugRefusalReason | "taken" | "refused";

/** A resolved verdict: allowed, or refused for one specific, named reason. */
type Verdict =
  | { kind: "accepted" }
  | { kind: "refused"; reason: RefusalKind; message: string };

export function RenameField({
  siteId,
  slug,
  hostSuffix,
  refusal,
  refusalId,
}: {
  siteId: string;
  slug: string;
  /** `.kept.host` and friends — split off the real host by the caller. */
  hostSuffix: string;
  /** Why renaming is unavailable on a flagged page, or `null`. */
  refusal: string | null;
  refusalId?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [value, setValue] = useState(slug);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fieldId = useId();
  const statusId = useId();

  // A pending debounce or an in-flight PATCH outliving this component would
  // resolve into a `setState` on something that is gone.
  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      abort.current?.abort();
    };
  }, []);

  const editing = phase !== "idle";
  const busy = phase === "saving";
  const unchanged = value.trim() === slug;

  function startEditing() {
    setNotice(null);
    setVerdict(null);
    setValue(slug);
    setPhase("editing");
    // The field is rendered by this same pass, so focus is taken on the next
    // frame rather than in the click handler.
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function cancel() {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    abort.current?.abort();
    setPhase("idle");
    setValue(slug);
    setVerdict(null);
  }

  function onChange(next: string) {
    setValue(next);
    setVerdict(null);
    setNotice(null);
    if (settleTimer.current) clearTimeout(settleTimer.current);

    const candidate = next.trim();
    if (candidate === "" || candidate === slug) {
      setPhase("editing");
      return;
    }

    setPhase("checking");
    settleTimer.current = setTimeout(() => {
      // ADVISORY. The same pure function the PATCH handler runs, computed here
      // only to answer sooner — never to decide whether the PATCH may be sent.
      const refused = checkChosenSlug(candidate);
      setVerdict(
        refused
          ? { kind: "refused", reason: refused.reason, message: refused.message }
          : { kind: "accepted" },
      );
      setPhase("resolved");
    }, SETTLE_MS);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const candidate = value.trim();
    if (candidate === "") return;

    // Whatever the advisory verdict says, the request goes. See the header:
    // the server runs the identical shape check and is the only authority on
    // availability, so gating here would only ever hide the real answer.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setPhase("saving");
    setNotice(null);

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    const outcome = await renamePage(siteId, candidate, controller.signal);
    if (controller.signal.aborted) return;

    if (!outcome.ok) {
      // The handler's own sentence, never flattened — a 409 says "taken" or
      // says the page is under review, and both are the answer, not a failure
      // to report. Nothing has changed and nothing here pretends otherwise.
      setPhase("resolved");
      setVerdict({
        kind: "refused",
        // The only signal the closed error enum leaves for "somebody has that
        // name" is the handler's own 409 sentence, which `owner-routes.ts`
        // writes as `"<slug>" is already taken.` — matched here ONLY to label
        // the state, never to build the message shown, which stays the
        // handler's verbatim.
        reason: /already taken/i.test(outcome.error.message) ? "taken" : "refused",
        message: outcome.error.message,
      });
      return;
    }

    // Measured and truthful: the old address keeps working for a couple of
    // minutes in the worst case and nobody following an old link is dropped.
    // `renameNotice` owns that sentence and derives its bound from the KV cache
    // TTL — it must never be tightened into an instant cutover.
    setNotice(renameNotice(outcome.page));
    setPhase("idle");
    setVerdict(null);
    // The route is keyed by slug. Without this the next navigation 404s on the
    // user's own page.
    router.replace(siteHref(outcome.page.slug));
  }

  return (
    <section className="rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] md:p-6">
      <h2 className="font-display text-base font-semibold text-text">Address</h2>
      <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
        Give this page a name people can read. The old address keeps working for a
        couple of minutes afterwards, so nothing already shared breaks in the
        meantime.
      </p>

      {refusal ? (
        <p className="mt-4 text-sm leading-relaxed text-text-secondary">{refusal}</p>
      ) : null}

      {!editing ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="mono-label min-w-0 break-all text-sm text-text">
            {slug}
            <span className="text-text-muted">{hostSuffix}</span>
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="rename-start"
            disabled={refusal !== null}
            aria-describedby={refusal ? refusalId : undefined}
            onClick={startEditing}
          >
            <Pencil aria-hidden="true" />
            Rename
          </Button>
        </div>
      ) : (
        <form onSubmit={save} className="mt-4">
          <label htmlFor={fieldId} className="mono-label text-[11px] text-text-muted">
            New address
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                ref={inputRef}
                id={fieldId}
                name="slug"
                value={value}
                data-testid="rename-input"
                disabled={busy}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={statusId}
                aria-invalid={verdict?.kind === "refused" ? true : undefined}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancel();
                }}
                className="min-w-0 flex-1 font-mono"
              />
              <span className="mono-label shrink-0 text-xs text-text-muted">
                {hostSuffix}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                data-testid="rename-save"
                // Disabled only for the two cases where there is nothing to
                // send — an empty box, or the name it already has. The advisory
                // verdict never disables this button.
                disabled={busy || value.trim() === "" || unchanged}
              >
                {busy ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : null}
                {busy ? "Renaming…" : "Save"}
              </Button>
            </div>
          </div>

          {/* One live region for all four resolutions, polite because the
              person is still typing and a assertive interruption per keystroke
              would be unusable. */}
          <p
            id={statusId}
            aria-live="polite"
            data-testid="rename-status"
            data-phase={phase}
            data-reason={verdict?.kind === "refused" ? verdict.reason : undefined}
            className={cn(
              "mt-2.5 min-h-[1.25rem] text-xs leading-relaxed",
              verdict?.kind === "refused" ? "text-danger" : "text-text-secondary",
            )}
          >
            {phase === "checking" ? (
              "Checking that name…"
            ) : phase === "saving" ? (
              "Moving the page…"
            ) : verdict?.kind === "accepted" ? (
              <span className="inline-flex items-center gap-1.5 text-live">
                <Check aria-hidden="true" className="size-3.5" />
                That name is allowed. kept confirms it is free when you save.
              </span>
            ) : verdict?.kind === "refused" ? (
              verdict.message
            ) : unchanged ? (
              "This is the page's current address."
            ) : (
              ""
            )}
          </p>
        </form>
      )}

      {notice ? (
        <p
          data-testid="rename-notice"
          className="mt-3 rounded-[var(--r-md)] border border-accent bg-accent-soft px-4 py-3 text-sm leading-relaxed text-text"
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}
