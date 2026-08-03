// @kept/edge — Hono Worker, serving data plane.
//
// Serves `{slug}.{KEPT_BASE_DOMAIN}` from R2 (files) + KV (manifest) ONLY. It may
// import @kept/shared but NEVER @kept/web — the one-way serve-path rule is
// enforced by the root ESLint `no-restricted-imports` guard.
//
// Pipeline (E03): host→slug → Cache API → KV lookup → status branch → R2 fetch →
// headers + cache. Steps 1 (host→slug, reserved labels), 3 (the single KV read)
// and 4 (the status branch) are live; the R2 fetch lands in task 003, so a
// `live` manifest still falls through to the branded 404 for now.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { KvManifest } from "@kept/shared";

import type { Env } from "./env";
import { resolveHost } from "./host";
import { readManifest } from "./manifest";
import { renderSystemPage, type SystemPage } from "./system-pages";

const app = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

/**
 * Render a branded system page with this environment's apex origin, so dev
 * renders dev links. `system-pages.ts` never reads `Env` itself — the caller
 * owns the bindings and passes the value down.
 */
function systemPage(c: AppContext, page: SystemPage) {
  const { body, status } = renderSystemPage(page, {
    apexOrigin: c.env.KEPT_APEX_ORIGIN,
  });
  c.status(status as ContentfulStatusCode);
  return c.html(body);
}

/**
 * Compile-time exhaustiveness guard for the status branch.
 *
 * The `never` parameter means adding a value to `MANIFEST_STATUSES` FAILS THE
 * TYPECHECK here rather than silently falling through to "serve the content".
 * At runtime this is reachable only if KV holds a manifest newer than the
 * deployed Worker, in which case the safe answer is the branded 404.
 */
function unhandledManifestStatus(_status: never): SystemPage {
  return "notFound";
}

app.all("*", async (c) => {
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
  // error, never a raw 500, never a redirect.
  if (resolved.kind === "invalid") {
    return systemPage(c, "notFound");
  }

  // Step 3: the single KV read. A miss and a malformed/half-written manifest are
  // the same answer — nothing is published at this address. Task 007 adds the
  // direct R2 probe that covers KV's eventual-consistency window before this
  // falls through.
  const lookup = await readManifest(c.env.KEPT_KV, resolved.slug);
  if (lookup.kind === "unservable") {
    return systemPage(c, "notFound");
  }

  // Step 4: the status branch. A TOTAL SWITCH, not an if-chain — see
  // `unhandledManifestStatus`.
  //
  // `archived` deliberately has NO branch: it is the archive-don't-delete cold
  // state and is never written to KV, so it is not a serving status and is
  // absent from `MANIFEST_STATUSES`. Do not add one.
  //
  // Serving is draft-agnostic: drafts and kept pages are both `live`. There is
  // no `expires_at` here and no date arithmetic anywhere in the Worker —
  // `expired` is a status the control plane writes, not one the edge computes.
  switch (lookup.manifest.status) {
    case "live":
      // Steps 5–7 (task 003): sites/{siteId}/{versionId}/{path} out of R2, then
      // headers + cache. Until that lands, a live manifest resolves to the
      // branded 404 rather than pretending to serve.
      return systemPage(c, "notFound");
    case "under_review":
    case "quarantined":
      return systemPage(c, "suspended");
    case "expired":
      return systemPage(c, "expired");
    case "removed":
      // Deliberately indistinguishable from "never existed": a removed page
      // must not be confirmable by its status code.
      return systemPage(c, "notFound");
    default:
      return systemPage(c, unhandledManifestStatus(lookup.manifest.status));
  }
});

export default app;

// Re-export the serving contract type so downstream tooling/tests can reference
// it from the edge app without reaching past the @kept/shared boundary.
export type { KvManifest };
