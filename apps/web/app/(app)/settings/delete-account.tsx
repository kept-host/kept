"use client";

/**
 * Delete account — the only irreversible act in the product, epic decision
 * **D16** (PRD §5.8). E06 task 008 switched its gate to the account email; task
 * 013 restyled it to `kept Settings Screen.dc.html` (section `danger`) and owns
 * its copy.
 *
 * ── WHAT THE CARD SAYS, AND WHAT THE DESIGN SAID ────────────────────────────
 * The design's "Here's exactly what happens:" list, with the account's REAL
 * counts read at render time (never a generic warning, never a typed number).
 * Three of the design's lines are wrong for this product and are not rendered
 * (each is a PR note): "download everything for 30 days from the link we email
 * you" (D13 — exports are streamed, nothing is emailed, and after deletion there
 * is nobody to give a file back to), "addresses are released after 30 days"
 * (D4/D16 — names are held for 12 months), and "Remixes … stay theirs" (no
 * remixes until a later epic).
 *
 * ── THE GATE IS THE ACCOUNT EMAIL, IN A DIALOG ──────────────────────────────
 * The PRD's dialog, not the design's inline `delete {handle}` (there is no
 * handle until E10). The destructive button stays disabled until the typed
 * value matches (`confirmsAccountEmail` from `@kept/shared` — the rule the route
 * refuses with, so this button can never arm on a value the server would
 * refuse). Cancelling sends nothing.
 *
 * ── AND THE USER DOES NOT STAY IN A SHELL THEY NO LONGER HAVE ────────────────
 * The route clears the session cookie with its 200; this then makes a
 * full-document navigation to the apex — a different origin once the deploy has
 * two hostnames, and a hard load discards every RSC payload rendered while the
 * account existed.
 */
import { confirmsAccountEmail } from "@kept/shared";
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
import { signInHref } from "@/lib/auth/return-path";
import { NAME_HOLD_PERIOD } from "@/lib/names/messages";
import { deleteAccount } from "@/lib/sites/owner-client";

import { SettingsCard } from "./settings-card";

/**
 * The counts, as the server component serialises them — structurally
 * `AccountDeletionSummary` from `lib/sites/account-deletion.ts`, restated rather
 * than type-imported because that module reaches Postgres, R2 and KV.
 */
export interface DeletionSummaryView {
  /** Permanent pages, from the predicate the kept cap counts with. */
  kept: number;
  /** `expires_at != null`. */
  drafts: number;
  /** Every page the deletion takes offline: `kept + drafts`. */
  total: number;
}

/** D4/D16: chosen names go into a hold, not straight back into the pool. */
const NAMES_HELD = `Your page names are held for ${NAME_HOLD_PERIOD} before anyone else can take them.`;

/** PRD §5.8, verbatim. */
const DELETE_ACCOUNT_COPY = `All your pages go offline within about 2 minutes. You can't undo this. ${NAMES_HELD}`;

/** "1 draft" / "4 drafts" — plain plurals, no library. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The design's list, in this account's own numbers and the PRD's rules. */
function consequences(summary: DeletionSummaryView): readonly string[] {
  return [
    summary.total === 0
      ? "Nothing is published on this account, so no page goes offline."
      : `Your ${count(summary.kept, "kept page")} and ${count(summary.drafts, "draft")} go offline and are archived.`,
    NAMES_HELD,
    "Nothing can be downloaded afterwards. Export everything first if you want a copy.",
  ];
}

export function DeleteAccount({
  summary,
  /** The signed-in account's address — what must be typed. */
  email,
  /** The apex, from configuration — never derived from the request. */
  farewellHref,
}: {
  summary: DeletionSummaryView;
  email: string;
  farewellHref: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  const armed = confirmsAccountEmail(typed, email);

  function close() {
    if (pending) return;
    setOpen(false);
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
    const outcome = await deleteAccount({ email: typed }, controller.signal);

    if (!outcome.ok) {
      setPending(false);
      if (outcome.signedOut) {
        // The session went while the dialog was open. Nothing was deleted.
        router.replace(signInHref("/settings"));
        return;
      }
      // The route's own sentence, verbatim: a mismatched email (400), an edge
      // that would not let go (503, nothing deleted), a teardown that stopped
      // half way (500, retry finishes it) — or "Couldn't save. Try again."
      setError(outcome.error.message);
      return;
    }

    // `pending` stays true: the account is gone and this screen is about to be
    // replaced, so nothing here may be pressed again.
    window.location.replace(farewellHref);
  }

  return (
    <SettingsCard title="Delete account" danger data-testid="delete-account-panel">
      <p className="text-[15px] text-text">Here&rsquo;s exactly what happens:</p>
      <ul className="flex flex-col gap-2 text-[15px] leading-[1.45] text-text">
        {consequences(summary).map((line, index) => (
          <li
            key={line}
            data-testid={index === 0 ? "delete-account-counts" : undefined}
            className="flex gap-2.5"
          >
            <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 rounded-full bg-danger" />
            {line}
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="secondary"
        data-testid="delete-account-open"
        onClick={() => {
          setError(null);
          setTyped("");
          setOpen(true);
        }}
        className="h-10 self-start rounded-[var(--r-md)] border-danger px-4 font-body font-medium"
      >
        <Trash2 aria-hidden="true" strokeWidth={1.5} className="text-danger" />
        Delete my account
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent
          data-testid="delete-account-dialog"
          className="max-w-lg"
          // Escape, the overlay and the close button all refuse while a
          // teardown is in flight: abandoning a request that may already have
          // committed would leave this screen unable to say what happened.
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription data-testid="delete-account-copy">{DELETE_ACCOUNT_COPY}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm text-text">
              Type <span className="break-all font-mono font-medium">{email}</span> to confirm
            </label>
            <Input
              id={inputId}
              data-testid="delete-account-input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={pending}
              type="email"
              // A keyboard that corrects or underlines an address is a keyboard
              // fighting the user.
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              className="h-11 rounded-[var(--r-sm)] font-mono text-sm shadow-none"
            />
            {error ? (
              <p
                id={`${inputId}-error`}
                role="alert"
                data-testid="delete-account-error"
                className="text-[13px] leading-relaxed text-danger"
              >
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="delete-account-confirm"
              disabled={!armed || pending}
              onClick={() => void destroy()}
            >
              <Trash2 aria-hidden="true" strokeWidth={1.5} />
              {pending ? "Deleting…" : "Delete my account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}
