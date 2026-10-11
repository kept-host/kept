import type { Metadata } from "next";

import { LegalLinks } from "@/components/kept/legal-links";
import { WaitlistConfirm } from "@/components/kept/waitlist-confirm";

/**
 * `/waitlist/confirm?t=…` — the link in the confirmation mail (E06a §3, D1).
 * A GET renders the **Confirm my email** button and changes nothing; company
 * mail scanners open every link they see. The button POSTs the token.
 */
export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function WaitlistConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">The waitlist</p>
        <h1 className="font-display text-3xl font-semibold text-text">Confirm your email</h1>
      </div>
      <WaitlistConfirm token={typeof t === "string" && t ? t : null} />
      <LegalLinks className="border-t border-border pt-6" />
    </main>
  );
}
