/**
 * The shared-secret gate on `/api/cron/*` — E05 task 011, inherited by E07.
 *
 * WHY THIS IS ITS OWN MODULE. There will be more than one scheduled route (E07
 * adds the expiry sweep and the grace-end purge) and they must all be gated the
 * same way. A guard copy-pasted into a second handler is a guard that
 * eventually diverges — and the divergence that matters here is "reject before
 * touching the database", which is easy to lose when the check is inline.
 *
 * WHY CONSTANT-TIME, WHEN `lib/publish/anon-token.ts` argues against it. The
 * cases are opposites. There, the stored value is a SHA-256 digest and the
 * comparison is an index equality — no secret is ever compared with `===`.
 * Here the raw secret is compared against attacker-supplied bytes in this
 * process, character by character, so a naive comparison leaks a prefix oracle
 * over an unlimited number of guesses. `timingSafeEqual` is the right tool
 * exactly where a raw secret is compared, and nowhere else.
 */
import { timingSafeEqual } from "node:crypto";

import { cronSecret } from "../storage/env";

/** `Authorization: Bearer <secret>` — the header CI schedulers already speak. */
const BEARER = /^Bearer\s+(.+)$/i;

/**
 * True when the request carries the scheduler's secret.
 *
 * Every rejection returns the same `false` — wrong scheme, absent header, wrong
 * secret, right secret with the wrong length. The caller answers all of them
 * with one fixed 401 body and does no work, so the endpoint reveals neither
 * whether it exists in a useful form nor whether it did anything.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const presentedText = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presentedText === undefined) return false;

  const presented = Buffer.from(presentedText, "utf8");
  const expected = Buffer.from(cronSecret(), "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // (crude) oracle for the secret's length. Compare against a digest-free
  // equal-length pair instead: a length difference short-circuits to false, and
  // the secret's length is not a meaningful secret once its entropy is 32+
  // random bytes.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
