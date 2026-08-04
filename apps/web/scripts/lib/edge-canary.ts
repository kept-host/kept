/**
 * The edge serve canary — one fixed, hand-seeded page in the dev stores that
 * proves the serving data plane (`apps/edge`) actually serves, not merely that
 * something answers on the route (E03 task 009).
 *
 * It exists because `smoke-release.ts` runs after every deploy and there is no
 * publish path until E04: the canary is what a *published* page will be, written
 * by hand. `scripts/seed-edge-canary.ts` writes it; `scripts/smoke-release.ts`
 * asserts against it. Both import this module so the fixture has exactly one
 * definition — the seeder and the probe can never drift.
 *
 * Nothing here contains a hostname, an environment name or a credential. The
 * slug is derived from whichever `--edge-url` / `SMOKE_EDGE_URL` the caller was
 * handed, so dev and prod differ only in that value (E02's locked decision).
 *
 * The manifest is built through `kvManifestSchema` from `@kept/shared` — the
 * exact parser `apps/edge/src/manifest.ts` validates KV with — so a fixture that
 * the Worker would reject cannot be written in the first place.
 */
import {
  kvManifestSchema,
  type KvManifest,
  type ManifestStatus,
} from "@kept/shared";

/**
 * Fixed ids: a re-seed overwrites the same R2 object instead of orphaning a new
 * one on every run. R2 is keyed by `siteId`, never by slug (locked decision), so
 * these are what the object path is built from.
 */
export const CANARY_SITE_ID = "e03-canary";
export const CANARY_VERSION_ID = "v1";

/** Sentinel string that must appear in the served body. */
export const CANARY_MARKER = "kept-edge-canary";

/** What the Worker answers with for `index.html` — asserted, not assumed. */
export const CANARY_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * The slug the canary lives at, taken from the edge URL's first label.
 *
 * `https://smoke.kept-dev.xyz` → `smoke`. Deliberately derived rather than
 * configured: a second variable holding the slug could disagree with the URL the
 * smoke probes, and then the smoke would seed one page and assert another.
 */
export function canarySlug(edgeUrl: string): string {
  const { hostname } = new URL(edgeUrl);
  const [label, ...rest] = hostname.split(".");
  if (!label || rest.length < 2) {
    throw new Error(
      `Cannot derive a canary slug from "${edgeUrl}" — expected {slug}.{base-domain}.`,
    );
  }
  return label;
}

/** `sites/{siteId}/{versionId}/{path}` — the R2 layout, one definition. */
export function canaryObjectKey(path = "index.html"): string {
  return `sites/${CANARY_SITE_ID}/${CANARY_VERSION_ID}/${path}`;
}

/**
 * `slugs/{slug}.json` — the slug pointer the Worker probes on a KV miss
 * (`docs/edge-purge-contract.md` §7). The seeder writes it because the canary
 * must look exactly like a control-plane publish, including the pointer that
 * E04 is obliged to write.
 */
export function canaryPointerKey(slug: string): string {
  return `slugs/${slug}.json`;
}

/**
 * The canary page. Deterministic — no timestamp, no randomness — so the smoke
 * can assert byte equality against a body it recomputes locally, and a re-seed
 * writes identical bytes (and therefore keeps the same R2 etag).
 */
export function canaryHtml(slug: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>kept edge canary — ${slug}</title>`,
    "</head>",
    "<body>",
    `<h1>${CANARY_MARKER}</h1>`,
    `<p>Serve-path canary for <code>${slug}</code>. Seeded by hand into R2 + KV by`,
    " <code>pnpm --filter @kept/web seed:canary</code>; asserted by the release smoke.",
    " Not a published page — there is no publish path until E04.</p>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The manifest value for the canary, validated through the real schema.
 * `ownerId` is null: the canary has no account, exactly like an anonymous
 * publish. `region` is `auto` — `eu` does not activate until E11.
 */
export function canaryManifest(status: ManifestStatus = "live"): KvManifest {
  return kvManifestSchema.parse({
    siteId: CANARY_SITE_ID,
    versionId: CANARY_VERSION_ID,
    status,
    region: "auto",
    ownerId: null,
    updatedAt: Date.now(),
  });
}
