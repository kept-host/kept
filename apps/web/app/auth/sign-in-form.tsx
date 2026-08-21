"use client";

/**
 * The sign-in card — E05 task 005. Ported from `kept Auth.dc.html`.
 *
 * ── WHAT THIS FILE OWNS ────────────────────────────────────────────────────
 * Three routes (GitHub, Google, email magic link) and every state the screen
 * can be in: **idle · redirecting · sending · sent · error · signed-in**. The
 * shell around it — header, mascot, footer line — is the server component in
 * `./page.tsx`, which has no session dependency at all.
 *
 * ── NO SILENT SPINNER, ANYWHERE ────────────────────────────────────────────
 * Every failure path below terminates in the `error` phase with a sentence a
 * human can act on and a button that does the acting. That is the epic's
 * verification criterion 13 and the reason task 003's `sendMagicLink` rejects
 * instead of swallowing a Resend failure: the rejection has to arrive somewhere
 * visible, and this is that somewhere. Two shapes of failure reach us:
 *   - **In-flight** — `signIn.*` resolves with an `error`. We never left the
 *     page, so we set the phase directly.
 *   - **Round-trip** — the provider or the magic-link verifier bounced the user
 *     back to `/auth?...&error=CODE` (`errorCallbackURL`, threaded through
 *     Better Auth's OAuth state and the magic-link verify handler). `page.tsx`
 *     reads the parameter and hands it in as `initialErrorCode`.
 *
 * ── THE SESSION IS READ IN THE BROWSER, ON PURPOSE ─────────────────────────
 * `useSession()` rather than a server-side `getSession()` in `page.tsx`. The
 * server helper constructs the Better Auth instance, which validates all eight
 * auth variables — so on a control plane with a missing or wrong auth variable
 * the *sign-in page itself* would be the thing that 500s, exactly when a user
 * most needs it to render. Reading client-side makes a broken session endpoint
 * degrade to "signed out": the three routes still draw, and the user still gets
 * a real error the moment they try one, rather than a blank page.
 *
 * ── EVERY AUTH CALL GOES THROUGH `lib/auth/client.ts` ──────────────────────
 * No `createAuthClient` here, and no hand-rolled `next` validation either —
 * `safeReturnPath` / `signInHref` (task 004) are the open-redirect guard and
 * this screen is one of the two places that reads the parameter.
 */
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, Mail } from "lucide-react";

import {
  AUTH_PROVIDERS,
  ProviderButton,
  type AuthProviderRoute,
} from "@/components/kept/provider-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, useSession } from "@/lib/auth/client";
import { signInHref } from "@/lib/auth/return-path";

/**
 * How long a magic link is good for, in words. Better Auth's `magicLink`
 * plugin defaults to 300 s and `lib/auth/index.ts` does not override it — the
 * email it sends says "expires in 5 minutes", and the error copy below has to
 * agree with the email the user is looking at.
 */
const MAGIC_LINK_LIFETIME = "5 minutes";

/**
 * Seconds before "resend" becomes live again.
 *
 * THIS IS A BUDGET CONTROL, NOT A NICETY. Resend's free tier is 100 sends a
 * day and task 011's reminder cron spends from the same 100. An impatient user
 * tapping resend four times has taken 4% of the day, and the failure it causes
 * — a magic link that never arrives because the quota is gone — is
 * indistinguishable from a broken product. Sixty seconds also comfortably
 * covers ordinary delivery latency, so the button is never the reason someone
 * gives up.
 */
const RESEND_COOLDOWN_SECONDS = 60;

type Phase =
  | { kind: "idle" }
  | { kind: "redirecting"; provider: AuthProviderRoute }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; code: string };

type ErrorCopy = {
  heading: string;
  body: string;
  retryLabel: string;
  /**
   * `resend` — the fault was in the magic-link route, so the fix is another
   * link (and we send it straight away when we still know the address).
   * `restart` — the fault was upstream of any address we hold, so the fix is
   * the idle card with all three routes on it.
   */
  retryWith: "resend" | "restart";
};

/**
 * Keys are lowercased before lookup: Better Auth emits OAuth codes in snake
 * case (`account_not_linked`) and magic-link codes in upper case
 * (`INVALID_TOKEN`), and both arrive in the same query parameter.
 */
