/**
 * The control plane's validated server-only configuration.
 *
 * ONE module reads `process.env` for the stores. Everything else — the R2, KV
 * and purge clients, the write helper, the publish route — calls an accessor
 * here and gets a value that has already been checked. No scattered
 * `process.env.X!`, because that is how `https://slug.undefined/` gets built and
 * shipped: an unset variable has to fail loudly at first use, naming itself.
 *
 * PER-TRACK VALUES, ONE CODE PATH. Dev and prod differ only in the values these
 * variables carry (E02's locked decision). There is no hostname literal and no
 * `process.env.NODE_ENV` fork anywhere in this file or its callers — a domain
 * chosen by a branch is a bug, not a convenience.
 *
 * NO MODULE-LEVEL CACHE. Every accessor re-reads and re-validates on call, so a
 * Next.js hot reload or a rotated Railway variable can never leave a stale
 * credential pinned in a closure. Validation is a few zod checks on strings;
 * the store round-trip that follows dominates the cost.
 *
 * SERVER ONLY. Nothing here is `NEXT_PUBLIC_`; importing this module from a
 * client component would leak credentials into the browser bundle.
 */
import { z } from "zod";

/** Cloudflare REST API base — shared by the KV client and the purge client. */
export const CF_API = "https://api.cloudflare.com/client/v4";

const nonEmpty = z.string().trim().min(1);

/**
 * Cloudflare resource ids are 32 lowercase hex characters. Only applied to the
 * variables this task introduces: the ones E00–E03 already proved against live
 * Cloudflare are left on a presence check, so tightening a format here can
 * never break a call that works today.
 */
const cloudflareId = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, "expected a 32-character lowercase hex Cloudflare id");

/**
 * The serving suffix, mirroring the Worker's `KEPT_BASE_DOMAIN`
 * (`apps/edge/wrangler.toml`): `kept-dev.xyz` on dev, `kept.host` on prod.
 * Bare hostname — no scheme, no leading dot, no trailing slash, no path.
 * Distinct from `NEXT_PUBLIC_APP_URL`, which is the control plane's OWN origin.
 */
const servingDomain = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'expected a bare serving domain such as "kept-dev.xyz" — no scheme, no leading dot, no trailing slash',
  );

/**
 * Parse the named variables out of `process.env`, or throw an error that names
 * every variable that is missing or malformed. Grouped per concern rather than
 * one whole-environment schema on purpose: a missing purge zone id must not
 * stop an R2 write, and a script that only touches KV must not need the rest.
 */
function read<S extends z.ZodRawShape>(shape: S): z.infer<z.ZodObject<S>> {
  const result = z.object(shape).safeParse(process.env);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".")} — ${issue.message}`)
    .join("; ");
  throw new Error(
    `Invalid or missing environment: ${detail}. Set it in apps/web/.env.local ` +
      `(documented in .env.example); in a deployed environment these are ` +
      `Railway service variables, not a file.`,
  );
}

/** R2 credentials + the bucket v1 writes to (`region: "auto"`; EU is E11). */
export function r2Config(): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} {
  const env = read({
    R2_ACCOUNT_ID: nonEmpty,
    R2_ACCESS_KEY_ID: nonEmpty,
    R2_SECRET_ACCESS_KEY: nonEmpty,
    R2_BUCKET_AUTO: nonEmpty,
  });
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_AUTO,
  };
}

/** KV namespace + the token that writes it (`Workers KV Storage: Edit`). */
export function kvConfig(): {
  accountId: string;
  namespaceId: string;
  apiToken: string;
} {
  const env = read({
    // R2 and KV live in the same Cloudflare account; one id, two stores.
    R2_ACCOUNT_ID: nonEmpty,
    KV_NAMESPACE_ID: nonEmpty,
    CLOUDFLARE_API_TOKEN: nonEmpty,
  });
  return {
    accountId: env.R2_ACCOUNT_ID,
    namespaceId: env.KV_NAMESPACE_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  };
}

/**
 * Zone + token for `purge_cache` (`docs/edge-purge-contract.md` §3).
 *
 * The token is the existing `CLOUDFLARE_API_TOKEN`: E02 task 004 already
 * provisioned zone-scoped `Cache Purge` on both tracks, so no new credential is
 * created or requested here.
 */
export function purgeConfig(): { zoneId: string; apiToken: string } {
  const env = read({
    CLOUDFLARE_ZONE_ID: cloudflareId,
    CLOUDFLARE_API_TOKEN: nonEmpty,
  });
  return { zoneId: env.CLOUDFLARE_ZONE_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

/**
 * The suffix every published page is served from: `{slug}.{baseDomain}`.
 * Callers build `live_url` and the §4 purge URL forms from it.
 */
export function servingBaseDomain(): string {
  return read({ KEPT_BASE_DOMAIN: servingDomain }).KEPT_BASE_DOMAIN;
}

/**
 * Salt for `sites.publisher_hash` (E04 task 001). Not a store credential, but
 * it lives here because the epic's rule is ONE validated env module for the
 * control plane's server-only config — a second accessor is how the two drift.
 * Never `NEXT_PUBLIC_`: it exists so dedup and E07's rate limiter can key on a
 * publisher WITHOUT retaining visitor IPs.
 */
export function publisherHashSalt(): string {
  return read({ PUBLISHER_HASH_SALT: nonEmpty }).PUBLISHER_HASH_SALT;
}
