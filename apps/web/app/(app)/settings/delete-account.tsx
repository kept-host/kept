"use client";

/**
 * The only irreversible act in the product — E06 task 012, epic decision **D3**.
 *
 * ── TWO CONFIRMATIONS, NOT ONE, AND THAT IS THE DECISION ─────────────────────
 * D3 requires both, and a bare "are you sure?" is explicitly not acceptable:
 *
 *   1. **An explanatory dialog stating the REAL counts** — "this destroys 3 kept
 *      pages and 2 drafts" — read from `getAccountDeletionSummary()` in the
 *      server component at render time. Never a generic warning, never a number
 *      typed into copy.
 *   2. **A type-to-confirm input.** The destructive button stays disabled until
 *      what was typed matches the phrase **exactly** — no trim, no case-folding,
 *      no "close enough". The typing IS the deliberation.
 *
 * Cancelling at either stage sends nothing. Stage two is reached by a press, not
 * by scrolling past stage one, so there is a real second decision.
 *
 * ── THE PHRASE IS NOT WRITTEN HERE ───────────────────────────────────────────
 * It arrives on the summary, which reads `ACCOUNT_DELETION_CONFIRMATION` from
 * `@kept/shared` — the same constant `accountDeletionRequestSchema` parses the
 * request body against. One value, so this button can never enable on a string
 * the server would refuse, and changing the words moves both halves at once.
 *
 * ⚠️ THE INPUT DISABLES AUTOCAPITALISE, AUTOCORRECT AND SPELLCHECK. The server
 * compares exactly, so a phone helpfully capitalising the first letter would
 * make a correctly-typed phrase fail with no visible reason. That is a
 * correctness requirement here, not a nicety.
 *
 * ── THE COPY IS TRUE ABOUT THE BYTES ─────────────────────────────────────────
 * E07's purge job does not exist yet, so a deleted account's R2 objects
 * legitimately persist until it ships. *"your pages stop being served
 * immediately; the files are erased shortly after"* is true and is the sentence
 * shipped below. **"erased immediately" would be a lie** and must not appear
 * here however tempting it reads.
 *
 * ── AND THE USER DOES NOT STAY IN A SHELL THEY NO LONGER HAVE ────────────────
 * On success: sign out, then a full-document navigation to the apex. Not
 * `router.replace` — the destination is a different origin once the deploy has
 * two hostnames, and a hard load is also what discards every RSC payload
 * rendered while the account still existed.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInHref } from "@/lib/auth/return-path";
import { signOut } from "@/lib/auth/client";
import { deleteAccount } from "@/lib/sites/owner-client";

/**
 * The counts, as the server component serialises them.
 *
 * Structurally the `AccountDeletionSummary` from `lib/sites/account-deletion.ts`
 * — restated here rather than type-imported, for the reason every client island
 * in this epic restates its props: that module reaches Postgres, R2 and KV, and
 * this file must not name it even in a position the compiler erases.
 */
export interface DeletionSummaryView {
  /** Permanent pages, from the same predicate the quota is counted with. */
  kept: number;
  /** `expires_at != null`. */
  drafts: number;
  /**
   * Every page the account owns, in every status.
   *
   * ⚠️ NOT NECESSARILY `kept + drafts`. An archived or quarantined page with no
   * clock is in neither bucket, so the copy below names the two a person
   * recognises and then states `total` on its own rather than implying a sum.
   */
  total: number;
  /** From `@kept/shared`. Compared exactly, never trimmed or case-folded. */
  confirmationPhrase: string;
}

/** "1 draft" / "4 drafts" — plain plurals, no library. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * What is about to be destroyed, in the account's own real numbers.
 *
 * ⚠️ NO HARDCODED NUMBER ANYWHERE IN THIS FUNCTION. Every figure comes off the
 * summary the server read at render time; a generic "all your pages" would fail
 * D3 on the one screen where being believed matters most.
 */
