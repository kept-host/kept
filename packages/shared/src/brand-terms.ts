// @kept/shared/names — the brand and phishing rule for chosen names (E07 §6.16).
//
// Reached only through `./names` (which re-exports it), never through the
// barrel: the Worker has no use for a name policy, exactly as for `./names`.
//
// The v1 lists below were proposed in E07 (open question Q4) and adopted as
// proposed by Arun on 2026-10-16. Every entry has a "must accept" case beside
// it in `apps/web/lib/names/brand-terms.test.ts`, which fails if an entry
// lands without one. Two deliberate moves away from the task's examples:
// `outlook` is an ordinary word, so it is a PAIR brand (the
// PRD's definition of the two lists), not a term blocked anywhere; and a term
// whose letters turn up inside ordinary words once hyphens are stripped and
// repeats collapsed (`google` → `gogle` ⊂ `goggles`, `icloud` ⊂ `musicloud`,
// `gmail` ⊂ `bigmail`, `revolut` ⊂ `revolution`) is a pair brand too, because
// a pair brand must be a whole token. Known residual false positives of the
// term list: a stripped name that spells a term across a hyphen
// (`coin-based-game` → `coinbasedgame` ⊃ `coinbase`, `cabin-ancestry` ⊃
// `binance`). Existing names are never re-checked (§6.16).
//
// ── Why its own normaliser, and not `obscenity`'s ────────────────────────────
// `obscenity`'s leetspeak transformer maps `1` to `i` only and rewrites one
// character at a time, so `paypa1` (`1` for `l`) and `rnicrosoft` (`rn` for
// `m`) pass it. Names are ASCII `[a-z0-9-]` (`slugSchema`), so no Unicode
// confusables are needed — only the handful of look-alikes this alphabet
// allows. Each mapping ADDS a variant beside the string it was applied to, so a
// genuine `1` or `rn` is still checked as itself.
//
// Pure: no database, no environment, no DOM, no Node API.

/**
 * Brands that are not ordinary words: refused anywhere in a name, in any
 * variant (`paypal-help`, `my-paypa1`, `pay-pal`).
 */
export const BLOCKED_NAME_TERMS = [
  "paypal",
  "microsoft",
  "office365",
  "metamask",
  "coinbase",
  "binance",
  "sparkasse",
  "docusign",
  "netflix",
  "instagram",
  "whatsapp",
  "facebook",
  "wellsfargo",
  "bankofamerica",
  "commerzbank",
  "deutschebank",
  "volksbank",
  "barclays",
  "trustwallet",
  "steamcommunity",
] as const;

/**
 * Brands that are also ordinary words (or sit inside them): refused only when
 * the brand is a whole token of the name and a {@link NAME_SECURITY_WORDS}
 * member sits beside it — as another token (`apple-id-login`) or glued to it
 * (`applelogin`, `secureapple`). `apple-pie`, `amazonia-update` and
 * `purchase-confirm` stay acceptable.
 */
export const BLOCKED_NAME_PAIRS = [
  "apple",
  "amazon",
  "chase",
  "google",
  "outlook",
  "icloud",
  "gmail",
  "yahoo",
  "ebay",
  "dropbox",
  "adobe",
  "ledger",
  "kraken",
  "revolut",
  "dhl",
  "steam",
] as const;

/** The words that turn a pair brand into a phishing name. */
export const NAME_SECURITY_WORDS = [
  "login",
  "signin",
  "verify",
  "secure",
  "account",
  "wallet",
  "support",
  "recovery",
  "unlock",
  "billing",
  "update",
  "confirm",
  "password",
] as const;

/** `0→o 3→e 4→a 5→s 7→t 8→b` — one mapping, since none of them is ambiguous. */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};

/** `0→o 3→e 4→a 5→s 7→t 8→b` over the whole string. */
function mapDigits(value: string): string {
  return value.replace(/[034578]/g, (digit) => DIGIT_LOOKALIKES[digit] ?? digit);
}

/** `aaa` → `a`: catches `paypall` and `gooogle`. */
function collapseRepeats(value: string): string {
  return value.replace(/(.)\1+/g, "$1");
}

/**
 * The mappings, applied in order. Each one adds its output beside every
 * variant so far, so a name is checked as written and in every look-alike
 * reading. `1` is ambiguous and is tried both ways; `i` and `l` are each
 * other's look-alike too (`paypai`), which goes one step past §6.16's list —
 * the spec's own must-refuse example needs it. Collapsing runs last so it sees
 * the letters the others produced.
 */
const MAPPINGS: readonly ((value: string) => string)[] = [
  (value) => value.replaceAll("-", ""),
  mapDigits,
  (value) => value.replaceAll("1", "i"),
  (value) => value.replaceAll("1", "l"),
  (value) => value.replaceAll("i", "l"),
  (value) => value.replaceAll("l", "i"),
  (value) => value.replaceAll("rn", "m"),
  (value) => value.replaceAll("vv", "w"),
  (value) => value.replaceAll("cl", "d"),
  collapseRepeats,
];

/** Every reading of `name` the rule checks, the name itself included. */
function nameVariants(name: string): Set<string> {
  let variants = new Set([name]);
  for (const map of MAPPINGS) {
    variants = new Set([...variants, ...[...variants].map(map)]);
  }
  return variants;
}

/**
 * A list word as a variant may spell it: as written, digit-mapped (a variant
 * maps every digit, so `office365` must also be looked for as `officee6s`), and
 * each of those collapsed.
 */
function spellings(word: string): string[] {
  const forms = [word, mapDigits(word)];
  return [...new Set([...forms, ...forms.map(collapseRepeats)])];
}

const TERM_SPELLINGS = BLOCKED_NAME_TERMS.flatMap(spellings);
const PAIR_SPELLINGS = new Set(BLOCKED_NAME_PAIRS.flatMap(spellings));
const SECURITY_SPELLINGS = new Set(NAME_SECURITY_WORDS.flatMap(spellings));

/** `token` is a pair brand glued to a security word, either way round. */
function isGluedPair(token: string): boolean {
  for (const brand of PAIR_SPELLINGS) {
    if (token.startsWith(brand) && SECURITY_SPELLINGS.has(token.slice(brand.length))) return true;
    if (token.endsWith(brand) && SECURITY_SPELLINGS.has(token.slice(0, -brand.length))) return true;
  }
  return false;
}

/** A pair brand is a whole token and a security word is beside it. */
function hasPair(variant: string): boolean {
  const tokens = variant.split("-");
  if (tokens.some(isGluedPair)) return true;
  return (
    tokens.some((token) => PAIR_SPELLINGS.has(token)) &&
    tokens.some((token) => SECURITY_SPELLINGS.has(token))
  );
}

/**
 * True when `name` reads as a brand kept will not hand out as a page name — a
 * {@link BLOCKED_NAME_TERMS} entry anywhere, or a {@link BLOCKED_NAME_PAIRS}
 * brand beside a security word — in any look-alike reading (`paypa1`,
 * `paypai`, `rnicrosoft`, `pay-pal`, `micr0soft`, `apple-id-verify`).
 */
export function isBlockedBrandName(name: string): boolean {
  for (const variant of nameVariants(name)) {
    if (TERM_SPELLINGS.some((term) => variant.includes(term))) return true;
    if (hasPair(variant)) return true;
  }
  return false;
}
