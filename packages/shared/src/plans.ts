// @kept/shared — plan limits and the name rules' constants (E06, D1 / D3 / D5).
//
// ⚠️ THE ONE PLACE A LIMIT LIVES. Every cap in `apps/web` — the kept cap in
// keep / swap / the owned publish, the chosen-name quota and minimum length,
// the version count pruning keeps — reads `limitsFor(plan)`. No other module
// may contain one of these numbers, and `apps/web/lib/plans/limits.test.ts`
// fails the build when a `50` or a `1000` appears in app source outside its
// annotated allowlist.
//
// ⚠️ NO MODULE-LEVEL WORK BEYOND LITERALS. `apps/edge` imports the `@kept/shared`
// barrel, and `sideEffects: false` is a hint to a bundler, not a guarantee (the
// lesson `./mascot`'s subpath records). Anything here that RUNS at import —
// a `new Set(...)`, a matcher build — would be paid on the Worker's hot path,
// so every call at the top level is `/*#__PURE__*/`-annotated and everything
// else is a literal. The name *validator* and the inappropriate-word matcher
// carry a third-party word list and therefore live on the `@kept/shared/names`
// subpath (`./names.ts`), never in the barrel.
//
// ⚠️ IMPORT DIRECTION. This file imports `./constants` and `./enums`;
// `./constants` must NEVER import this file. A cycle between two `const`
// modules is a temporal-dead-zone error waiting for a bundler to reorder them.

import { z } from "zod";

import { SLUG_MAX_LENGTH } from "./constants";
import type { Plan } from "./enums";

/** What one plan allows. Every field is a count or a length, never a price. */
export interface PlanLimits {
  /** Pages kept forever: `expires_at IS NULL` and not `archived` / `removed`. */
  readonly keptPages: number;
  /** Chosen names counted against the account — demoted pages keep counting (D3). */
  readonly chosenNames: number;
  /** Shortest name the plan grants. Never below `NAME_ABSOLUTE_MIN_LENGTH`. */
  readonly nameMinLength: number;
  /** Versions retained besides the current one (D7; PRD §16.1's default). */
  readonly previousVersions: number;
}

export const PLAN_LIMITS = {
  free: { keptPages: 50, chosenNames: 5, nameMinLength: 5, previousVersions: 1 },
  premium: { keptPages: 1000, chosenNames: 50, nameMinLength: 4, previousVersions: 20 },
} as const satisfies Record<Plan, PlanLimits>;

/**
 * The limits an account on `plan` gets — the ONE function every cap in
 * `apps/web` reads (D1).
 *
 * E11 layers entitlements (trials, grandfathering, per-account overrides)
 * UNDER this function, by changing what it returns; callers never learn where
 * a number came from. Nothing else may contain a limit — a cap read from
 * anywhere but here is a cap E11 cannot change.
 */
export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * The floor under every plan's `nameMinLength`: nobody, on any plan, gets a
 * name of three characters or fewer. A plan may only raise it.
 */
export const NAME_ABSOLUTE_MIN_LENGTH = 4 as const;

/**
 * Longest a name may be. Defined AS `SLUG_MAX_LENGTH` — a name becomes the
 * first label of `{name}.kept.host`, so the DNS label limit is the rule, and
 * a second `63` would be a second source.
 */
export const NAME_MAX_LENGTH = SLUG_MAX_LENGTH;

/** Days a released chosen name stays held for its last owner (D4). */
export const NAME_HOLD_DAYS = 365 as const;

/** Renames one account may make in a rolling 24 hours (D6). */
export const RENAMES_PER_DAY = 10 as const;

/**
 * Names no page may take, minted or chosen — PRD §5.4's list ∪ the labels the
 * control plane already refused before E06 (`p`, `health`, `site`). E07 extends
 * it with brand and phishing terms; additions edit this one array.
 *
 * **This list and the Worker's `RESERVED_LABELS` (`apps/edge/src/host.ts`) are
 * deliberately not mirrors (06 §3, E05a). Do not "fix" the divergence.** The
 * Worker's list is the small set it refuses before reaching KV; this is the
 * wider rule the control plane applies when it ASSIGNS a name. The Worker
 * never imports this array.
 *
 * `app` is the case that proves why. It is **absent** from the Worker's list
 * on purpose: `app.{base}` is the control plane, answered by Railway on a
 * DNS-only record, so reserving it at the edge would 301 the control plane
 * away from its own hostname and take sign-in with it. It is **present** here
 * on purpose: if that record is ever proxied by accident, the Worker resolves
 * `app.{base}` as an ordinary slug — and because no page can be named `app`,
 * the lookup misses and serves the branded 404 rather than somebody's HTML.
 * Deleting it from this array to restore a symmetry is exactly the bug this
 * comment exists to prevent.
 */
export const RESERVED_NAMES = [
  // Platform hostnames and infrastructure. `app` — see above before touching it.
  "www",
  "api",
  "app",
  "assets",
  "mcp",
  "admin",
  "root",
  "mail",
  "smtp",
  "status",
  "static",
  "cdn",
  "img",
  "media",
  "dev",
  "staging",
  "test",
  "health",
  // Product, help and policy surfaces.
  "docs",
  "blog",
  "help",
  "support",
  "explore",
  "founding",
  "wall",
  "legal",
  "abuse",
  "report",
  "stats",
  "promise",
  "faq",
  "about",
  "pricing",
  // Accounts and the studio's own routes.
  "login",
  "signin",
  "signup",
  "auth",
  "account",
  "settings",
  "dashboard",
  "site",
  "p",
  // The product's own vocabulary.
  "kept",
  "keep",
  "draft",
] as const;

/**
 * Every answer the name check can give (PRD §5.4), as a closed set. The first
 * five are `validateName`'s (pure, `@kept/shared/names`); the rest need the
 * database and are produced by `apps/web`'s names module.
 *
 * `inappropriate` is not in the PRD's table: Arun's decision 5 (2026-10-04)
 * pulled the word filter forward from E07 and gave it its own status rather
 * than folding it into `reserved`, so the field can say which rule refused.
 */
export const NAME_CHECK_STATUSES = [
  "invalid",
  "too_short",
  "pro_length",
  "reserved",
  "inappropriate",
  "held_for_you",
  "taken",
  "quota",
  "rate_limited",
  "available",
] as const;

export const nameCheckStatusEnum = /*#__PURE__*/ z.enum(NAME_CHECK_STATUSES);
export type NameCheckStatus = (typeof NAME_CHECK_STATUSES)[number];