const ERROR_COPY: Record<string, ErrorCopy> = {
  /** The provider bounced us back — declined consent, or a closed window. */
  access_denied: {
    heading: "Sign-in was cancelled",
    body: "The provider did not finish the hand-off — either consent was declined or the window closed early. Nothing changed on this end, and nothing was shared with us.",
    retryLabel: "Try again",
    retryWith: "restart",
  },
  /**
   * D2's refusal, made legible. The security property is that we did *not*
   * link; the copy's job is to stop that reading as "kept is broken" and to
   * name the one route that does work. It deliberately does not link to a
   * settings screen — manual linking is E06, and promising a page that does
   * not exist is the other way to lose this user.
   */
  account_not_linked: {
    heading: "That email already has an account",
    body: "There is already a kept account on this address, and the provider you just used does not confirm the address is yours — so we did not join the two. Sign in the way you did the first time; you can link this provider from settings once you are in.",
    retryLabel: "Back to sign in",
    retryWith: "restart",
  },
  /** The provider authenticated the user but shared no address. */
  email_not_found: {
    heading: "We did not get an email address",
    body: "That provider signed you in but shared no address, and kept needs one to reach you about your pages. Make an address public on that account, or use a magic link instead.",
    retryLabel: "Try another way",
    retryWith: "restart",
  },
  /**
   * A magic link that no longer opens. Better Auth 1.6.26 consumes the token
   * row on use and reports the row's absence as `INVALID_TOKEN`, so a **reused**
   * link and an **expired** one arrive under this one code — the copy therefore
   * names both causes rather than guessing at one. `expired_token` below is
   * kept for the day the plugin distinguishes them.
   */
  invalid_token: {
    heading: "That link no longer works",
    body: `Magic links open once and last ${MAGIC_LINK_LIFETIME}, so the one you clicked was either already used or past its window. Nothing is wrong with your account — we will send a fresh link.`,
    retryLabel: "Send a new link",
    retryWith: "resend",
  },
  expired_token: {
    heading: "That link expired",
    body: `Magic links last ${MAGIC_LINK_LIFETIME} for safety. No problem — we will send a fresh one.`,
    retryLabel: "Send a new link",
    retryWith: "resend",
  },
  /** Task 003's `sendMagicLink` rejected: Resend refused the send. */
  send_failed: {
    heading: "We could not send that email",
    body: "The email service turned the message down. Nothing is wrong with your account, and no link was issued — give it a moment and try again.",
    retryLabel: "Try again",
    retryWith: "resend",
  },
  /** `signIn.social` never got as far as a redirect. */
  provider_unreachable: {
    heading: "We could not reach that provider",
    body: "kept could not start the hand-off, so you were never sent anywhere and nothing was shared. Try again, or sign in with a magic link instead.",
    retryLabel: "Try again",
    retryWith: "restart",
  },
};

const GENERIC_ERROR: ErrorCopy = {
  heading: "That did not work",
  body: "Something went wrong on the way to signing you in. Nothing has changed — any pages you have are exactly where they were.",
  retryLabel: "Back to sign in",
  retryWith: "restart",
};

function errorCopy(code: string): ErrorCopy {
  return ERROR_COPY[code.toLowerCase()] ?? GENERIC_ERROR;
}

