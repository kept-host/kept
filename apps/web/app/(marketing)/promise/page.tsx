import type { Metadata } from "next";
import Link from "next/link";

// TODO(E09): E09-open-books publishes the full forever-promise text and
// replaces this short version.

export const metadata: Metadata = {
  title: "The promise",
  description: "What happens to your kept pages if kept ever shuts down.",
};

export default function PromisePlaceholder() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">The promise</p>
        <h1 className="font-display text-3xl font-semibold text-text">
          If kept ever winds down
        </h1>
      </div>
      <div className="flex flex-col gap-4 text-text-secondary">
        <p>
          Kept pages are meant to outlast us. If kept ever has to shut down, we
          will not switch the lights off without warning: we announce the sunset
          well ahead of it, keep every kept page serving through that window,
          and publish an export so you can take your pages and their links
          elsewhere.
        </p>
        <p>
          This is the short version. The full promise — the notice period, the
          export format, and who is accountable for it — is published alongside
          the open books.
        </p>
      </div>
      <Link href="/" className="mono-label text-xs text-accent hover:underline">
        ← Back to kept
      </Link>
    </main>
  );
}
