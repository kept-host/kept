/**
 * Every SQL statement the anonymous publish path issues. Postgres access lives
 * here and nowhere else in the pipeline: the route handler holds HTTP,
 * `lib/publish/pipeline.ts` holds the ordering, and this module holds the
 * queries — so a change to the dedup predicate is one edit in one file.
 *
 * POSTGRES IS THE AUTHORITY. Publish touches four stores with no distributed
 * transaction, so one of them has to be the record of what should exist, and
 * this is the only one with a transaction, the only one E07's divergence audit
 * can reconcile against, and the only one that can express "this row exists but
 * its bytes do not". It commits FIRST; every failure after it is a known
 * inconsistency with a defined unwind (`deleteSiteCascade`) rather than an
 * object in R2 that nobody can name.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { mintSlugCandidate } from "../../publish/slug";
import { db } from "../index";
import { sites, siteVersions } from "../schema";

/**
 * Slug attempts before giving up. The keyspace is 32^8 ≈ 1.1e12, so at a
 * million published pages one attempt collides with probability ~1e-6 and eight
 * independent attempts with ~1e-48: exhausting this bound means the unique index
 * or the CSPRNG is broken, not that the namespace is full. Bounded and loudly
 * fatal rather than an unbounded loop, because an unbounded retry against a
 * broken index is an outage that looks like a hang.
 */
const MAX_SLUG_ATTEMPTS = 8;

/** Thrown when slug minting exhausts `MAX_SLUG_ATTEMPTS`; maps to a 503. */
export class SlugUnavailableError extends Error {
  constructor() {
    super(
      `Could not mint an unused slug in ${MAX_SLUG_ATTEMPTS} attempts — the unique index or the random source is unhealthy.`,
    );
    this.name = "SlugUnavailableError";
  }
}

/**
 * True when `err` (or anything in its `cause` chain — Drizzle wraps driver
 * errors) is a Postgres unique violation on `sites_slug_key`.
 *
 * GENERATE-AND-RETRY, NEVER CHECK-THEN-INSERT: a "is this slug free?" query
 * answers a question that stops being true the instant it returns. The unique
 * index is the only authority, so a collision is detected by inserting and
 * reading the constraint name off the error.
 */
function isSlugCollision(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint_name === "sites_slug_key") {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
}

export interface DedupHit {
  siteId: string;
  slug: string;
  expiresAt: Date;
}

/**
 * The dedup probe, and the token rotation that goes with it, in ONE transaction.
 *
 * THE PREDICATE IS PINNED — `publisher_hash = ? AND content_hash = ? AND
 * expires_at > now()` — and is scoped per publisher on purpose. Byte-identical
 * HTML from two different publishers produces two pages with two tokens:
 * nobody is ever handed a stranger's page, or delete rights over it, because
 * their bytes happened to match. A global-by-hash variant is not a fallback, it
 * is a different and wrong feature. `expires_at > now()` also excludes kept
 * pages for free, since keeping (E05) nulls the clock.
 *
 * ⚠️ WHY THE TOKEN ROTATES. `sites.anon_token_hash` stores a digest, so the
 * ORIGINAL raw token is unrecoverable from this database — by design, and that
 * decision is not up for renegotiation (a raw-token column would make the old
 * token returnable and is precisely what this rotation exists to avoid). A
 * dedup hit therefore mints a FRESH token, rotates the hash on the existing row
 * and returns a new claim URL. The consequences are intended: the page itself
 * is untouched — same site, same slug, same version, same bytes, same clock —
 * the previous claim URL stops working, and exactly one claim URL is live at a
 * time.
 *
 * Returns `null` when nothing matched, leaving every row untouched.
 */
export async function claimDedupCandidate(input: {
  publisherHash: string;
  contentHash: string;
  anonTokenHash: string;
}): Promise<DedupHit | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        siteId: sites.id,
        slug: sites.slug,
        expiresAt: sites.expiresAt,
      })
      .from(sites)
      .where(
        and(
          eq(sites.publisherHash, input.publisherHash),
          eq(sites.contentHash, input.contentHash),
          gt(sites.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(sites.createdAt))
      .limit(1);

    // `expiresAt` is non-null by the predicate above; the column is nullable
    // because a kept page has no clock.
    if (!existing?.expiresAt) return null;

    await tx
      .update(sites)
      .set({ anonTokenHash: input.anonTokenHash, updatedAt: new Date() })
      .where(eq(sites.id, existing.siteId));

    return { siteId: existing.siteId, slug: existing.slug, expiresAt: existing.expiresAt };
  });
}

export interface AnonymousDraftInput {
  /** Pre-generated so the R2 key is known before the row exists. */
  siteId: string;
  versionId: string;
  r2Key: string;
  contentHash: string;
  sizeBytes: number;
  anonTokenHash: string;
  publisherHash: string;
  expiresAt: Date;
  purgeAfter: Date;
  reminderEmail?: string;
}

/**
 * Insert the `sites` + `site_versions` pair for a new anonymous draft and
 * return the slug that was actually taken.
 *
 * `status: "live"` and `expires_at` set — DRAFTS ARE `live`. There is no
 * `draft` status and there must never be one: a draft and a kept page travel
 * the identical serving path, and the only difference between them is whether
 * the clock column is set. The manifest carries no draft flag, and E03's Worker
 * knows nothing about expiry.
 *
 * The ids are supplied by the caller rather than defaulted by Postgres so the
 * R2 object key (`sites/{siteId}/{versionId}/index.html`) is known before the
 * transaction opens; nothing is committed until both rows are in, so a retried
 * attempt reuses them safely.
 */
export async function insertAnonymousDraft(
  input: AnonymousDraftInput,
): Promise<{ slug: string }> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = mintSlugCandidate();
    try {
      await db.transaction(async (tx) => {
        // `sites` first: `site_versions.site_id` has an FK onto it.
        // `current_version_id` has no DB-level FK (it would be circular), so it
        // can point at the version row before that row is written.
        await tx.insert(sites).values({
          id: input.siteId,
          slug,
          status: "live",
          region: "auto",
          currentVersionId: input.versionId,
          ownerId: null,
          anonTokenHash: input.anonTokenHash,
          publisherHash: input.publisherHash,
          expiresAt: input.expiresAt,
          purgeAfter: input.purgeAfter,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          reminderEmail: input.reminderEmail ?? null,
        });
        await tx.insert(siteVersions).values({
          id: input.versionId,
          siteId: input.siteId,
          region: "auto",
          r2Key: input.r2Key,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
        });
      });
      return { slug };
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
    }
  }
  throw new SlugUnavailableError();
}

/**
 * The row half of the publish unwind. `site_versions.site_id` cascades, so one
 * delete removes both rows.
 *
 * Called only after the store side has been unwound, because the ordering of
 * the reverse path matters as much as the forward one: while a pointer or a KV
 * manifest still names this site, the row is the only thing that can explain
 * what they point at.
 */
export async function deleteSiteCascade(siteId: string): Promise<void> {
  await db.delete(sites).where(eq(sites.id, siteId));
}
