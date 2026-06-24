/**
 * auth segment — sign-in, claim, callback. Stub only; the real flows
 * (GitHub OAuth + email magic link) are built in E2.
 */
export default function AuthPlaceholder() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6 py-16">
      <p className="mono-label text-text-muted">Auth</p>
      <h1 className="font-display text-3xl font-semibold text-text">
        Sign-in placeholder
      </h1>
      <p className="text-text-secondary">
        Sign-in, claim, and the OAuth callback are wired in E2.
      </p>
    </main>
  );
}
