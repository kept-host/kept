/**
 * `/keep/[anonToken]` — the claim page. E04 task 009.
 *
 * THE HARDEST AUDIENCE IN THE PRODUCT. This is the URL an agent hands to a human
 * who did not drop a file, did not choose to be here, and may never have heard
 * of kept. Everything on it is therefore written for someone with ZERO prior
 * context: one line saying what kept is, one saying what keeping does, one
 * saying what happens if nobody does it. It shows three things — the page, the
 * clock, one button — and the discipline of this screen is refusing to add a
 * fourth.
 *
 * IT IS NOT THE MANAGE SCREEN. `/p/[anonToken]` is a console for the person who
 * published; this is a landing page for the person who did not. They share the
 * preview, the chip and the token resolver, and nothing else: no copy button, no
 * QR, no replace, no delete. A stranger handed a link should not be one click
 * from deleting somebody's page.
 *
 * THE E05 SEAM, NOW CLOSED (task 009). Keeping means signing in, attaching the
 * page to an account and clearing the clock. E04 shipped the button honestly
 * disabled with the reason in the visible copy; E05 replaced exactly the two
 * things it promised — the note, and `aria-disabled` with a real destination.
 * The button now submits to `./start-keep.ts`, which writes the pending-keep
 * cookie and hands the visitor to `/auth/keep`; `/auth/callback` spends the
 * cookie once on the way back. Nothing else on this screen moved.
 *
 * THE URL IS A BEARER CREDENTIAL, same as the manage link:
 * `robots: noindex, nofollow` keeps it out of search indexes,
 * `referrer: "no-referrer"` keeps it out of the `Referer` header of every
 * outbound navigation (including the hosted page itself), no link on this page
 * carries the token, the keep form closes over it inside a server action rather
 * than writing it into a field, and the token is never logged.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { DRAFT_GRACE_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";

import {
  DraftChip,
  draftCountdown,
  type DraftPhase,
} from "@/components/kept/draft-chip";
import { PagePreview } from "@/components/kept/page-preview";
import { Button } from "@/components/ui/button";
import { resolveAnonToken } from "@/lib/publish/anon-token";
import { liveUrl } from "@/lib/publish/pipeline";
import { readPreviewHtml } from "@/lib/publish/preview";

import { startKeep } from "./start-keep";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** A bearer-token screen showing a live clock. Never cached, never prerendered. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Keep this page",
  description: "Someone published a page with kept and shared it with you.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * EVERY DURATION COMES FROM `@kept/shared`. This screen makes the product's
 * promise to a stranger in words, so a literal `7` or `30` here is not a style
 * problem — it is kept lying to somebody the day the constant changes.
 */
const WHAT_KEPT_IS = "kept gives a single web page a permanent home, free.";

/**
 * THE `kept` PHASE IS UNREACHABLE HERE, AND IS KEPT ANYWAY.
 *
 * Keeping a page nulls its `anon_token_hash` (`lib/sites/keep.ts`), so the very
 * act that would move this screen into `kept` destroys the token that reaches
 * it. A visitor returning to their own claim link gets `./not-found.tsx`
 * instead, and the app cannot tell that case from a token that never existed —
 * which is the point, not a gap.
 *
 * `DraftPhase` is a closed union, so the branch stays: dropping it makes this
 * record non-exhaustive and the next phase added to `draft-chip` would fail to
 * type rather than fail loudly here. It is one line, and it is a type-level
 * assertion, not dead copy.
 */
const COPY: Record<DraftPhase, { eyebrow: string; heading: string; body: string }> = {
  draft: {
    eyebrow: "Someone shared this page with you",
    heading: "It is live — but not permanent yet",
    body: "If nobody keeps it, it stops working. Keeping takes the clock off — same link, no expiry, still free.",
  },
  expired: {
    eyebrow: "Someone shared this page with you",
    heading: "Its clock has run out",
    body: `Nothing is lost yet. Keep it within ${DRAFT_GRACE_DAYS} days and it comes back at the same link — free, and permanent.`,
  },
  kept: {
    eyebrow: "Nothing to do here",
    heading: "This page is kept",
    body: "It is permanent. The link will keep working.",
  },
};

