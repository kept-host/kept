// @kept/edge — host → slug resolution.
//
// THE HARD RULE: the serve path is 100% Cloudflare and never calls the control
// plane. `apps/edge` may import `@kept/shared` but NEVER `apps/web`, and nothing
// here (or downstream of here) may fetch the control plane to resolve a request.
// This module is deliberately pure — no `Env`, no bindings, no fetch — so the
// first step of the pipeline costs zero KV and zero R2 operations.
//
// The base domain arrives as a per-environment `[vars]` entry
// (`KEPT_BASE_DOMAIN`), never as a hostname literal or a `NODE_ENV` fork: dev
// serves `*.kept-dev.xyz`, prod serves `*.kept.host`, one code path serves both.

/**
 * Labels that belong to the control plane, not the serving plane. The deployed
 * route `*.{base}/*` DOES match `www.{base}`, so the Worker owns the redirect
 * rather than depending on a more-specific Cloudflare route staying in place.
 */
export const RESERVED_LABELS = ["www", "app", "api", "assets"] as const;

export type ReservedLabel = (typeof RESERVED_LABELS)[number];

function isReservedLabel(label: string): label is ReservedLabel {
  return (RESERVED_LABELS as readonly string[]).includes(label);
}

/**
 * DNS-label shape a slug must have before it may become a KV key: 1–63 chars,
 * lowercase alphanumeric plus interior hyphens. This is the *host* guard — it is
 * intentionally broader than `slugSchema` in `@kept/shared` (which is the
 * narrower minting rule the control plane applies when it assigns a slug). An
 * unbounded label, a control character, a percent-encoding or a `.` must never
 * reach `KEPT_KV.get`, so the check happens here and not at the store call.
 */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostResolution =
  | { kind: "slug"; slug: string }
  | { kind: "reserved"; label: ReservedLabel }
  | { kind: "invalid" };

/**
 * Resolve a request host to the slug it serves.
 *
 * Normalizes (lowercase, strip `:port`, strip one trailing FQDN dot), asserts
 * the `.{baseDomain}` suffix, and takes the **first label only** — `a.b.{base}`
 * is `invalid`, not a slug of `a`. Asserting a configured suffix (rather than
 * counting labels) is why a misconfigured environment fails loudly at the first
 * request instead of silently serving the wrong slug.
 */
export function resolveHost(host: string, baseDomain: string): HostResolution {
  const base = normalizeHost(baseDomain);
  if (base === "") return { kind: "invalid" };

  const normalized = normalizeHost(host);
  const suffix = `.${base}`;
  if (!normalized.endsWith(suffix)) return { kind: "invalid" };

  const label = normalized.slice(0, -suffix.length);
  if (isReservedLabel(label)) return { kind: "reserved", label };
  if (!SLUG_PATTERN.test(label)) return { kind: "invalid" };

  return { kind: "slug", slug: label };
}

/** Lowercase, drop a trailing `:port`, drop one trailing FQDN dot. */
function normalizeHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  const withoutPort = lowered.replace(/:\d+$/, "");
  return withoutPort.endsWith(".") ? withoutPort.slice(0, -1) : withoutPort;
}
