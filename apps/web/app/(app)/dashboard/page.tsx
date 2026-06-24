/**
 * (app) route group — auth-gated control plane (dashboard, site/[slug],
 * settings). Stubbed shell only; real surfaces land in E3. Auth gating is E2.
 */
export default function AppGroupPlaceholder() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-3 px-6 py-16">
      <p className="mono-label text-text-muted">Control plane</p>
      <h1 className="font-display text-3xl font-semibold text-text">
        Dashboard placeholder
      </h1>
      <p className="text-text-secondary">
        The auth-gated control plane (dashboard, site detail, settings) is built
        in E3.
      </p>
    </main>
  );
}
