/**
 * The chrome both sign-in screens sit in — the wordmark header and the mascot.
 *
 * Extracted from `./page.tsx` when task 009 added `./keep/page.tsx`: the two
 * screens differ by one prop on `<SignInForm>` (the keep reassurance line) and
 * by nothing else, and a second copy of this markup would be a second place for
 * the mascot's size and colour classes and the header's focus ring to drift.
 */
import Link from "next/link";

import { Mascot } from "@/components/kept/mascot";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center px-8">
          <Link
            href="/"
            className="rounded-[var(--r-sm)] font-display text-[1.375rem] font-bold tracking-[-0.03em] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            kept
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px]">
          {/* The mascot owns no colour and no size — the caller does. `size-24`
              holds the slot the illustration used to occupy (its viewBox is
              square, so this is the whole rhythm), and `text-accent` is what
              paints the `currentColor` body. `aria-hidden` is on its own `<svg>`
              root, so there is no wrapper here to carry it. */}
          <Mascot className="mx-auto mb-2 block size-24 text-accent" />

          {children}
        </div>
      </main>
    </div>
  );
}
