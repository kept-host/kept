// @kept/shared/names — the pure name rule, behind its own subpath export.
//
// **A subpath, not a barrel re-export, and for the reason `./mascot` gives.**
// `isInappropriateName` carries a third-party word list (`obscenity`'s English
// dataset). `apps/edge` imports the `@kept/shared` barrel, and the Worker has
// no use for a word list, so this module is never re-exported from
// `src/index.ts` and nothing the Worker imports may import it. Consumers —
// the names check route, the rename route, the minting path and the browser
// field that previews the answer as you type — import `@kept/shared/names`.
// The constants the rule reads (`RESERVED_NAMES`, `NAME_*`, `limitsFor`) stay
// in the barrel, in `./plans`, because they are literals.
//
// Pure: no database, no environment, no DOM, no Node API. Availability is not a
// property of the string and is not answered here — that is `apps/web`'s names
// module, which runs this first.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

import { isBlockedBrandName } from "./brand-terms";
import type { Plan } from "./enums";
import { NAME_ABSOLUTE_MIN_LENGTH, RESERVED_NAMES, limitsFor, type NameCheckStatus } from "./plans";
import { slugSchema } from "./schemas";

export { BLOCKED_NAME_PAIRS, BLOCKED_NAME_TERMS, NAME_SECURITY_WORDS, isBlockedBrandName } from "./brand-terms";

/**
 * Whole terms `obscenity`'s English dataset refuses that are ordinary words in a
 * page name, and that its own whitelist does not already cover. The dataset
 * matches `|cockp` on purpose; a flight-sim page is the false positive that
 * costs a real person their name.
 *
 * Each entry is a reviewed policy edit with a "must accept" case beside it in
 * `apps/web/lib/plans/validate-name.test.ts`. The brand and phishing rule is
 * E07's own matcher (`./brand-terms`), with its own must-accept list.
 */
const ACCEPTED_TERMS = ["cockpit"] as const;

let matcher: RegExpMatcher | undefined;

/**
 * Built on first use, not at import: the browser field and every route that
 * imports `validateName` would otherwise compile the dataset's patterns before
 * anyone typed a character.
 */
function inappropriateNameMatcher(): RegExpMatcher {
  if (!matcher) {
    const { blacklistedTerms, whitelistedTerms = [] } = englishDataset.build();
    matcher = new RegExpMatcher({
      blacklistedTerms,
      whitelistedTerms: [...whitelistedTerms, ...ACCEPTED_TERMS],
      ...englishRecommendedTransformers,
    });
  }
  return matcher;
}

/**
 * True when `name` contains a word kept does not put in a URL — including its
 * hyphenated, concatenated and leetspeak forms (`my-fuck-page`, `fuckpage`,
 * `fvck`, `sh1t`), and NOT ordinary words that merely contain one
 * (`classic`, `bass`, `assassin`, `scunthorpe`, `therapist`).
 *
 * `obscenity` (MIT) was chosen over `@2toad/profanity` because it resolves
 * leetspeak and confusables and matches inside concatenations while carrying a
 * whitelist against Scunthorpe false positives; `@2toad/profanity` matches whole
 * words only, so `fuckpage` and `fvck` pass it.
 */
export function isInappropriateName(name: string): boolean {
  return inappropriateNameMatcher().hasMatch(name);
}

/** What `validateName` can answer: `ok`, or one of the name check's pure statuses. */
export type NameValidation =
  | "ok"
  | Extract<NameCheckStatus, "invalid" | "reserved" | "inappropriate" | "too_short" | "pro_length">;

/**
 * Whether `name` is an acceptable name on `plan`, before anyone asks the
 * database. Shared by the check route, the rename route and the browser field,
 * so the field previews the server's rule rather than a lookalike.
 *
 * Order, first refusal wins:
 *
 *   1. shape (`slugSchema`: lowercase `a–z`, `0–9`, single hyphens, no edge
 *      hyphen, ≤ `NAME_MAX_LENGTH`)                              → `invalid`
 *   2. a `RESERVED_NAMES` member, or a brand / phishing name
 *      (`isBlockedBrandName`, E07 §6.16 — `./brand-terms`)        → `reserved`
 *   3. an inappropriate word (`isInappropriateName`)              → `inappropriate`
 *   4. shorter than `NAME_ABSOLUTE_MIN_LENGTH`                    → `too_short`
 *   5. shorter than the plan's `nameMinLength`                    → `pro_length`
 *
 * ⚠️ PRECEDENCE DEVIATION FROM PRD §5.4 (recorded in the PR). The PRD's table
 * lists `reserved` after `too_short` / `pro_length`, but AC22 requires a
 * reserved name to read `reserved` at every length. Under the table's order
 * `app` reads `too_short` and, worse, `docs` / `help` / `wall` on free read
 * `pro_length` — an upsell to a name Pro could never grant. Checking the
 * refusals that no plan lifts (reserved, inappropriate) before the ones a plan
 * does (length) removes that false upsell; it changes the outcome only for
 * reserved and inappropriate inputs.
 *
 * ⚠️ NECESSARY, NOT SUFFICIENT. This is a mechanical rule. Since E07 it
 * refuses the brand and phishing names of `./brand-terms` (`paypal-verify`,
 * `paypa1-secure`, `rnicrosoft`, `apple-id-login`) as `reserved` — a v1 list,
 * proposed for Arun's review. **Still not covered here, deliberately:** a brand
 * missing from those lists, any reputation signal (account age, publish
 * history), and trademark disputes — those go through reports and the
 * moderation queue (E07). Do not read these checks as a claim the namespace is
 * policed.
 */
export function validateName(name: string, plan: Plan): NameValidation {
  if (!slugSchema.safeParse(name).success) return "invalid";
  if ((RESERVED_NAMES as readonly string[]).includes(name)) return "reserved";
  if (isBlockedBrandName(name)) return "reserved";
  if (isInappropriateName(name)) return "inappropriate";
  if (name.length < NAME_ABSOLUTE_MIN_LENGTH) return "too_short";
  if (name.length < limitsFor(plan).nameMinLength) return "pro_length";
  return "ok";
}
