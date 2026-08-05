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
 * THE E05 SEAM — the one thing on this screen that does not work yet. Keeping a
 * page means signing in, attaching it to an account and clearing the clock, and
 * all three are E05. E04 ships the button honestly disabled with the reason
 * stated in the visible copy, rather than a fake success or a link into a flow
 * that does not exist. See `KEEP_CTA_NOTE` below for exactly what E05 replaces.
 *
 * THE URL IS A BEARER CREDENTIAL, same as the manage link:
 * `robots: noindex, nofollow` keeps it out of search indexes,
 * `referrer: "no-referrer"` keeps it out of the `Referer` header of every
 * outbound navigation (including the hosted page itself), no link on this page
 * carries the token, and the token is never logged.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";

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
const WHAT_KEPT_IS =
  "kept gives a single web page a permanent home, free. Someone published this one and sent you the link.";

const COPY: Record<DraftPhase, { eyebrow: string; heading: string; body: string }> = {
  draft: {
    eyebrow: "Someone shared this page with you",
    heading: "It is live — but not permanent yet",
    body: `It was published as a draft, so it has a clock on it: ${DRAFT_TTL_DAYS} days from when it went live, and the chip above shows what is left. If nobody keeps it before then, it stops answering, and ${DRAFT_GRACE_DAYS} days later it is deleted for good. Keeping it takes the clock off — same link, same page, no expiry, still free.`,
  },
  expired: {
    eyebrow: "Someone shared this page with you",
    heading: "Its clock has run out",
    body: `It was published as a draft with a ${DRAFT_TTL_DAYS}-day window, and that window has passed, so it stops answering. Nothing is destroyed yet: the file is held for ${DRAFT_GRACE_DAYS} days after the deadline, and keeping it in that time brings it back at the same link — free, and permanent.`,
  },
  kept: {
    eyebrow: "Nothing to do here",
    heading: "This page is kept",
    body: "It is permanent. There is no clock on it, nothing expires, and nobody has to claim it — the link will keep working.",
  },
};

/**
 * THE E05 HANDOFF, IN ONE STRING. Keeping needs sign-in, an account to attach
 * the page to, and the two clocks cleared — none of which exist in E04. The
 * button below is `aria-disabled` and this note says why, in place of the two
 * dishonest alternatives: a fake success, or a link into a flow that 404s.
 *
 * E05 replaces exactly two things here — this note, and the button's
 * `aria-disabled` with its real destination. Nothing else on this screen moves.
 */
const KEEP_CTA_NOTE =
  "Keeping needs a kept account, and accounts are not open yet — this button turns on when they are. Until then, save this link: it is the only handle anyone has on this page.";

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
              {/* `aria-disabled` rather than `disabled`: the control stays
                  focusable, so a keyboard or screen-reader visitor reaches it
                  and hears both the label and the note explaining it. It has no
                  handler and no href, so activating it does nothing at all —
                  which is the honest behaviour until E05 lands. */}
              <Button
                type="button"
                aria-disabled="true"
                aria-describedby="keep-cta-note"
                // The hover and press affordances are cancelled deliberately: a
                // button that lights up and squashes under the cursor is a
                // button claiming it did something.
                className="w-full max-w-[20rem] cursor-not-allowed opacity-60 hover:bg-accent active:scale-100"
              >
                Keep it forever
              </Button>
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