/** Enough to stop an obvious typo reaching Resend; the server decides the rest. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function SignInForm({
  returnTo,
  initialErrorCode,
  keepNotice,
}: {
  /** Already validated by `safeReturnPath` in `./page.tsx`. */
  returnTo: string;
  /** `?error=` from a bounced round trip, or `null`. */
  initialErrorCode?: string | null;
  /**
   * THE TASK 009 SLOT. A page being kept arrives here mid-flow and needs one
   * line of reassurance in place of the generic subtitle — "We'll attach this
   * page to your account — it stays exactly where it is." Task 009 mounts this
   * same component from `/auth/keep` and passes it; nothing else about the
   * screen changes, which is the point of leaving a prop rather than a branch.
   */
  keepNotice?: string;
}) {
  const router = useRouter();
  const { data: session } = useSession();

  const [phase, setPhase] = useState<Phase>(() =>
    initialErrorCode ? { kind: "error", code: initialErrorCode } : { kind: "idle" },
  );
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const emailRef = useRef<HTMLInputElement>(null);

  // One timer at a time, cleared on every tick and on unmount — a phase change
  // mid-countdown must not leave an interval running against a dead component.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Already signed in: this screen has nothing to offer, so it hands the
  // visitor on to wherever they were going. The panel below is still rendered
  // so the navigation is explained rather than being an unexplained flash, and
  // so there is a link to press if the replace is slow.
  useEffect(() => {
    if (session) router.replace(returnTo);
  }, [session, returnTo, router]);

  async function startProvider(route: AuthProviderRoute) {
    setPhase({ kind: "redirecting", provider: route });
    // `await`-and-check is not enough: the client returns `{ error }` for an
    // HTTP failure but THROWS for a transport one ("Failed to fetch" — offline,
    // DNS gone, the request cut at the socket). Unhandled, that rejection left
    // this screen on "Redirecting to …" for ever, which is precisely the silent
    // spinner the copy below exists to prevent. Found by aborting the request in
    // e2e (task 012); both callers are guarded the same way.
    const { error } = await signIn
      .social({
        provider: route.id,
        callbackURL: returnTo,
        // Bounce failures back to this screen with the return URL intact, so a
        // refused link or a declined consent lands on readable copy instead of
        // Better Auth's own /api/auth/error page.
        errorCallbackURL: signInHref(returnTo),
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));
    // On success the client's redirect plugin has already set
    // `window.location`; we stay in `redirecting` while that navigation runs,
    // and the cancel control is the way out if the provider is slow.
    if (error) setPhase({ kind: "error", code: "provider_unreachable" });
  }

  async function sendLink(address: string): Promise<boolean> {
    const { error } = await signIn
      .magicLink({
        email: address,
        callbackURL: returnTo,
        errorCallbackURL: signInHref(returnTo),
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));
    if (error) {
      setPhase({ kind: "error", code: "send_failed" });
      return false;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setPhase({ kind: "sent", email: address });
    return true;
  }

  async function onSubmitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      emailRef.current?.focus();
      return;
    }
    setEmail(address);
    setPhase({ kind: "sending" });
    await sendLink(address);
  }

  async function onResend() {
    if (phase.kind !== "sent" || cooldown > 0 || resending) return;
    setResending(true);
    await sendLink(phase.email);
    setResending(false);
  }

  function backToIdle() {
    setPhase({ kind: "idle" });
    // The email field is the only thing on the idle card that takes typing, and
    // a keyboard user arriving from an error panel should land on it.
    window.setTimeout(() => emailRef.current?.focus(), 0);
  }

  async function onRetry(copy: ErrorCopy) {
    const address = email.trim();
    if (copy.retryWith === "resend" && looksLikeEmail(address) && cooldown <= 0) {
      setPhase({ kind: "sending" });
      await sendLink(address);
      return;
    }
    backToIdle();
  }

  const busy = phase.kind === "redirecting" || phase.kind === "sending";

  return (
    <>
      <div className="rounded-[var(--r-xl)] border border-border bg-surface p-8 shadow-[var(--shadow-lg)]">
        {session ? (
          <Panel tone="live" icon={<Check strokeWidth={2.4} />} heading="You're in">
            <p className="mb-[22px] text-sm leading-[1.55] text-text-secondary">
              You are already signed in. Taking you through now…
            </p>
            <Button
              asChild
              variant="secondary"
              className="h-auto w-auto border-transparent bg-text px-6 py-3 text-[0.9375rem] text-bg hover:bg-text hover:shadow-[var(--shadow-md)]"
            >
              <a href={returnTo}>Continue →</a>
            </Button>
          </Panel>
        ) : phase.kind === "error" ? (
          (() => {
            const copy = errorCopy(phase.code);
            return (
              <Panel
                tone="danger"
                icon={<CircleAlert />}
                heading={copy.heading}
                live="assertive"
              >
                <p className="mb-[22px] text-sm leading-[1.55] text-text-secondary">
                  {copy.body}
                </p>
                <Button
                  type="button"
                  className="h-auto w-full py-3.5 text-[0.9375rem]"
                  onClick={() => void onRetry(copy)}
                >
                  {copy.retryLabel}
                </Button>
              </Panel>
            );
          })()
        ) : phase.kind === "sent" ? (
          <Panel tone="accent" icon={<Mail />} heading="Check your email">
            <p className="mb-1.5 text-sm leading-[1.55] text-text-secondary">
              We sent a magic link to
              <br />
              <b className="text-text">{phase.email}</b>
            </p>
            <p className="mt-3.5 text-[0.8125rem] text-text-muted">
              {resending ? (
                "Sending another…"
              ) : cooldown > 0 ? (
                <>Didn&apos;t arrive? You can resend in {cooldown}s.</>
              ) : (
                <>
                  Didn&apos;t arrive?{" "}
                  <button
                    type="button"
                    onClick={() => void onResend()}
                    className="text-[0.8125rem] text-accent underline underline-offset-2 outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  >
                    resend
                  </button>
                </>
              )}
            </p>
          </Panel>
        ) : busy ? (
          <div
            role="status"
            className="animate-in fade-in zoom-in-95 py-3.5 text-center duration-300"
          >
            <span
              aria-hidden="true"
              className="mb-5 inline-block size-[30px] animate-spin rounded-full border-[3px] border-accent-soft border-t-accent"
            />
            <h2 className="mb-2 font-display text-xl font-semibold tracking-[-0.02em] text-text">
              {phase.kind === "redirecting"
                ? `Redirecting to ${phase.provider.name}…`
                : "Sending your link…"}
            </h2>
            <p className="text-sm leading-[1.55] text-text-secondary">
              {phase.kind === "redirecting"
                ? "Approve the kept app to continue. You'll come right back."
                : "One moment — preparing a secure magic link."}
            </p>
            {/* The escape hatch. An OAuth click is a full-page redirect we do
                not control the timing of, so there has to be a way back that
                does not involve waiting on somebody else's server. */}
            <button
              type="button"
              onClick={backToIdle}
              className="mono-label mt-[22px] border-b border-border pb-[3px] text-xs text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              cancel
            </button>
          </div>
        ) : (
          <div className="animate-in fade-in zoom-in-95 duration-300">
            <h1 className="mb-2 font-display text-[1.625rem] font-bold tracking-[-0.02em] text-text">
              {keepNotice ? "Keep this page" : "Sign in to kept"}
            </h1>
            <p className="mb-[26px] text-sm leading-[1.55] text-text-secondary">
              {keepNotice ??
                "Manage your pages, replace versions, and keep them forever."}
            </p>

            {/* GitHub · Google · divider · email — one component per route, in
                the order the export drew, with the 12px rhythm it drew them at. */}
            <div className="flex flex-col gap-3">
              {AUTH_PROVIDERS.map((route) => (
                <ProviderButton
                  key={route.id}
                  route={route}
                  onSelect={(selected) => void startProvider(selected)}
                />
              ))}
            </div>

            <div className="my-[18px] flex items-center gap-3 text-text-muted">
              <div className="h-px flex-1 bg-border" />
              <span className="mono-label text-[0.6875rem]">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={(event) => void onSubmitEmail(event)} noValidate>
              <Label htmlFor="auth-email" className="mb-2 block text-text-muted">
                Email
              </Label>
              <Input
                id="auth-email"
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mb-3 h-auto rounded-[var(--r-sm)] bg-sunken py-[0.8125rem] text-[0.9375rem] shadow-none"
              />
              <Button
                type="submit"
                variant="secondary"
                className="h-auto w-full gap-2.5 py-3.5 text-[0.9375rem] hover:bg-surface hover:shadow-[var(--shadow-md)] [&_svg]:size-[18px]"
              >
                <Mail />
                Email me a magic link
              </Button>
            </form>

            <p className="mono-label mt-[18px] text-center text-[0.6875rem] leading-[1.5] text-text-muted">
              No password · your page stays live either way
            </p>
          </div>
        )}
      </div>

      <p className="mono-label mt-[22px] text-center text-[0.6875rem] tracking-[0.06em] text-text-muted">
        Protected by kept · AGPL open source
      </p>
    </>
  );
}

/**
 * The export's three terminal panels are one shape — a 52px tinted disc, a
 * heading, then whatever the state needs — so they are one component here.
 * `tone` picks the disc's tint from the token set; nothing else varies.
 */
function Panel({
  tone,
  icon,
  heading,
  live,
  children,
}: {
  tone: "accent" | "danger" | "live";
  icon: ReactNode;
  heading: string;
  live?: "polite" | "assertive";
  children: ReactNode;
}) {
  const disc = {
    accent: "bg-accent-soft text-accent",
    // `color-mix` against the token rather than a second hex: the tint tracks
    // whichever `--danger` / `--live` the active theme block defines.
    danger:
      "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger",
    live: "bg-[color-mix(in_srgb,var(--live)_16%,transparent)] text-live",
  }[tone];

  return (
    <div
      role={live === "assertive" ? "alert" : "status"}
      className="animate-in fade-in zoom-in-95 py-2 text-center duration-300"
    >
      <div
        className={`mx-auto mb-[18px] flex size-[52px] items-center justify-center rounded-full ${disc} [&_svg]:size-6`}
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2 className="mb-2 font-display text-[1.375rem] font-bold tracking-[-0.02em] text-text">
        {heading}
      </h2>
      {children}
    </div>
  );
}
