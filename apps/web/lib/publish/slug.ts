// Slug minting for anonymous publish (E04), and the acceptance rule for a
// human-chosen slug (E06's rename).
//
// A slug is the first label of `{slug}.kept.host`. v1 mints a short random ID —
// no word list. Custom domains are the Pro tier and are not this module's
// business; `checkChosenSlug` at the foot of this file is, and it is the ONE
// place both callers of the rule live (the PATCH handler and the browser field
// that previews its answer as you type).
//
// This is *generate-and-retry*, never check-then-insert: a pre-flight "is this
// slug free?" query is a race, and `sites_slug_key` is the only authority. So
// this module has no database access at all — its whole job is to produce a
// candidate that is well-shaped, not reserved and not offensive.

import { RESERVED_NAMES, SLUG_MAX_LENGTH, slugSchema } from "@kept/shared";

/**
 * Crockford base32, lowercased: the digits plus the letters minus `i`, `l`, `o`
 * and `u`. The first three are dropped because they are unreadable next to `1`
 * and `0` in a URL someone may retype; `u` is dropped because Crockford drops it
 * to keep accidental words from forming.
 */
export const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Characters per slug. 32^8 ≈ 1.1e12 candidates, so at a million published
 * pages a single attempt collides with probability ~1e-6 — which is what makes
 * task 005's bounded unique-violation retry a calculation rather than a guess.
 */
export const SLUG_LENGTH = 8;

/** Attempts before `mintSlugCandidate` gives up rather than looping forever. */
const MAX_MINT_ATTEMPTS = 16;

const reservedSet = new Set<string>(RESERVED_NAMES);

/**
 * Substrings that disqualify a candidate.
 *
 * A random alphabet cannot produce a curated word, so this is not about the
 * generator picking a bad word — it is about eight random characters happening
 * to spell one. Only forms spellable in `SLUG_ALPHABET` are listed (no `i`,
 * `l`, `o` or `u`), including the common digit substitutions.
 */
const PROFANITY_SUBSTRINGS = [
  "a55",
  "anal",
  "arse",
  "ass",
  "azz",
  "bastard",
  "crap",
  "damn",
  "dyke",
  "fag",
  "fap",
  "fart",
  "fck",
  "jap",
  "kkk",
  "kys",
  "negr",
  "nggr",
  "phag",
  "prn",
  "rape",
  "retard",
  "sex",
  "5ex",
  "shag",
  "shat",
  "sht",
  "skank",
  "slag",
  "smeg",
  "spaz",
  "tard",
  "twat",
  "wank",
  "wtf",
  "xxx",
] as const;

/**
 * True when the label is one no page may take — `RESERVED_NAMES`, the single
 * list in `@kept/shared` (why `app` is on it, and why the Worker's own
 * `RESERVED_LABELS` is a different, smaller list, is recorded there).
 */
export function isReservedSlug(slug: string): boolean {
  return reservedSet.has(slug);
}

/** True when the candidate contains a blocked substring. */
export function containsProfanity(slug: string): boolean {
  return PROFANITY_SUBSTRINGS.some((word) => slug.includes(word));
}

/** `SLUG_LENGTH` characters drawn uniformly from `SLUG_ALPHABET` via a CSPRNG. */
function randomSlug(): string {
  // 256 is a whole multiple of the 32-character alphabet, so masking the low 5
  // bits of each byte is uniform — no rejection sampling needed.
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  let slug = "";
  for (const byte of bytes) {
    slug += SLUG_ALPHABET[byte & 0b11111];
  }
  return slug;
}

/**
 * A fresh slug candidate. Not checked against the database — the caller inserts
 * and retries on the unique violation.
 *
 * @throws if it cannot produce an acceptable candidate, which at these
 * rejection rates means the CSPRNG is broken, not that the keyspace is full.
 */
export function mintSlugCandidate(): string {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const candidate = randomSlug();
    if (isReservedSlug(candidate) || containsProfanity(candidate)) continue;
    // Assert the module's own output rather than trusting the alphabet: the
    // slug is about to become a hostname label.
    if (slugSchema.safeParse(candidate).success) return candidate;
  }
  throw new Error(
    `Could not mint a slug candidate in ${MAX_MINT_ATTEMPTS} attempts.`,
  );
}

/** Why a chosen slug was refused. The three rules, kept apart for the UI. */
export type SlugRefusalReason = "shape" | "reserved" | "profanity";

export interface SlugRefusal {
  reason: SlugRefusalReason;
  /** Shown to the person typing. Written for them, not for a log. */
  message: string;
}

/**
 * Whether a HUMAN-CHOSEN slug is acceptable. `null` means yes.
 *
 * Pure — no database, no environment, no `next/*`. That is what lets the rename
 * field in the browser run the identical rule as the PATCH handler instead of
 * a lookalike, and it is why the availability question is NOT answered here:
 * availability is not a property of the string. `sites_slug_key` is the only
 * authority on it and the only place it may be decided (see `./slug.ts`'s
 * generate-and-retry note and `lib/sites/rename.ts`).
 *
 * ⚠️ NECESSARY, NOT SUFFICIENT — AND E07 OWNS THE REST. Every slug before E06
 * came out of `mintSlugCandidate`, and both lists below were written for that
 * threat model: `RESERVED_NAMES` protects labels the platform answers on, and
 * `PROFANITY_SUBSTRINGS` is about eight random characters happening to spell a
 * word, not about a person choosing one. A human typing a name walks straight
 * through both. **None of the following is covered here, deliberately:**
 *
 *   · impersonation — `paypal-verify`, `signin-microsoft`, `apple-id-locked`;
 *   · typosquatting and homoglyph tricks — `paypa1-secure`, `g00gle-docs`,
 *     `rnicrosoft` (`rn` for `m`), and every confusable this alphabet allows;
 *   · any reputation signal at all — no account age, no publish history, no
 *     rate limit on how many names one account may cycle through;
 *   · brand and trademark policy, and the takedown path behind it.
 *
 * That is **E07-abuse-and-moderation's** scope (epic: "No impersonation or
 * typosquat policy for user-chosen slugs. Explicitly deferred to E07, and the
 * deferral is recorded in code where the rename validation lives" — this is
 * that record). Until E07 lands, a chosen slug is refused only for the three
 * mechanical reasons below, and `paypa1-secure.kept.host` IS publishable.
 * Do not read the presence of these checks as a claim that the namespace is
 * policed.
 */
export function checkChosenSlug(slug: string): SlugRefusal | null {
  if (!slugSchema.safeParse(slug).success) {
    return {
      reason: "shape",
      message: `Use lowercase letters, numbers and single hyphens between them — up to ${SLUG_MAX_LENGTH} characters, and no hyphen at either end.`,
    };
  }
  if (isReservedSlug(slug)) {
    return {
      reason: "reserved",
      message: `"${slug}" is reserved by kept itself. Try another name.`,
    };
  }
  if (containsProfanity(slug)) {
    return {
      reason: "profanity",
      message: "That name contains a word kept does not put in a URL. Try another one.",
    };
  }
  return null;
}
