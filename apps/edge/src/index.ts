// @kept/edge — Hono Worker, serving data plane.
//
// Serves `{slug}.{KEPT_BASE_DOMAIN}` from R2 (files) + KV (manifest) ONLY. It may
// import @kept/shared but NEVER @kept/web — the one-way serve-path rule is
// enforced by the root ESLint `no-restricted-imports` guard.
//
// Pipeline (E03): host→slug → Cache API → KV lookup → status branch → R2 fetch →
// headers + cache. Step 1 (host→slug, reserved labels) is live; the store steps
// land in E03 tasks 002 (KV) and 003 (R2), so a resolved slug still falls through
// to the branded 404 for now.

import { Hono } from "hono";

// Importing the KV manifest contract proves the @kept/shared wiring/boundary.
// Task 002 reads `KEPT_KV` and validates the value against this type before serving.
import type { KvManifest } from "@kept/shared";

import type { Env } from "./env";
import { resolveHost } from "./host";
import { renderSystemPage } from "./system-pages";

const app = new Hono<{ Bindings: Env }>();

app.all("*", (c) => {
  const url = new URL(c.req.url);

  // Step 1: host → slug. Runs BEFORE any store access, so the reserved and
  // invalid branches cost zero KV and zero R2 reads.
  const resolved = resolveHost(url.hostname, c.env.KEPT_BASE_DOMAIN);

  if (resolved.kind === "reserved") {
    // Control-plane label: permanent redirect to the apex, path + query
    // preserved (the fragment is client-side and never reaches the Worker).
    return c.redirect(
      `${c.env.KEPT_APEX_ORIGIN}${url.pathname}${url.search}`,
      301,
    );
  }

  // `invalid` — a host outside this environment's base domain, a multi-label
  // host, or a label that is not a legal slug — is a branded 404, never a thrown
  // error, never a raw 500, never a redirect. A resolved slug lands here too
  // until task 002 wires the KV lookup.
  const { body, status } = renderSystemPage("notFound");
  c.status(status as 404);
  return c.html(body);
});

export default app;

// Re-export the serving contract type so downstream tooling/tests can reference
// it from the edge app without reaching past the @kept/shared boundary.
export type { KvManifest };
