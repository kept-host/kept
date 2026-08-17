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
 * The control plane's OWN origin — `https://kept.host` in prod, the Railway URL
 * on dev, `http://localhost:3000` locally. `claim_url` is built from it, and it
 * is a different value from `servingBaseDomain()`: pages are served from
 * `{slug}.{KEPT_BASE_DOMAIN}` by the Worker, while `/keep/{anonToken}` is a
 * control-plane route.
 *
 * The one `NEXT_PUBLIC_` variable this module reads, and it is read on the
 * server like everything else here — it is public because the browser bundle
 * needs it too, not because this accessor is client-safe. Returned without a
 * trailing slash so callers concatenate a path unconditionally.
 */
export function appOrigin(): string {
  const env = read({
    NEXT_PUBLIC_APP_URL: z
      .string()
      .trim()
      .url('expected an absolute origin such as "https://kept.host"'),
  });
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}

/**
 * A slot that is *present but empty* is the normal shape of an unfilled Railway
 * variable and of every reserved line in `.env.example`. zod sees `""`, which
 * passes `z.string().optional()` and then silently becomes a broken URL or a
 * zero-length secret. Collapse it to `undefined` first so `.optional()` means
 * "absent" and a required field reports itself as missing.
 */
function blankAsAbsent<S extends z.ZodTypeAny>(schema: S) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema,
  );
}

const absoluteUrl = z
  .string()
  .trim()
  .url('expected an absolute origin such as "https://kept.host"');

/**
 * Better Auth's own two values (E05 task 003).
 *
 * `baseUrl` is the CONTROL PLANE's origin — the one every OAuth redirect URI is
 * registered against. It is `BETTER_AUTH_URL` when set and `appOrigin()`
 * otherwise, so a deployment that already carries `NEXT_PUBLIC_APP_URL` needs no
 * second copy of the same string. It is NEVER `KEPT_BASE_DOMAIN`: the serving
 * domain has no auth surface and must not appear anywhere in an OAuth config.
 */
export function authConfig(): { secret: string; baseUrl: string } {
  const env = read({
    BETTER_AUTH_SECRET: blankAsAbsent(
      z
        .string()
        .trim()
        .min(
          32,
          "expected 32+ random bytes — generate one with `openssl rand -base64 32`",
        ),
    ),
    BETTER_AUTH_URL: blankAsAbsent(absoluteUrl.optional()),
  });
  return {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: (env.BETTER_AUTH_URL ?? appOrigin()).replace(/\/+$/, ""),
  };
}

/**
 * The GitHub OAuth app (E02 reserved these slots; E05 fills them). Callback:
 * `{authConfig().baseUrl}/api/auth/callback/github` — registered per track.
 */
export function githubOAuth(): { clientId: string; clientSecret: string } {
  const env = read({
    GITHUB_CLIENT_ID: blankAsAbsent(nonEmpty),
    GITHUB_CLIENT_SECRET: blankAsAbsent(nonEmpty),
  });
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

/**
 * The Google OAuth 2.0 Web application client (E05 task 003).
 *
 * NEW SLOTS — E02's secret topology reserved `GITHUB_CLIENT_*` and
 * `RESEND_API_KEY`, but Google was added to E05's scope after that, so
 * `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are introduced here and are
 * per-track like everything else. Redirect URI:
 * `{authConfig().baseUrl}/api/auth/callback/google`, registered EXACTLY —
 * Google rejects a mismatch with an opaque error.
 */
export function googleOAuth(): { clientId: string; clientSecret: string } {
  const env = read({
    GOOGLE_CLIENT_ID: blankAsAbsent(nonEmpty),
    GOOGLE_CLIENT_SECRET: blankAsAbsent(nonEmpty),
  });
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

/**
 * Resend — the magic-link sender, and (from E05 task 011) the draft-reminder
 * sender too. ONE accessor for both: the free tier's 100/day ceiling is a single
 * shared budget, and a second accessor is how two consumers end up believing
 * they each have their own.
 *
 * `from` accepts either `page@kept.host` or `kept <page@kept.host>`; both are
 * what Resend's API takes, and the domain must be verified in Resend or every
 * send fails at request time rather than here.
 */
export function resendConfig(): { apiKey: string; from: string } {
  const env = read({
    RESEND_API_KEY: blankAsAbsent(nonEmpty),
    EMAIL_FROM: blankAsAbsent(
      z
        .string()
        .trim()
        .regex(
          /^(?:[^<>]*<[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+>|[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+)$/,
          'expected "page@kept.host" or "kept <page@kept.host>"',
        ),
    ),
  });
  return { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM };
}

/**
 * The shared secret every scheduled job authenticates with (E05 task 011).
 *
 * ONE secret for the whole `/api/cron/*` namespace, which E07 extends with the
 * expiry sweep and the grace-end purge. A per-job secret would multiply the
 * rotation surface without changing the trust boundary: any holder of any of
 * them is already the scheduler.
 *
 * Not optional and not blank-tolerant — an unauthenticated cron route is a
 * mail-sending oracle for anyone who guesses the path, so a deployment with an
 * empty slot must fail loudly at first call rather than degrade to open.
 * Per-track like everything else here; never `NEXT_PUBLIC_`.
 */
export function cronSecret(): string {
  return read({
    CRON_SECRET: blankAsAbsent(
      z
        .string()
        .trim()
        .min(
          32,
          "expected 32+ random bytes — generate one with `openssl rand -base64 32`",
        ),
    ),
  }).CRON_SECRET;
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
