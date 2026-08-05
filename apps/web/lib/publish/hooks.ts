/**
 * The four E07 seams the publish pipeline calls — SIGNATURES ARE FINAL, BODIES
 * ARE NOT.
 *
 * E07 (abuse and moderation) owns Turnstile verification, per-publisher rate
 * limiting, the heuristic content check and scan enqueue. None of them exist
 * yet. They are declared here, as named functions with the shapes E07 will
 * return, rather than as `// TODO` comments in the route, for one reason: E07
 * must be able to fill these bodies WITHOUT editing `app/api/publish/route.ts`
 * or `lib/publish/pipeline.ts`. If E07 finds itself back in either file, the
 * seam below was cut in the wrong place.
 *
 * Each stub is deliberately PERMISSIVE — allow, allow, allow, no-op — so the
 * epic ships a working keyless publish while the governors are still absent.
 * The permissive default is safe only because the draft TTL is the real
 * backstop in the interim: nothing published here survives `DRAFT_TTL_DAYS`
 * unless a human signs in and keeps it.
 *
 * The RESULT SHAPES are the part that is load-bearing today. Agents are the
 * primary caller of this API, and an error an agent cannot parse is an infinite
 * retry loop — so `checkRateLimit` already carries `retryAfterSeconds` and the
 * pipeline already turns it into a 429 with `retry_after_seconds` and a
 * `Retry-After` header. E07 changes when that branch is taken, never what it
 * looks like.
 */

/** Allowed, or refused with a reason a caller can act on. */
export type TurnstileResult = { ok: true } | { ok: false; reason: string };

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: string };

export type HeuristicDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Verify a Cloudflare Turnstile token against the siteverify endpoint.
 *
 * CALLED ONLY WHEN A TOKEN IS PRESENT, and that is a product decision rather
 * than an optimisation: keyless API callers — agents, scripts, `curl` — cannot
 * solve a CAPTCHA, and the epic's locked decision is that they publish anyway.
 * A missing token is therefore never a failure; the web client is the only
 * caller that sends one, and only that caller is held to it. Rate limits, the
 * draft TTL and scanning are the governors for everyone else.
 */
export async function verifyTurnstile(token: string): Promise<TurnstileResult> {
  // E07: POST to https://challenges.cloudflare.com/turnstile/v0/siteverify with
  // the secret key and the remote IP, and map `success: false` to `ok: false`.
  void token;
  return { ok: true };
}

/**
 * Per-publisher rate limiting and the volume governors.
 *
 * `publisherKey` is `sites.publisher_hash` — the salted digest of IP + UA, not
 * an IP. E07 counts against `sites_publisher_created_idx`, which task 001
 * created for exactly this query.
 */
export async function checkRateLimit(
  publisherKey: string,
): Promise<RateLimitDecision> {
  // E07: count recent rows for this publisher and refuse past the threshold,
  // returning the seconds until the window reopens.
  void publisherKey;
  return { allowed: true };
}

/**
 * The cheap, synchronous content check that runs BEFORE anything is stored —
 * the phishing/malware heuristics E07 defines. Distinct from `enqueueScan`,
 * which is the slow asynchronous pass over a page that is already live.
 */
export async function checkHeuristics(html: string): Promise<HeuristicDecision> {
  // E07: the heuristic ruleset (brand impersonation, credential forms, known
  // malicious patterns). Its output maps to a `content_rejected` 422.
  void html;
  return { allowed: true };
}

/**
 * Enqueue the asynchronous scan of a version that is already live.
 *
 * FIRE AND FORGET BY CONTRACT: it runs after the stores agree, and it must
 * never fail a publish or delay the response. The page is live before the scan
 * starts — the status flip on a bad verdict is E07's, through
 * `writeManifest`, and is the reason `under_review` and `quarantined` exist in
 * the manifest status enum.
 */
export async function enqueueScan(
  siteId: string,
  versionId: string,
): Promise<void> {
  // E07: push onto the scan queue keyed by (siteId, versionId).
  void siteId;
  void versionId;
}
