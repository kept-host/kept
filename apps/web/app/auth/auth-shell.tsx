/**
 * The chrome both sign-in screens sit in — the wordmark header and the vessel.
 *
 * Extracted from `./page.tsx` when task 009 added `./keep/page.tsx`: the two
 * screens differ by one prop on `<SignInForm>` (the keep reassurance line) and
 * by nothing else, and a second copy of this markup would be a second place for
 * the vessel's geometry and the header's focus ring to drift.
 */
import Link from "next/link";

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
          {/* The vessel. Its geometry and gradients are `.kept-vessel` in
              globals.css — see the block there for why they cannot be Tailwind
              arbitrary values. The glowing core stays here: it is a plain
              circle and expresses fine as classes. */}
          <div
            aria-hidden="true"
            className="mb-2 flex h-24 items-center justify-center"
          >
            <div className="kept-vessel relative">
              <div className="absolute left-1/2 top-[54%] size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--accent-hover),var(--accent)_60%)] shadow-[0_0_22px_6px_color-mix(in_srgb,var(--accent)_45%,transparent)]" />
            </div>
          </div>

          {children}
        </div>
      </main>
    </div>
  );
}
