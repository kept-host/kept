// @kept/shared — the pre-launch waitlist, founding applications and the limits
// that guard them (E06a). The control plane's forms, routes, migration `0007`
// and the rate limiter all read these; none of them restates a number.
import { z } from "zod";

/**
 * The consent line under every email field and in the confirmation mail
 * (PRD §3, verbatim). `[Privacy](/legal/privacy)` is data: forms render it as a
 * link, a plain-text mail renders it as text plus the URL.
 */
export const WAITLIST_CONSENT_TEXT =
  "Email me about kept: the launch, product news and offers. Unsubscribe anytime in one click. [Privacy](/legal/privacy)" as const;

/** Where a waitlist row came from (`waitlist.source`). `legacy` = a 0006 row. */
export const WAITLIST_SOURCES = [
  "landing_drop",
  "landing_nav",
  "landing_notify",
  "founding",
  "admin",
  "legacy",
] as const;
export type WaitlistSource = (typeof WAITLIST_SOURCES)[number];

/**
 * The sources a public form may claim. `admin` is the CLI's and `legacy` is the
 * migration default; a browser saying either is lying, so the request schema
 * refuses them.
 */
export const WAITLIST_FORM_SOURCES = [
  "landing_drop",
  "landing_nav",
  "landing_notify",
  "founding",
] as const satisfies readonly WaitlistSource[];

/** `waitlist.founding_status`; NULL means "not an applicant". */
export const FOUNDING_STATUSES = ["pending", "approved", "declined"] as const;
export type FoundingStatus = (typeof FOUNDING_STATUSES)[number];

/** Longest "What do you make with AI?" note, in characters (also a DB CHECK). */
export const FOUNDING_NOTE_MAX = 280 as const;

/** One fixed-window rule for `lib/rate-limit`'s `hit`. */
export type RateLimitRule = { readonly limit: number; readonly windowSeconds: number };

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** PRD §5 (E07 §6.8 adds the report limits). Over any of them: 429 with `Retry-After`. */
export const RATE_LIMITS = {
  /** `POST /api/waitlist`, founding applications included. */
  waitlistPerIp: { limit: 5, windowSeconds: HOUR_SECONDS },
  magicLinkPerIp: { limit: 5, windowSeconds: HOUR_SECONDS },
  magicLinkPerEmail: { limit: 3, windowSeconds: HOUR_SECONDS },
  /** Every confirmation mail, all addresses combined. */
  confirmationMailsGlobal: { limit: 300, windowSeconds: HOUR_SECONDS },
  /** `POST /api/reports` (E07 §6.8): two rules, because a rule holds one window. */
  reportPerIpHour: { limit: 5, windowSeconds: HOUR_SECONDS },
  reportPerIpDay: { limit: 20, windowSeconds: DAY_SECONDS },
  /**
   * `POST /api/uploads` (E08 D5), keyed by profile id (Arun, 2026-10-22,
   * Q-new-7). Governs only the presigned large-upload path; inline publishes
   * stay under E07's `PUBLISH_RATE_LIMITS`.
   */
  uploadsPerUser: { limit: 20, windowSeconds: HOUR_SECONDS },
} as const satisfies Record<string, RateLimitRule>;

/** A confirmation token stays valid this long after it is sent. */
export const WAITLIST_CONFIRM_TTL_DAYS = 7 as const;

/** A pending row is re-sent its confirmation only after this cooldown… */
export const WAITLIST_RESEND_COOLDOWN_MINUTES = 10 as const;

/** …and at most this many sends per UTC day. */
export const WAITLIST_MAX_SENDS_PER_DAY = 3 as const;

/** The founding review link (`/founding/review?t=…`) expires after this. */
export const FOUNDING_REVIEW_TTL_DAYS = 14 as const;

/** Unconfirmed rows are pruned this long after their last send. */
export const WAITLIST_PRUNE_DAYS = 30 as const;

/** Rate-limit buckets older than this are deleted. */
export const RATE_LIMIT_RETENTION_DAYS = 2 as const;

/** An absolute `http(s)` URL — never `javascript:`, since it renders as a link. */
const socialUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), "expected an http(s) URL");

/** A waitlist address, trimmed and lowercased: the table's dedup key. 254 is the longest SMTP carries. */
export const waitlistEmailSchema = z.string().trim().toLowerCase().email().max(254);

/** A founding application's details (the form's, and `admin:founding add`'s). */
export const foundingDetailsSchema = z.object({
  socialUrl: socialUrlSchema,
  note: z.string().trim().max(FOUNDING_NOTE_MAX).optional(),
});

/**
 * The `POST /api/waitlist` body. `founding` is present exactly when `source` is `founding`.
 */
export const waitlistJoinSchema = z
  .object({
    email: waitlistEmailSchema,
    source: z.enum(WAITLIST_FORM_SOURCES),
    turnstileToken: z.string().min(1).max(2048),
    founding: foundingDetailsSchema.optional(),
  })
  .refine((body) => (body.source === "founding") === (body.founding !== undefined), {
    message: "founding details go with source \"founding\" and only with it",
    path: ["founding"],
  });
export type WaitlistJoinRequest = z.infer<typeof waitlistJoinSchema>;
