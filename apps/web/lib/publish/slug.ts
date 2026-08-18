// Slug minting for anonymous publish (E04).
//
// A slug is the first label of `{slug}.kept.host`. v1 mints a short random ID —
// no word list. Editing a slug to a human-chosen one (still on `.kept.host`) is
// the rename path E06 owns, and custom domains are the Pro tier; neither is
// this module's business.
//
// This is *generate-and-retry*, never check-then-insert: a pre-flight "is this
// slug free?" query is a race, and `sites_slug_key` is the only authority. So
// this module has no database access at all — its whole job is to produce a
// candidate that is well-shaped, not reserved and not offensive.

import { slugSchema } from "@kept/shared";

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

/**
 * Labels a minted slug may never take.
 *
 * **This list and the Worker's `RESERVED_LABELS` (`apps/edge/src/host.ts`) are
 * deliberately no longer mirrors as of E05a. Do not "fix" the divergence.**
 *
 * `app` is **absent there** on purpose: `app.{base}` is the control plane,
 * answered by Railway on a DNS-only (grey-cloud) record, so making it a reserved
 * serving label would 301 the control plane away from its own hostname and take
 * sign-in with it.
 *
 * `app` is **present here** on purpose: if that record is ever proxied by
 * accident, the Worker resolves `app.{base}` as an ordinary slug — and because
 * no page can be minted at `app`, the lookup misses and serves the branded 404
 * rather than somebody's uploaded HTML. Deleting it from this tuple to restore
 * the old symmetry is exactly the bug this comment exists to prevent.
 *
 * The rest of the tuple is the Worker's remaining reserved set (`www`, `api`,
 * `assets`) plus the control plane's own product routes. Duplicated rather than
 * imported on purpose: `apps/web` must not import from `apps/edge` (the
 * one-directional serve-path rule, enforced by ESLint), and hoisting it into
 * `@kept/shared` would drag the control plane's route names into the Worker
 * bundle for no reason. The Worker rejects its labels before they reach KV; this
 * list is the narrower rule the control plane applies when it assigns one.
 */
export const RESERVED_SLUGS = [
  // Reserved by the Worker too (`RESERVED_LABELS`), except `app` — which is
  // reserved ONLY here, by design. See the note above before touching it.
  "www",
  "app",
  "api",
  "assets",
  // Control-plane product routes.
  "p",
  "keep",
  "stats",
  "promise",
  "dashboard",
  "auth",
  "health",
] as const;

const reservedSet = new Set<string>(RESERVED_SLUGS);

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

/** True when the label is reserved for the edge or for a control-plane route. */
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
