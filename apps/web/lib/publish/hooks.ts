/**
 * The publish pipeline's abuse seams (E07 D2, D15, PRD §6.15).
 *
 *   verifyTurnstile     web client only, when a token is present (E06a)
 *   checkRequestLimit   anonymous publish, BEFORE the dedup probe
 *   checkRateLimit      anonymous publish, AFTER the dedup probe — new pages only
 *   checkReplaceLimit   anonymous replace, per site
 *   enqueueScan         every path that stores or re-serves bytes, after the
 *                       stores agree; fire and forget into `lib/scan/run.ts`
 *
 * NOTHING HERE JUDGES CONTENT SYNCHRONOUSLY. E04 reserved a heuristic check
 * that answered 422; D2 deleted it and its error code. A page is live the moment its
 * stores agree and the asynchronous scan is what can take it down, so there is
 * one content judgement, not two that disagree.
 *
 * THE GOVERNORS ARE THE ANONYMOUS PATH'S ALONE (D15). Signed-in studio
 * publishing and replacing never call them — see `lib/sites/publish.ts`.
 *
 * The RESULT SHAPE is load-bearing: agents are the primary caller, and an error
 * an agent cannot parse is an infinite retry loop. Every limiter returns
 * `retryAfterSeconds`, which the caller turns into a 429 with
 * `retry_after_seconds` and a `Retry-After` header.
 */
import { PUBLISH_RATE_LIMITS, type ScanTrigger } from "@kept/shared";
import { after } from "next/server";

import { sendAdminAlert } from "../email/admin-alert";
import { hit, type RateLimitResult } from "../rate-limit";
import { runScan } from "../scan/run";
import { turnstileConfig } from "../storage/env";

/** Allowed, or refused with a reason a caller can act on. */
export type TurnstileResult = { ok: true } | { ok: false; reason: string };

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: string };

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Siteverify normally answers in well under a second; never hang a request on it. */
const TURNSTILE_TIMEOUT_MS = 5_000;

/**
 * Verify a Cloudflare Turnstile token against the siteverify endpoint.
 *
 * CALLED ONLY WHEN A TOKEN IS PRESENT, and that is a product decision rather
 * than an optimisation: keyless API callers — agents, scripts, `curl` — cannot
 * solve a CAPTCHA, and the epic's locked decision is that they publish anyway.
 * A missing token is therefore never a failure; the web client is the only
 * caller that sends one, and only that caller is held to it. Rate limits, the
 * draft TTL and scanning are the governors for everyone else. (The waitlist
 * forms are different: `waitlistJoinSchema` requires a token.)
 *
 * Any failure — `success: false`, a non-2xx, a network error or timeout, a
 * missing `TURNSTILE_SECRET_KEY` — is `{ ok: false, reason }`; it never throws.
 * `ip` is passed as `remoteip` when known; it is not logged.
 */
export async function verifyTurnstile(token: string, ip?: string): Promise<TurnstileResult> {
  let secretKey: string;
  try {
    secretKey = turnstileConfig().secretKey;
  } catch {
    // Fails CLOSED: a deploy without the secret must refuse every token rather
    // than wave them through. The variable's name is in the thrown error; the
    // caller only needs to know verification could not run.
    return { ok: false, reason: "verification unavailable" };
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);

  let outcome: { success?: boolean; "error-codes"?: string[] };
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `siteverify answered ${response.status}` };
    outcome = (await response.json()) as typeof outcome;
  } catch {
    return { ok: false, reason: "verification unreachable" };
  }

  if (outcome.success === true) return { ok: true };
  const codes = outcome["error-codes"]?.join(", ");
  return { ok: false, reason: codes ? `rejected: ${codes}` : "rejected" };
}


/** One limiter result in the publish vocabulary: a refusal names its rule. */
function decision(result: RateLimitResult, reason: string): RateLimitDecision {
  return result.allowed ? result : { ...result, reason };
}

/**
 * The pre-dedup ceiling: `publish-requests:<key>`, every anonymous publish
 * request, deduped or not. A dedup hit still rotates the token (a write), and
 * `app.` has no Cloudflare rate limiting in front of it, so a retry loop needs
 * a bound even when it creates nothing.
 *
 * `publisherKey` is `sites.publisher_hash` — the salted digest of IP + UA,
 * never an IP — and that is all a bucket ever holds.
 */
