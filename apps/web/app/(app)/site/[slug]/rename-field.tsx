"use client";

/**
 * The inline rename — E06 task 008, rewired by task 006 to the names module.
 * Four states, and the fourth one is specific.
 *
 * ── idle → editing → checking → resolved ─────────────────────────────────────
 * **idle** shows the address as text with one button. **editing** is the field
 * with something typed in it that has not settled. **checking** is the debounce
 * window plus the `GET /api/names/check` round trip — a real state, not a
 * flicker, because a verdict that changes on every keystroke reads as noise.
 * **resolved** is one of PRD §5.4's statuses with its own sentence
 * (`nameStatusMessage`). Never a single generic "invalid": a person who typed
 * `My Page` and a person who typed `admin` have different problems and only one
 * of them is fixable by trying harder.
 *
 * ── THE INDICATOR IS ADVISORY. IT DOES NOT GATE SUBMIT. ──────────────────────
 * The check is the server's own decision — the name rule, availability, quota
 * and the daily limit — but it is a READ, and the rename re-asks under its
 * locks. A name free when this field last looked can be gone by the save, and
 * then the PATCH answers `name_taken` with the same sentence. So Save stays
 * live and the request is always allowed to happen.
 *
 * ── THE URL MOVES UNDER THE USER, SO THE CLIENT MUST NAVIGATE ────────────────
 * This screen's route is keyed by slug (task 012 moves it to the page id). The
 * PATCH returns the renamed `site`, so this component can `router.replace` onto
 * its new slug; without that the next navigation 404s on the user's own page. `replace`, not `push` — the old
 * address is not a place to go Back to.
 *
 * ── ⚠️ …AND THE NAVIGATION TAKES THIS COMPONENT'S STATE WITH IT ──────────────
 * Found by task 013's browser drill: `/site/a` → `/site/b` is a change of
 * dynamic segment VALUE, so the App Router replaces that subtree and every
 * client component under it remounts. A `setNotice(...)` immediately before
 * `router.replace(...)` is therefore discarded ~instantly, and the success copy
 * was never once seen by a user.
 *
 * So the notice travels **in the URL** and is rebuilt on the other side, which
 * is exactly how `/settings` already carries `?linked=` and `?error=` across
 * Better Auth's OAuth round trip: the server component reads the parameter and
 * hands it down as a prop, and no client component parses `location` itself.
 * `renamedFrom` only says "this navigation is the rename's"; `renameNotice`
 * needs nothing beyond the `liveUrl` this component already has.
 *
 * The no-op rename (a page renamed to the name it already has) does NOT
 * navigate, so its notice is set directly — there is no remount to survive.
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
import type { NameCheckStatus } from "@kept/shared";

import { nameStatusMessage } from "@/lib/names/messages";
import { siteHref } from "@/lib/sites/display";
import { checkName, renameNotice, renamePage } from "@/lib/sites/owner-client";
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
 * Why a resolved name was refused: the check status that refused it, or
 * `refused` for an answer that is not a name status (a page under review, a
 * store that could not be written, a check that could not run). Carried apart
 * from the message so the state is machine-readable in `data-reason` without
 * anything parsing prose.
 */
type RefusalKind = Exclude<NameCheckStatus, "available" | "held_for_you"> | "refused";

/** A resolved verdict: allowed (free, or yours to take back), or refused for one named reason. */
type Verdict =
  | { kind: "accepted"; message: string }
  | { kind: "refused"; reason: RefusalKind; message: string };

export function RenameField({
  siteId,
  slug,
  liveUrl,
  hostSuffix,
  refusal,
  refusalId,
  renamedFrom,
}: {
  siteId: string;
  slug: string;
  /** The page's public address, built by the server from configuration. */
  liveUrl: string;
  /** `.kept.host` and friends — split off the real host by the caller. */
  hostSuffix: string;
  /** Why renaming is unavailable on a flagged page, or `null`. */
  refusal: string | null;
  refusalId?: string;
  /**
   * The slug this page was renamed *from*, when the current navigation is the
   * one the rename itself performed. Read from `?renamedFrom=` by the server
   * component — see the header. `null` on an ordinary visit.
   */
  renamedFrom?: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [value, setValue] = useState(slug);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // Seeded from the URL so the success copy survives the remount the rename's
  // own navigation causes. `renameNotice` is the single owner of the sentence
  // either way; nothing here composes a second version of it.
  const [notice, setNotice] = useState<string | null>(() =>
    renamedFrom && renamedFrom !== slug ? renameNotice({ liveUrl }) : null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const checking = useRef<AbortController | null>(null);
  const fieldId = useId();
  const statusId = useId();

  // A pending debounce, check or PATCH outliving this component would resolve
  // into a `setState` on something that is gone.
  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      checking.current?.abort();
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
    checking.current?.abort();
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
    checking.current?.abort();

    const candidate = next.trim();
    if (candidate === "" || candidate === slug) {
      setPhase("editing");
      return;
    }

    setPhase("checking");
    settleTimer.current = setTimeout(async () => {
      // ADVISORY. The server's own answer, shown sooner — never a decision on
      // whether the PATCH may be sent.
      const controller = new AbortController();
      checking.current = controller;
      const outcome = await checkName(siteId, candidate, controller.signal);
      if (controller.signal.aborted) return;

      if (!outcome.ok) {
        setVerdict({ kind: "refused", reason: "refused", message: outcome.error.message });
      } else {
        const { result } = outcome;
        const message = nameStatusMessage(result, candidate, hostSuffix);
        setVerdict(
          result.status === "available" || result.status === "held_for_you"
            ? { kind: "accepted", message }
            : { kind: "refused", reason: result.status, message },
        );
      }
      setPhase("resolved");
    }, SETTLE_MS);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const candidate = value.trim();
    if (candidate === "") return;

    // Whatever the advisory verdict says, the request goes. See the header: the
    // rename re-asks under its locks, so gating here could only hide its answer.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    checking.current?.abort();
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
        // The studio envelope's `code` labels the state; the message shown
        // stays the handler's verbatim.
        reason: outcome.error.code === "name_taken" ? "taken" : "refused",
        message: outcome.error.message,
      });
      return;
    }

    setPhase("idle");
    setVerdict(null);

    if (outcome.site.slug === slug) {
      // A no-op rename does not move the route, so nothing remounts and the
      // notice can simply be set.
      setNotice(renameNotice(outcome.site));
      return;
    }

    // The route is keyed by slug. Without this the next navigation 404s on the
    // user's own page — and because the segment value changes, this component
    // is about to be replaced, so the notice goes in the URL rather than in
    // state that is a millisecond from being discarded. See the header.
    router.replace(
      `${siteHref(outcome.site.slug)}?renamedFrom=${encodeURIComponent(slug)}`,
    );
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
                {verdict.message}
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
