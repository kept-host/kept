import type { Metadata } from "next";

import { EmailForm } from "@/components/kept/email-form";
import { unsubscribeWaitlist } from "@/lib/waitlist/unsubscribe";

/**
 * `/waitlist/unsubscribe?t=…` — the visible unsubscribe link in waitlist mail
 * (E06a §3, AC11). The GET unsubscribes, as E05's `/unsubscribe/[token]` does
 * (PRD §3 allows it for unsubscribe only). One page for every `t`, signed or
 * not, so the URL says nothing about who is on the list. Rejoining goes
 * through double opt-in again.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "You’re off the list",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function WaitlistUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await searchParams;
  await unsubscribeWaitlist(t);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">The waitlist</p>
        <h1 className="font-display text-3xl font-semibold text-text">You’re off the list.</h1>
        <p className="text-text-secondary">
          kept won’t email you again. Changed your mind? Join again below; we’ll ask you to
          confirm first.
        </p>
      </div>
      <EmailForm source="landing_nav" />
    </main>
  );
}