function destroysSentence(summary: DeletionSummaryView): string {
  if (summary.total === 0) {
    return "There is nothing published on this account, so no page goes offline. Your sign-in details, your connected providers and everything else we hold go, and that is all.";
  }

  const other = summary.total - summary.kept - summary.drafts;
  const head = `This destroys ${count(summary.kept, "kept page")} and ${count(summary.drafts, "draft")}`;
  if (other <= 0) return `${head}.`;

  // Archived or flagged rows have no clock and are not kept, so they belong to
  // neither figure above — but the teardown takes them too, and `total` is the
  // number that says so.
  return `${head}, plus ${count(other, "page")} that ${other === 1 ? "is" : "are"} archived or flagged — ${summary.total} in all.`;
}

/** Which half of the gate is showing. `none` is a closed dialog. */
type Stage = "none" | "explain" | "confirm";

export function DeleteAccount({
  summary,
  /** The apex, from configuration — never derived from the request. */
  farewellHref,
}: {
  summary: DeletionSummaryView;
  farewellHref: string;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("none");
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  // The second stage is a typing task, so the caret belongs in the field the
  // moment it appears — a keyboard user should not have to hunt for it.
  useEffect(() => {
    if (stage === "confirm") inputRef.current?.focus();
  }, [stage]);

  /** Exact equality. Deliberately not `.trim()` — see the header. */
  const armed = typed === summary.confirmationPhrase;
  /** Typed the right words the wrong way. Worth saying; not worth guessing at. */
  const nearMiss =
    !armed &&
    typed.length > 0 &&
    typed.trim().toLowerCase() === summary.confirmationPhrase.toLowerCase();

  function close() {
    if (pending || done) return;
    setStage("none");
    setTyped("");
    setError(null);
  }

  async function destroy() {
    if (!armed || pending) return;
    setPending(true);
    setError(null);

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const outcome = await deleteAccount(typed, controller.signal);

    if (!outcome.ok) {
      setPending(false);
      if (outcome.signedOut) {
        // The session went while the dialog was open. Nothing was deleted; the
        // only useful move is the sign-in screen, with a way back to here.
        router.replace(signInHref("/settings"));
        return;
      }
      // The route's own sentence, verbatim. It differs per failure and each one
      // is honest about what did or did not change: a refused phrase (400), a
      // foreign origin (403), an edge that would not let go (503, nothing
      // deleted), or a teardown that stopped half way (500, retry finishes it).
      setError(outcome.error.message);
      return;
    }

    // Deliberately NOT clearing `pending`: the account is gone and this screen
    // is about to be replaced. Re-enabling the button would invite a second call
    // that can only fail.
    setDone(true);
    // The session row went with the user row, so this mostly just clears the
    // cookie; a failure here must not strand somebody on a dead screen.
    await signOut().catch(() => undefined);
    window.location.replace(farewellHref);
  }

  return (
    <section
      data-testid="delete-account-panel"
      className="rounded-[var(--r-lg)] border border-danger bg-surface p-6 shadow-[var(--shadow-sm)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-4">
        <h2 className="font-display text-xl font-semibold text-text">
          Delete this account
        </h2>
        <p className="mono-label text-[11px] text-danger">Cannot be undone</p>
      </div>

      <p className="mt-5 max-w-[62ch] leading-relaxed text-text-secondary">
        {destroysSentence(summary)}
      </p>
      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
        Deleting one page archives it and keeps the file for you. Deleting the
        whole account does not — there would be nobody left to give it back to.
        {summary.total > 0
          ? " If you want your files, download them from each page first."
          : ""}
      </p>

      <Button
        type="button"
        variant="ghost"
        data-testid="delete-account-open"
        onClick={() => {
          setError(null);
          setTyped("");
          setStage("explain");
        }}
        className="mt-5 text-danger hover:bg-sunken hover:text-danger"
      >
        <Trash2 aria-hidden="true" />
        Delete my account
      </Button>

      <Dialog
        open={stage !== "none"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent
          data-testid="delete-account-dialog"
          className="max-w-lg"
          // Escape, the overlay and the close button all funnel through the same
          // refusal while a teardown is in flight: abandoning a request that may
          // already have committed leaves this screen unable to say what
          // happened, on the one action where that is unforgivable.
          onEscapeKeyDown={(event) => {
            if (pending || done) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending || done) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending || done) event.preventDefault();
          }}
        >
          {done ? (
            <div role="status">
              <DialogHeader>
                <p className="mono-label text-[11px] text-text-muted">Deleted</p>
                <DialogTitle>Your account is gone</DialogTitle>
                <DialogDescription>
                  Everything it held has stopped being served. Taking you back to
                  kept now. Thank you for trying it.
                </DialogDescription>
              </DialogHeader>
            </div>
          ) : stage === "explain" ? (
            <>
              <DialogHeader>
                <p className="mono-label text-[11px] text-danger">
                  Permanent · no undo
                </p>
                <DialogTitle>Delete your kept account?</DialogTitle>
                <DialogDescription data-testid="delete-account-counts">
                  {destroysSentence(summary)}
                </DialogDescription>
              </DialogHeader>

              <p className="text-sm leading-relaxed text-text-secondary">
                Every one of those links stops working the moment you confirm —
                including permanent ones other people may have saved or linked
                to. Your pages stop being served immediately; the files are
                erased shortly after.
              </p>
              <p className="text-sm leading-relaxed text-text-secondary">
                There is no way to put an account back, and nothing is kept aside
                for you to download later.
              </p>

              <DialogFooter>
                <Button type="button" variant="secondary" onClick={close}>
                  Keep my account
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="delete-account-continue"
                  onClick={() => {
                    setError(null);
                    setStage("confirm");
                  }}
                >
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <p className="mono-label text-[11px] text-danger">
                  Last step · no undo
                </p>
                <DialogTitle>Type the words to confirm</DialogTitle>
                <DialogDescription>
                  {summary.total > 0
                    ? `${count(summary.total, "page")} and this account will be destroyed. Nothing is sent until the words below match.`
                    : "This account will be destroyed. Nothing is sent until the words below match."}
                </DialogDescription>
              </DialogHeader>

              <div>
                <Label htmlFor={inputId} className="mb-2 block text-text-muted">
                  Confirmation
                </Label>
                {/* ⚠️ THE PHRASE IS RENDERED OUTSIDE THE `Label`, ON PURPOSE.
                    The kept label style is `uppercase`, and a phrase the server
                    compares case-sensitively must never be shown in a case
                    nobody can type. Here it is mono, lower case, exactly as it
                    must be entered. */}
                <p
                  id={`${inputId}-instruction`}
                  className="mb-2 text-sm leading-relaxed text-text-secondary"
                >
                  Type{" "}
                  <code className="rounded-[var(--r-sm)] bg-sunken px-1.5 py-0.5 font-mono text-[0.8125rem] normal-case tracking-normal text-text">
                    {summary.confirmationPhrase}
                  </code>{" "}
                  exactly as it appears.
                </p>
                <Input
                  id={inputId}
                  ref={inputRef}
                  data-testid="delete-account-input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  disabled={pending}
                  // Every one of these is load-bearing: the server compares the
                  // string exactly, so a keyboard that capitalises, corrects or
                  // underlines it is a keyboard fighting the user.
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={
                    nearMiss
                      ? `${inputId}-instruction ${inputId}-hint`
                      : `${inputId}-instruction`
                  }
                  className="h-auto rounded-[var(--r-sm)] bg-sunken py-[0.8125rem] text-[0.9375rem] shadow-none"
                />
                {nearMiss ? (
                  <p
                    id={`${inputId}-hint`}
                    className="mt-2 text-xs leading-relaxed text-text-muted"
                  >
                    Almost — it has to match exactly: all lower case, no extra
                    spaces.
                  </p>
                ) : null}
              </div>

              {error ? (
                <p
                  role="alert"
                  data-testid="delete-account-error"
                  className="text-xs leading-relaxed text-danger"
                >
                  {error}
                </p>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setTyped("");
                    setError(null);
                    setStage("explain");
                  }}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="delete-account-confirm"
                  disabled={!armed || pending}
                  onClick={() => void destroy()}
                >
                  {pending ? "Deleting…" : "Delete my account"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
