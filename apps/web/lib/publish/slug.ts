// Slug minting — the generated name every publish starts with (E04; D3 calls
// it a `generated` name, as opposed to one an owner chose).
//
// A slug is the first label of `{slug}.kept.host`. v1 mints a short random ID —
// no word list. A name an owner CHOSE is not this module's business: its rule
// is `validateName` (`@kept/shared/names`) and its availability is
// `lib/names/`'s.
//
// This module has no database access at all — its whole job is to produce a
// candidate that is well-shaped, not reserved and not offensive.
// `withMintedSlug` (`lib/db/queries/publish.ts`) asks the namespace about it and
// lets `sites_slug_key` arbitrate the insert.

import { RESERVED_NAMES, slugSchema } from "@kept/shared";
import { isInappropriateName } from "@kept/shared/names";

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
 * True when the label is one no page may take — `RESERVED_NAMES`, the single
 * list in `@kept/shared` (why `app` is on it, and why the Worker's own
 * `RESERVED_LABELS` is a different, smaller list, is recorded there).
 */
export function isReservedSlug(slug: string): boolean {
  return reservedSet.has(slug);
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
 * A fresh slug candidate. Not checked against the database — `withMintedSlug`
 * asks the namespace, inserts, and retries on the unique violation.
 *
 * @throws if it cannot produce an acceptable candidate, which at these
 * rejection rates means the CSPRNG is broken, not that the keyspace is full.
 */
export function mintSlugCandidate(): string {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const candidate = randomSlug();
    // Eight random characters can still spell a word. The matcher is the one
    // that refuses chosen names (Arun's decision 5), so a minted name is held
    // to the same rule — on a match, draw again.
    if (isReservedSlug(candidate) || isInappropriateName(candidate)) continue;
    // Assert the module's own output rather than trusting the alphabet: the
    // slug is about to become a hostname label.
    if (slugSchema.safeParse(candidate).success) return candidate;
  }
  throw new Error(
    `Could not mint a slug candidate in ${MAX_MINT_ATTEMPTS} attempts.`,
  );
}
