// @kept/edge — Hono Worker, serving data plane (skeleton, task 004).
//
// Serves `{slug}.kept.host` from R2 (files) + KV (manifest) ONLY. It may import
// @kept/shared but NEVER @kept/web — the one-way serve-path rule is enforced by
// the root ESLint `no-restricted-imports` guard. Real routing (slug resolution,
// KV lookup, R2 fetch, status branching, caching, branded pages) lands in E0;
// this skeleton returns the placeholder branded 404 for every request.

import { Hono } from "hono";

// Importing the KV manifest contract proves the @kept/shared wiring/boundary.
// E0 reads `KEPT_KV` and validates the value against this type before serving.
import type { KvManifest } from "@kept/shared";

import type { Env } from "./env";
import { renderSystemPage } from "./system-pages";

const app = new Hono<{ Bindings: Env }>();

// Catch-all: until E0 wires real serving, every request gets the branded 404.
// (E0 replaces this with: Cache API → KV lookup → status branch → R2 fetch.)
app.all("*", (c) => {
  const { body, status } = renderSystemPage("notFound");
  c.status(status as 404);
  return c.html(body);
});

export default app;

// Re-export the serving contract type so downstream tooling/tests can reference
// it from the edge app without reaching past the @kept/shared boundary.
export type { KvManifest };
