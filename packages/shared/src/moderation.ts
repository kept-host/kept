// @kept/shared — abuse and moderation (E07). The scanner, the moderation
// module, reports, appeals, the lifecycle jobs, migration `0008`'s CHECKs and
// the volume governors all read these; none of them restates a number or a
// value set (no `0.8`, `500`, `30`, `120`, `180` or `24000` literal in app code).
import { z } from "zod";

import type { RateLimitRule } from "./waitlist";

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * Why a page was restricted (PRD §7). Mirrored by the `moderation_reason`
 * pgEnum — `sites.moderation_reason`, `scans.reason`, `abuse_reports.category`,
 * `moderation_actions.reason` — so adding a value is a migration.
 */
export const MODERATION_REASONS = [
  "phishing",
  "payment_fraud",
  "crypto_scam",
  "malware",
  "scam",
  "suspicious_code",
  "child_sexual_abuse",
  "illegal_other",
  "copyright",
  "hate_or_violence",
  "spam",
  "other",
] as const;

export const moderationReasonEnum = /*#__PURE__*/ z.enum(MODERATION_REASONS);
export type ModerationReason = (typeof MODERATION_REASONS)[number];

/**
 * The owner-facing "why" (PRD Appendix A, verbatim) and the numbered
 * acceptable-use rule it cites (`content/legal/acceptable-use.md`, rules 1–7).
 * One source for the statement of reasons, the restricted banner and the admin
 * screen. `other` cites no single rule: its sentence points at the note the
 * moderator writes.
 */
export const MODERATION_REASON_SENTENCES: Readonly<
  Record<ModerationReason, { sentence: string; aupSection: number | null }>
> = {
  phishing: {
    sentence: "It looks like it asks people to sign in to a service it isn't.",
    aupSection: 1,
  },
  payment_fraud: {
    sentence: "It looks like it asks for card or bank details under false pretences.",
    aupSection: 1,
  },
  crypto_scam: {
    sentence: "It looks like it asks for a wallet's recovery phrase or keys.",
    aupSection: 1,
  },
  malware: { sentence: "It looks like it pushes a harmful download.", aupSection: 3 },
  scam: {
    sentence: "It looks like a scam that asks people for money or personal details.",
    aupSection: 2,
  },
  suspicious_code: {
    sentence: "It hides its code and asks for passwords or payment details.",
    aupSection: 1,
  },
  child_sexual_abuse: {
    sentence: "It was reported or detected as child sexual abuse material.",
    aupSection: 4,
  },
  illegal_other: { sentence: "It was reported as illegal content.", aupSection: 5 },
  copyright: {
    sentence: "It was reported for copyright or trademark infringement.",
    aupSection: 5,
  },
  hate_or_violence: {
    sentence: "It was reported for hate, harassment or violence.",
    aupSection: 6,
  },
  spam: { sentence: "It was reported as spam.", aupSection: 7 },
  other: {
    sentence: "It breaks our acceptable-use rules (see the note).",
    aupSection: null,
  },
};

/**
 * Bumped whenever the extractor, the classifier prompt or the policy changes
 * in a way that can change a verdict. A `done` scan is reused only for the same
 * `(content_hash, policy_version)`, so a bump re-scans everything it touches.
 */
export const SCAN_POLICY_VERSION = "2026-10-15.1" as const;

/** Most extracted page text sent to the classifier, in characters (§6.2). */
export const SCAN_TEXT_BUDGET_CHARS = 24000 as const;

/** The policy's confidence thresholds (§6.4). Starting values; the eval sets the final ones. */
export const SCAN_THRESHOLDS = { harm: 0.8, minors: 0.5, impersonates: 0.6 } as const;
export type ScanThresholds = { readonly [K in keyof typeof SCAN_THRESHOLDS]: number };

/**
 * Delay before each retry of a `failed` scan, in SECONDS (§6.5): 5 min, 15 min,
 * 1 h, 6 h, 24 h. Attempt N waits `SCAN_RETRY_DELAYS[N - 1]`; past the last, the
 * scan stays `failed`.
 */
export const SCAN_RETRY_DELAYS = [
  5 * MINUTE_SECONDS,
  15 * MINUTE_SECONDS,
  HOUR_SECONDS,
  6 * HOUR_SECONDS,
  DAY_SECONDS,
] as const;

/** What enqueued a scan (`scans.trigger`). */
export const SCAN_TRIGGERS = [
  "publish",
  "replace",
  "restore",
  "report",
  "traffic_spike",
  "backfill",
] as const;
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];

