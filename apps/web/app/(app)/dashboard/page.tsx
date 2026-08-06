/**
 * `(app)/dashboard` — the page a signed-in user lands on.
 *
 * Still a placeholder, and the placeholder is now honest about which epic owns
 * what: **E05** gates this route group and lands the user here (`layout.tsx`),
 * **E06** builds the surface itself — the kept/draft listing, quota, rename,
 * replace, delete, keep/demote and the swap chooser.
 */
export default function DashboardPlaceholder() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-3 px-6 py-16">
      <p className="mono-label text-text-muted">Control plane</p>
      <h1 className="font-display text-3xl font-semibold text-text">
        Dashboard placeholder
      </h1>
      <p className="text-text-secondary">
        You are signed in — sign-in and the gate on this route group landed in
        E05. The dashboard itself (your kept pages and drafts, quota, rename,
        replace, delete and swap) is built in E06.
      </p>
    </main>
  );
}
