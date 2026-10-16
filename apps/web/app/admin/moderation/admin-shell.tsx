/**
 * The `/admin` screens' frame (E07 §6.11).
 *
 * A COMPONENT, NOT A LAYOUT, ON PURPOSE. A non-admin must get exactly the 404
 * an unknown path gets (AC20). `notFound()` thrown by a PAGE under an
 * `app/admin/layout.tsx` renders inside that layout — this header around the
 * 404 — and thrown by the layout itself it renders Next's error shell instead
 * of the root not-found. So each page gates first (`getAdminSession()`, then
 * `notFound()`) with no admin layout above it, and only then draws this frame.
 *
 * `/admin/*` carries the app's only Content-Security-Policy, set by
 * `middleware.ts` (`lib/routing/admin-csp.ts`).
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Wordmark } from "../../(app)/wordmark";

export const ADMIN_METADATA: Metadata = {
  title: "Moderation",
  robots: { index: false, follow: false },
};

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-4 border-b border-border px-4 py-4 md:px-10">
        <Wordmark className="text-[24px]" />
        <span className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
          Moderation
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 pb-24 pt-8 md:px-10">{children}</main>
    </div>
  );
}
