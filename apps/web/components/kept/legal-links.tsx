import Link from "next/link";

import { LEGAL_DOCS, LEGAL_LABELS, legalHref } from "@/lib/legal/links";
import { cn } from "@/lib/utils";

/**
 * The "Impressum" · "Privacy" pair every apex page, form and confirm page
 * carries (E06a, PRD §6). Apex-absolute when the deploy has an `app.` host, so
 * the pair works from either origin; relative on a single-origin deploy.
 * `NEXT_PUBLIC_APP_URL` is inlined, so this renders the same on server and client.
 */
export function LegalLinks({ className }: { className?: string }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return (
    <nav
      aria-label="Legal"
      className={cn("flex items-center gap-4", className)}
    >
      {LEGAL_DOCS.map((doc) => (
        <Link
          key={doc}
          href={legalHref(doc, appUrl)}
          className="mono-label text-xs text-text-muted hover:text-accent hover:underline"
        >
          {LEGAL_LABELS[doc]}
        </Link>
      ))}
    </nav>
  );
}