export async function checkRequestLimit(publisherKey: string): Promise<RateLimitDecision> {
  const rule = PUBLISH_RATE_LIMITS.requestsPerPublisherHour;
  return decision(
    await hit(`publish-requests:${publisherKey}`, rule),
    `${rule.limit} publish requests an hour`,
  );
}

/** The fixed bucket every anonymous new page counts against. */
export const PUBLISH_GLOBAL_BUCKET = "publish:global";

/**
 * The volume governors on NEW anonymous pages: `publish:<key>` 30 an hour and
 * 200 a day, then `publish:global` 1,000 an hour across everyone. Runs AFTER
 * the dedup probe, so an agent retrying the same publish gets its page back
 * without spending its budget. Stops at the first refusal, so a refused
 * publish does not also spend the buckets after it.
 *
 * THE DAY RULE HAS ITS OWN BUCKET, `publish:<key>:day`. `rate_limits` is keyed
 * on `(bucket, window_start)` and windows are aligned to the epoch, so the hour
 * starting 00:00 UTC and the day share a `window_start`: one bucket for both
 * would make those two rules increment the same row.
 *
 * The global cap tripping mails the admins at most once an hour (edge case 18).
 * The alert is awaited — one upsert while throttled, one send an hour — so the
 * 429 never races it. `globalBucket` exists for tests, which must never fill
 * the real one.
 */
export async function checkRateLimit(
  publisherKey: string,
  globalBucket: string = PUBLISH_GLOBAL_BUCKET,
): Promise<RateLimitDecision> {
  const { perPublisherHour, perPublisherDay, globalHour, globalCapAlertHour } =
    PUBLISH_RATE_LIMITS;

  const hour = decision(
    await hit(`publish:${publisherKey}`, perPublisherHour),
    `${perPublisherHour.limit} new pages an hour`,
  );
  if (!hour.allowed) return hour;

  const day = decision(
    await hit(`publish:${publisherKey}:day`, perPublisherDay),
    `${perPublisherDay.limit} new pages a day`,
  );
  if (!day.allowed) return day;

  const global = decision(
    await hit(globalBucket, globalHour),
    `kept is taking ${globalHour.limit} new anonymous pages an hour`,
  );
  if (!global.allowed) {
    await sendAdminAlert({
      subject: "anonymous publishing reached the global cap",
      lines: [
        `${globalBucket} reached ${globalHour.limit} new anonymous pages this hour.`,
        `Anonymous publishers get a 429 for the next ${global.retryAfterSeconds} seconds. Signed-in publishing is not limited.`,
      ],
      throttleKey: globalBucket,
      throttle: globalCapAlertHour,
    });
  }
  return global;
}

/**
 * Anonymous replace: `anon-replace:<siteId>`, 60 an hour per page. Keyed on the
 * page rather than the publisher — the bearer token is the identity here, and a
 * page re-dropped every minute is the pattern this bounds.
 */
export async function checkReplaceLimit(siteId: string): Promise<RateLimitDecision> {
  const rule = PUBLISH_RATE_LIMITS.anonReplacePerSiteHour;
  return decision(
    await hit(`anon-replace:${siteId}`, rule),
    `${rule.limit} replaces of this page an hour`,
  );
}

/**
 * Enqueue the asynchronous scan of a version that is already live.
 *
 * FIRE AND FORGET BY CONTRACT (D2): callers `void` it, it runs after the stores
 * agree, and it must never fail a publish or delay the response. The page is
 * live before the scan starts; a bad verdict moves it to `under_review`.
 * `trigger` is what the `scans` row records.
 *
 * Inside a request it is handed to Next's `after()`, which runs it once the
 * response is sent. Outside one (`after()` throws: a script, a test) it is a
 * floating promise on the long-lived process (Risk 9). `runScan` never
 * rejects; the `.catch` is the last line all the same. The cron job and the
 * admin CLI do not come through here — they await `runScan` directly.
 */
export function enqueueScan(siteId: string, versionId: string, trigger: ScanTrigger): void {
  const scan = () => runScan(siteId, versionId, trigger);
  try {
    after(scan);
  } catch {
    scan().catch((err: unknown) =>
      console.error(
        `[kept] scan of site ${siteId} version ${versionId} was lost — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}