/**
 * THE E05 HANDOFF, HONOURED (task 009). E04 shipped this note saying accounts
 * were not open yet and the button `aria-disabled` beside it, and said E05 would
 * replace exactly those two things and nothing else. That is what happened: the
 * note now says what pressing the button does, and the button submits to
 * `startKeep`. The preview, the chip, the address, the copy and the metadata are
 * untouched.
 *
 * `KEPT_PAGE_LIMIT` comes from `@kept/shared` for the same reason every other
 * number on this screen does — a literal here is kept lying to a stranger the
 * day the cap changes.
 */
const KEEP_CTA_NOTE = `Free. Sign in with GitHub, Google, or email — free accounts keep ${KEPT_PAGE_LIMIT} pages.`;

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ anonToken: string }>;
}) {
  const { anonToken } = await params;

  // Unknown, malformed, deleted, moderated, expired-past-grace: all `null`, all
  // the same friendly 404 (`./not-found.tsx`). A distinguishable answer would
  // turn a token guess into a probe for whether somebody's page exists.
  const site = await resolveAnonToken(anonToken);
  if (!site) notFound();

  const url = liveUrl(site.slug);
  const html = await readPreviewHtml(site, "claim");

  // One `now` for the chip and for the branch, so the words and the countdown
  // cannot disagree about which side of the deadline this page is on.
  const now = new Date();
  const { phase } = draftCountdown(site.expiresAt, now);
  const copy = COPY[phase];

  /**
   * THE KEEP INTENT, CLOSED OVER RATHER THAN BOUND. `startKeep.bind(null, token)`
   * would be the obvious shape and it serialises the token into a plaintext
   * hidden field; an inline action closing over it does not, because Next
   * encrypts the closed-over variables of an inline server action before they
   * reach the document. The token is in this page's own URL either way, so this
   * is defence in depth rather than a secret being protected for the first time
   * — but a plaintext bearer credential in a form field is a thing that gets
   * copied, and there is no reason to write one.
   */
  async function keepThisPage() {
    "use server";
    await startKeep(anonToken);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center px-6">
          <Link
            href="/"
            className="font-display text-xl font-bold tracking-[-0.03em] text-text"
          >
            kept
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 py-12">
        <section className="flex w-full max-w-[560px] flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            {/* `text-secondary`, not `text-muted`: this line and the note under
                the button are the two sentences that make the screen make sense
                to a stranger, and muted fails AA against the dark surface. */}
            <p className="mono-label text-xs text-text-secondary">
              {copy.eyebrow}
            </p>
            <h1 className="font-display text-[clamp(1.7rem,4.6vw,2.5rem)] font-bold leading-tight text-text">
              {copy.heading}
            </h1>
          </div>

          {/* The page itself, framed from its own bytes. The stranger reading
              this has to see what they are being asked to keep. */}
          <PagePreview liveUrl={url} html={html} className="w-full" />

          <div className="flex flex-col items-center gap-3">
            <DraftChip expiresAt={site.expiresAt} now={now} />
            {/* Quiet by design: the address, openable, but not a button. The
                token is in THIS page's path and never in this href. */}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mono-label inline-flex items-center gap-1 rounded-[var(--r-sm)] text-xs text-text-secondary underline-offset-4 outline-none hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {new URL(url).host}
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </a>
          </div>

          <div className="flex max-w-[46ch] flex-col gap-3 text-center leading-relaxed text-text-secondary">
            <p>{WHAT_KEPT_IS}</p>
            <p>{copy.body}</p>
          </div>

          {phase === "kept" ? (
            <Button asChild variant="secondary">
              <Link href="/">Publish a page of your own</Link>
            </Button>
          ) : (
            <div className="flex w-full flex-col items-center gap-3">
              {/* A FORM, NOT A LINK — and that is the whole trick. The token is
                  a bearer credential, so it must not appear in an href, a query
                  string or an OAuth `state`; here it is closed over by the
                  server action above, which Next encrypts before it reaches the
                  document. Signed out, `startKeep` writes it into an httpOnly
                  cookie and `/auth/callback` spends it once on the way back;
                  signed in, the keep happens in this very request.

                  It also keeps this screen's zero-JavaScript promise: a plain
                  form submit posts to the action and follows the redirect with
                  no client bundle involved. */}
              <form
                action={keepThisPage}
                className="flex w-full flex-col items-center"
              >
                <Button
                  type="submit"
                  aria-describedby="keep-cta-note"
                  className="w-full max-w-[20rem]"
                >
                  Keep it forever
                </Button>
              </form>
              <p
                id="keep-cta-note"
                className="max-w-[46ch] text-center text-sm leading-relaxed text-text-secondary"
              >
                {KEEP_CTA_NOTE}
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