/** `scans.status`. `skipped`: the scanner is off (no `OPENROUTER_API_KEY`, D17). */
export const SCAN_STATUSES = ["pending", "done", "failed", "skipped"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** `scans.verdict`, set when a scan is `done`. */
export const SCAN_VERDICTS = ["clean", "flag"] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/** `abuse_reports.status`. `duplicate`: same site + reporter within 24 h, no alert. */
export const REPORT_STATUSES = ["open", "actioned", "dismissed", "duplicate"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** `appeals.status`. At most one `open` appeal per site (partial unique index). */
export const APPEAL_STATUSES = ["open", "granted", "rejected"] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** Who changed a page's status (`moderation_actions.actor`). */
export const MODERATION_ACTORS = ["scanner", "report", "admin"] as const;
export type ModerationActor = (typeof MODERATION_ACTORS)[number];

/** What a moderation step did (`moderation_actions.action`). */
export const MODERATION_ACTIONS = [
  "flag",
  "hide",
  "remove",
  "restore",
  "dismiss_report",
  "appeal_granted",
  "appeal_rejected",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/**
 * The report form's "What's wrong?" options (§6.8), in display order, each the
 * `moderation_reason` it is stored as. The mapping lives here, not in a route.
 */
export const REPORT_CATEGORIES = [
  { reason: "phishing", label: "Phishing or stolen logins" },
  { reason: "scam", label: "Scam or fraud" },
  { reason: "malware", label: "Malware or harmful download" },
  { reason: "child_sexual_abuse", label: "Child sexual abuse material" },
  { reason: "illegal_other", label: "Other illegal content" },
  { reason: "copyright", label: "Copyright or trademark" },
  { reason: "hate_or_violence", label: "Hate, harassment or violence" },
  { reason: "spam", label: "Spam" },
  { reason: "other", label: "Something else" },
] as const satisfies readonly { reason: ModerationReason; label: string }[];
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]["reason"];

/** A report's explanation, in characters. */
export const REPORT_DETAILS_MIN = 20 as const;
export const REPORT_DETAILS_MAX = 2000 as const;

/** An appeal's message, in characters. */
export const APPEAL_MESSAGE_MIN = 20 as const;
export const APPEAL_MESSAGE_MAX = 2000 as const;

/** At most `limit` appeals per site in any `days`-day window. */
export const APPEALS_PER_SITE_WINDOW = { limit: 3, days: 30 } as const;

/** Traffic spikes (§6.12): a day with at least this many visits… */
export const SPIKE_MIN_VISITS = 500 as const;
/** …and this many times the page's baseline… */
export const SPIKE_MULTIPLIER = 10 as const;
/** …averaged over this many preceding days, re-scans the page… */
export const SPIKE_BASELINE_DAYS = 7 as const;
/** …for at most this many pages per checked day. */
export const SPIKE_DAILY_CAP = 50 as const;

/** More failed scans than this in 24 h → one admin mail per day. */
export const SCAN_FAILURE_ALERT_THRESHOLD = 20 as const;

/** A current version older than this with no scan row is picked up by `scan-retry`. */
export const UNSCANNED_GRACE_MINUTES = 10 as const;

/** A `pending_purges` row is replayed at most this many times, then an admin alert. */
export const REPURGE_MAX_ATTEMPTS = 5 as const;

/** `pending_purges` rows the `repurge` job reads per query, until none are due or its deadline. */
export const REPURGE_BATCH_SIZE = 50 as const;

/** A reporter's name and email are cleared this long after the report is resolved. */
export const REPORTER_CONTACT_RETENTION_DAYS = 180 as const;

/** The expiry sweep's batch size… */
export const EXPIRE_BATCH_SIZE = 500 as const;
/** …and every lifecycle job's wall-clock budget per run, in seconds. */
export const JOB_DEADLINE_SECONDS = 50 as const;

/** The admin screen's escaped Source view shows at most this many bytes. */
export const ADMIN_SOURCE_PREVIEW_BYTES = 200 * 1024;

/**
 * The volume governors (§6.15), one `lib/rate-limit` rule per window. The
 * `publish:*` buckets count NEW pages and run after the dedup probe; the
 * request ceiling runs before it. E09 revisits these for shared-egress traffic.
 */
export const PUBLISH_RATE_LIMITS = {
  /** `publish:<publisherKey>` — new pages per publisher per hour. */
  perPublisherHour: { limit: 30, windowSeconds: HOUR_SECONDS },
  /** `publish:<publisherKey>` — new pages per publisher per day. */
  perPublisherDay: { limit: 200, windowSeconds: DAY_SECONDS },
  /** `publish:global` — anonymous new pages across everyone per hour. */
  globalHour: { limit: 1000, windowSeconds: HOUR_SECONDS },
  /** `publish-requests:<publisherKey>` — the pre-dedup ceiling per hour. */
  requestsPerPublisherHour: { limit: 120, windowSeconds: HOUR_SECONDS },
  /** Anonymous replaces of one page per hour. */
  anonReplacePerSiteHour: { limit: 60, windowSeconds: HOUR_SECONDS },
  /** The "global cap tripped" admin mail, at most once per hour. */
  globalCapAlertHour: { limit: 1, windowSeconds: HOUR_SECONDS },
} as const satisfies Record<string, RateLimitRule>;

/**
 * `POST /api/sites/:id/appeal` and `POST /api/anon/:token/appeal` (§6.10): the
 * owner's or token holder's words, trimmed, `APPEAL_MESSAGE_MIN`–`_MAX` chars.
 */
export const appealRequestSchema = z.object({
  message: z.string().trim().min(APPEAL_MESSAGE_MIN).max(APPEAL_MESSAGE_MAX),
});
export type AppealRequest = z.infer<typeof appealRequestSchema>;

/**
 * Every code the two appeal routes refuse with. ONE envelope for both — the
 * restricted banner (studio and `/p`) is one component with one parser. The
 * studio route's 401 and E05a's origin 403 keep their own bodies: they run
 * before any appeal code.
 */
export const APPEAL_ERROR_CODES = [
  "invalid",
  "not_found",
  "not_restricted",
  "appeal_open",
  "rate_limited",
] as const;
export const appealErrorCodeEnum = /*#__PURE__*/ z.enum(APPEAL_ERROR_CODES);
export type AppealErrorCode = (typeof APPEAL_ERROR_CODES)[number];

/** `{ error: { code, message } }`, plus `retry_after_seconds` on `rate_limited`. */
export const appealErrorSchema = z.object({
  error: z.object({ code: appealErrorCodeEnum, message: z.string() }),
  retry_after_seconds: z.number().int().positive().optional(),
});
export type AppealError = z.infer<typeof appealErrorSchema>;

/** The `201` body: the appeal as it now stands. */
export const appealResultSchema = z.object({
  appeal: z.object({
    id: z.string().uuid(),
    status: z.literal("open"),
    createdAt: z.string().datetime(),
  }),
});
export type AppealResult = z.infer<typeof appealResultSchema>;
