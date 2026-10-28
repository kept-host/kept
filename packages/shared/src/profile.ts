// @kept/shared — the creator profile, handle and referral contract (E10 D9–D12).
//
// `PATCH /api/profile`, `PUT /api/profile/handle` and `GET /api/referrals` in
// apps/web, and the Settings screens that call them, parse these — one shape
// for both halves. The DB CHECKs in migration `0012` repeat the numbers here and
// `migration-0012.test.ts` holds them equal.
//
// ⚠️ CONTROL PLANE ONLY. `apps/edge` never reads a profile; the badge carries
// what it needs (./badge).

import { z } from "zod";

import { BADGE_STYLES } from "./badge";
import { PROVENANCE_LIMITS } from "./provenance";
import { webGlobals } from "./web-globals";

/** Longest a bio may be, in characters (D12; also a DB CHECK). */
export const PROFILE_BIO_MAX = 160 as const;

/** Longest a display name may be, in characters. */
export const PROFILE_DISPLAY_NAME_MAX = 80 as const;

/** A handle may change once per this many days (D10). */
export const HANDLE_CHANGE_DAYS = 30 as const;

/** Length of a minted referral code (Q3: permanent, random, never rewritten). */
export const REFERRAL_CODE_LENGTH = 8 as const;

/**
 * The social networks a profile may link (D12), each with the hosts its URL may
 * be on (a subdomain of one counts: `www.`, `m.`). `website` is any `https://`
 * URL, so it has no host list.
 */
export const SOCIAL_HOSTS = {
  x: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "youtu.be"],
  github: ["github.com"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  bluesky: ["bsky.app"],
  website: null,
} as const satisfies Record<string, readonly string[] | null>;

export type SocialNetwork = keyof typeof SOCIAL_HOSTS;
export const SOCIAL_NETWORKS = Object.keys(SOCIAL_HOSTS) as SocialNetwork[];

/** Whether `url` is an `https://` URL on one of `network`'s hosts. */
export function isSocialUrl(network: SocialNetwork, url: string): boolean {
  let parsed: InstanceType<typeof webGlobals.URL>;
  try {
    parsed = new webGlobals.URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const hosts: readonly string[] | null = SOCIAL_HOSTS[network];
  if (hosts === null) return true;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
}

function socialUrl(network: SocialNetwork) {
  const where = SOCIAL_HOSTS[network];
  return z
    .string()
    .trim()
    .max(PROVENANCE_LIMITS.source_url)
    .refine((url) => isSocialUrl(network, url), {
      message: where
        ? `Use an https:// link on ${where.join(" or ")}.`
        : "Use an https:// link.",
    });
}

/**
 * The profile's social links. Every key optional; a link is a validated
 * `https://` URL on its network's host. The whole object REPLACES the stored
 * one, so a missing key is a removed link.
 */
export const socialsSchema = z
  .object(
    Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, socialUrl(n).optional()])) as {
      [N in SocialNetwork]: z.ZodOptional<ReturnType<typeof socialUrl>>;
    },
  )
  .strict();

export type Socials = z.infer<typeof socialsSchema>;

/**
 * `PATCH /api/profile` (D12). Any subset; an empty body is a caller bug.
 * `bio: ""` clears the bio (stored `null`). Whether `minimal` is allowed is a
 * plan question for `lib/plans/` (Q19), not a shape question.
 */
export const profileUpdateRequestSchema = z
  .object({
    displayName: z
      .string()
      .transform((name) => name.replace(/\s+/g, " ").trim())
      .pipe(
        z
          .string()
          .min(1, "Add a display name.")
          .max(PROFILE_DISPLAY_NAME_MAX, `Display names can be up to ${PROFILE_DISPLAY_NAME_MAX} characters.`),
      )
      .optional(),
    bio: z
      .string()
      .trim()
      .max(PROFILE_BIO_MAX, `Bios can be up to ${PROFILE_BIO_MAX} characters.`)
      .transform((bio) => bio || null)
      .optional(),
    socials: socialsSchema.optional(),
    badgeStyle: z.enum(BADGE_STYLES).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Send at least one of `displayName`, `bio`, `socials`, `badgeStyle`.",
  });

export type ProfileUpdateRequest = z.input<typeof profileUpdateRequestSchema>;

/**
 * `PUT /api/profile/handle` (D9). A plain string, like `nameChangeRequestSchema`:
 * every refusal and its wording belong to `validateName` and the handle check.
 */
export const handleChangeRequestSchema = z.object({
  handle: z.string(),
});

export type HandleChangeRequest = z.infer<typeof handleChangeRequestSchema>;

/**
 * A referral code as stored: lowercase letters and digits, `REFERRAL_CODE_LENGTH`
 * long (hex, minted by the `profiles.referral_code` column default in `0012`).
 */
export const referralCodeSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9]{${REFERRAL_CODE_LENGTH}}$`), "Not a referral code.");

/**
 * `GET /api/referrals` (D11, PRD §5.6). `refCode` is what the link carries — the
 * current handle when set, else the code (Q3). Only verified sign-ups count,
 * and each one shows a date and a display name, nothing else.
 */
export const referralStatsSchema = z.object({
  refCode: z.string(),
  verifiedCount: z.number().int().nonnegative(),
  referrals: z.array(
    z.object({
      createdAt: z.string().datetime(),
      displayName: z.string().nullable(),
    }),
  ),
});

export type ReferralStats = z.infer<typeof referralStatsSchema>;
