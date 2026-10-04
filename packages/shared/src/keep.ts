// @kept/shared — the keep / demote / swap contract (E05).
//
// Result and quota shapes for attaching an anonymous draft to an account, for
// demoting a kept page back to a draft, and for the atomic swap between the two.
// It lives here, next to the publish contract, for the same reason: one closed
// set with two consumers (the route handlers in apps/web and the browser client
// that parses their responses), so a second definition can never drift.
//
// ⚠️ CONTROL PLANE ONLY. Keeping is a Postgres concept — `apps/edge` must never
// import anything from this module. A draft and a kept page are both
// `status: 'live'` and travel the identical serving path; the Worker cannot tell
// them apart and has no reason to.

import { z } from "zod";

/**
 * How a keep attempt resolved.
 *
 * - `kept`        — the page is permanent: `expires_at`/`purge_after` cleared.
 * - `owned_draft` — the account was already at its plan's kept limit
 *                   (`limitsFor(plan).keptPages`), so the page is now *owned*
 *                   but keeps its clock, its countdown and a swap prompt.
 *
 * The cap is a **branch, not a guard clause**: keeping past it never errors,
 * never no-ops and never loses the page. Both outcomes are HTTP success.
 */
export const KEEP_OUTCOMES = ["kept", "owned_draft"] as const;

export const keepOutcomeEnum = z.enum(KEEP_OUTCOMES);
export type KeepOutcome = (typeof KEEP_OUTCOMES)[number];

/** The account's kept-page allowance at the moment a keep/demote/swap resolved. */
export interface KeptQuota {
  /** `limitsFor(plan).keptPages` for the account's plan — never a literal. */
  limit: number;
  used: number;
  remaining: number;
}

/**
 * ⚠️ `limit` IS A NUMBER, NOT A LITERAL. It was `z.literal(KEPT_PAGE_LIMIT)`,
 * which made every `keepResultSchema.parse` throw — a 500 on every keep — the
 * moment an account's limit was anything but the free one. The plan decides
 * the value (`limitsFor`); the schema only decides its shape.
 */
export const keptQuotaSchema = z.object({
  limit: z.number().int().positive(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

/**
 * The outcome of keeping a page. Timestamps are ISO 8601 strings because this
 * crosses the wire; converting to `Date` is the caller's business.
 */
export type KeepResult =
  | {
      outcome: "kept";
      siteId: string;
      slug: string;
      quota: KeptQuota;
    }
  | {
      outcome: "owned_draft";
      siteId: string;
      slug: string;
      quota: KeptQuota;
      /** The retained draft clock (`DRAFT_TTL_DAYS` from the keep, at cap). */
      expiresAt: string;
      /** End of the post-expiry grace window (`DRAFT_GRACE_DAYS`). */
      purgeAfter: string;
    };

/**
 * The two branches, named rather than inlined into the union below.
 *
 * ⚠️ EXPORTED SO E06's OWNED PUBLISH CAN EXTEND THEM (task 004). A signed-in
 * publish resolves into the SAME two outcomes — under the cap the page is kept,
 * at the cap it lands as an owned draft — and it carries two extra fields the
 * browser needs (`./manage`'s `ownedPublishResultSchema`). Extending these is
 * how that stays one vocabulary: re-spelling `outcome`/`siteId`/`slug`/`quota`
 * in a second discriminated union would invent a third shape that agrees with
 * this one only until somebody edits one of them.
 */
export const keepResultBranches = {
  kept: z.object({
    outcome: z.literal("kept"),
    siteId: z.string(),
    slug: z.string(),
    quota: keptQuotaSchema,
  }),
  ownedDraft: z.object({
    outcome: z.literal("owned_draft"),
    siteId: z.string(),
    slug: z.string(),
    quota: keptQuotaSchema,
    expiresAt: z.string().datetime(),
    purgeAfter: z.string().datetime(),
  }),
} as const;

export const keepResultSchema = z.discriminatedUnion("outcome", [
  keepResultBranches.kept,
  keepResultBranches.ownedDraft,
]);

/**
 * The outcome of demoting a kept page back to a draft. There is no outcome
 * discriminant: demote always succeeds and always sets a fresh clock. The page
 * keeps serving at the same URL — demoting removes nothing.
 */
export interface DemoteResult {
  siteId: string;
  slug: string;
  expiresAt: string;
  purgeAfter: string;
  quota: KeptQuota;
}

export const demoteResultSchema = z.object({
  siteId: z.string(),
  slug: z.string(),
  expiresAt: z.string().datetime(),
  purgeAfter: z.string().datetime(),
  quota: keptQuotaSchema,
});

/**
 * Demote one page and keep another in a single transaction, so a partial swap
 * can never leave an account below or above the cap. The kept half is the `kept`
 * branch by construction — a swap that landed an `owned_draft` would mean the
 * demote did not free a slot, which is the failure the transaction prevents.
 */
export interface SwapResult {
  demoted: DemoteResult;
  kept: Extract<KeepResult, { outcome: "kept" }>;
}

export const swapResultSchema = z.object({
  demoted: demoteResultSchema,
  kept: z.object({
    outcome: z.literal("kept"),
    siteId: z.string(),
    slug: z.string(),
    quota: keptQuotaSchema,
  }),
});
