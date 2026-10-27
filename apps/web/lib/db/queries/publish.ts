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
import type { ModerationReason, PublishChannel, Region, SiteStatus } from "@kept/shared";
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { isNameAvailable } from "../../names/availability";
import type { StoredProvenance } from "../../publish/provenance";
import { mintSlugCandidate } from "../../publish/slug";
import { db, type Tx } from "../index";
import { sites, siteVersions } from "../schema";
import { insertVersionFiles, type VersionFileEntry } from "./version-files";
import { deleteVersionRow, findSiteVersion, stampActivated } from "./versions";

/**
 * Slug attempts before giving up. The keyspace is 32^8 ≈ 1.1e12, so at a
 * million published pages one attempt collides with probability ~1e-6 and eight
 * independent attempts with ~1e-48: exhausting this bound means the unique index
 * or the CSPRNG is broken, not that the namespace is full. Bounded and loudly
 * fatal rather than an unbounded loop, because an unbounded retry against a
 * broken index is an outage that looks like a hang. `withMintedSlug` is the one
 * loop that reads it, for both mint paths.
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
 *
 * ⚠️ EXPORTED FOR E06's RENAME (`lib/names/rename.ts`). It asks the namespace
 * under a per-name lock, which closes the race between renames, but a minted
 * page takes no name lock — so the rename's UPDATE still reads the constraint
 * name off a failure and answers `name_taken`. A second copy of this predicate
 * is a second answer to "was that a collision or a real error", and the wrong
 * answer is a 500 shown to somebody whose only mistake was picking a taken name.
 */
export function isSlugCollision(err: unknown): boolean {
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
 * expires_at > now() AND status = 'live'` — and is scoped per publisher on
 * purpose. Byte-identical HTML from two different publishers produces two pages
 * with two tokens: nobody is ever handed a stranger's page, or delete rights
 * over it, because their bytes happened to match. A global-by-hash variant is
 * not a fallback, it is a different and wrong feature. `expires_at > now()` also
 * excludes kept pages for free, since keeping (E05) nulls the clock.
 *
 * ⚠️ `status = 'live'` IS LOAD-BEARING, and was missing until task 006's delete
 * gave this table a row that matches everything else. A dedup hit is answered
 * with `deduped: true` and the EXISTING `live_url`, so it may only ever return a
 * page that actually serves — and `live` is the only status that does: the
 * Worker's status switch answers `under_review`, `quarantined`, `expired` and
 * `removed` with a system page, and `archived` is never in KV at all (E03;
 * `MANIFEST_STATUSES`). `archiveSite` deliberately leaves `expires_at` and
 * `anon_token_hash` intact for E05's late recovery and E07's grace sweep, so
 * without this clause a publish → delete → identical re-publish matched the
 * archived row and handed the caller a 404ing link plus a success body, writing
 * no manifest. Deduping onto a dead page is worse than minting a new one.
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
          // Typed by the `site_status` pgEnum, which is generated from
          // `SITE_STATUSES` — a value that is not in the shared enum does not
          // compile. Same literal, same reason, as the insert below.
          eq(sites.status, "live"),
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

/**
 * The statuses in which an owned page still counts as "already published" for
 * the studio's dedup (PRD §5.1, AC8): the ones a page can hold while it is
 * still the owner's page on the internet, including E07's two flags. `expired`
 * is not here, and neither is a `live` draft whose clock has run out but which
 * the expiry sweep has not reached yet — both are offline (or about to be), so
 * re-publishing their bytes mints a fresh page instead of pointing at a dead
 * one. `archived` and `removed` are gone.
 */
export const OWNER_DEDUP_STATUSES = [
  "live",
  "under_review",
  "quarantined",
] as const satisfies readonly SiteStatus[];

/**
 * The studio's dedup probe: this OWNER's newest active page with these exact
 * bytes, or `null` — E06 task 005, PRD §5.1, AC8.
 *
 * ⚠️ IT TAKES THE CALLER'S TRANSACTION, WHICH MUST ALREADY HOLD `lockOwner`.
 * That lock is what makes two identical publishes from two tabs converge: the
 * second waits on the first, then probes a snapshot that includes the first's
 * row. A probe outside the lock is a check-then-insert race that mints two.
 *
 * Scoped by `owner_id`, never global and never by `publisher_hash` — the
 * keyless probe above is per publisher because a stranger must never be handed
 * somebody else's page; here the account IS the authority, so the same bytes
 * from a second device are still this account's one page.
 *
 * Returns the id only; the caller reads the row it answers with through the
 * same transaction.
 */
export async function findOwnedDuplicate(
  tx: Tx,
  ownerId: string,
  contentHash: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.ownerId, ownerId),
        eq(sites.contentHash, contentHash),
        inArray(sites.status, OWNER_DEDUP_STATUSES),
        or(isNull(sites.expiresAt), gt(sites.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(desc(sites.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A version's rows, as every write path inserts them (E08 D1): the
 * `site_versions` row and one `site_version_files` row per stored file.
 *
 * `r2Key` is the set's `index.html` key — what preview, title and restore read;
 * every reader that ENUMERATES the version reads `files` back instead.
 * `sizeBytes` is the set total, and `file_count` is `files.length`.
 */
export interface PendingVersionInput {
  siteId: string;
  versionId: string;
  r2Key: string;
  /** The set hash (D10) — `hashContent(html)` for a single-HTML page. */
  contentHash: string;
  sizeBytes: number;
  /** The door these bytes came through (§5.9). REQUIRED: the column's default is a guess. */
  publishedVia: PublishChannel;
  /** The `X-Kept-Client` label (E09 D9, `parseKeptClient`); absent or `null` = none sent. */
  client?: string | null;
  spa: boolean;
  has404: boolean;
  files: readonly VersionFileEntry[];
}

/**
 * Insert a version's rows — and nothing else: no site row is pointed at it.
 *
 * A new page calls it inside the transaction that inserts the site (the site is
 * unreachable until its manifest exists). A replace calls it with no `tx`, so it
 * commits on its own BEFORE any byte is uploaded (E08 D11, epic Risk 2): the
 * rows name every key the upload may write, so a failure is nameable, and the
 * site row keeps pointing at the previous version until every file is stored
 * (`activatePendingVersion`). A concurrent `syncManifest` in that window
 * re-publishes the previous version, never a half-uploaded one.
 */
export async function insertPendingVersion(input: PendingVersionInput, tx?: Tx): Promise<void> {
  if (!tx) return db.transaction((own) => insertPendingVersion(input, own));
  await tx.insert(siteVersions).values({
    id: input.versionId,
    siteId: input.siteId,
    region: "auto",
    r2Key: input.r2Key,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    publishedVia: input.publishedVia,
    client: input.client ?? null,
    fileCount: input.files.length,
    spa: input.spa,
    has404: input.has404,
  });
  await insertVersionFiles(tx, input.versionId, input.files);
}

export interface AnonymousDraftInput {
  /** Pre-generated ids, so every R2 key is known before the row exists. */
  version: PendingVersionInput;
  anonTokenHash: string;
  publisherHash: string;
  expiresAt: Date;
  purgeAfter: Date;
  reminderEmail?: string;
  /**
   * The page's own `<title>`, from `lib/publish/page-title.ts`. `null` when the
   * document has no readable one — every consumer renders `title ?? slug`, so
   * that is a name, not a failure. REQUIRED rather than optional so a new write
   * path cannot forget it and quietly ship a wall of slugs.
   */
  title: string | null;
  /** E09 D10 — `cleanProvenance`'s output; `{}` when the request sent none. */
  provenance: StoredProvenance;
}

/**
 * The `sites` columns a request's provenance sets (E09 D10) — only the fields
 * it SENT, so a replace that omits one leaves it alone (absent ≠ clear).
 *
 * `title` is stored as the OWNER's (Q7): it outranks the extracted `<title>`
 * exactly as a studio rename does, and no later replace's HTML overwrites it.
 *
 * `remix_of` arrives as a slug and is resolved HERE, in the same statement
 * (Q8, E10 D7): the id of the page that has that slug only while it is kept
 * (`expires_at is null`) and `live`, never the page itself — anything else
 * stores NULL, silently.
 */
export function provenanceColumns(
  siteId: string,
  provenance: StoredProvenance,
): { [K in keyof typeof sites.$inferInsert]?: (typeof sites.$inferInsert)[K] | SQL } {
  const { title, model, tool, prompt, readme, sourceUrl, remixOf } = provenance;
  return {
    ...(title !== undefined && { title, titleSource: "owner" as const }),
    ...(model !== undefined && { model }),
    ...(tool !== undefined && { tool }),
    ...(prompt !== undefined && { prompt }),
    ...(readme !== undefined && { readme }),
    ...(sourceUrl !== undefined && { sourceUrl }),
    ...(remixOf !== undefined && {
      remixOf: sql`(select ${sites.id} from ${sites} where ${sites.slug} = ${remixOf} and ${sites.expiresAt} is null and ${sites.status} = 'live' and ${sites.id} <> ${siteId} limit 1)`,
    }),
  };
}

/**
 * THE generate-and-retry loop — both mint paths run it: the anonymous draft
 * below and the owned publish (`lib/sites/publish.ts`), whose `attempt` re-opens
 * its transaction and so re-takes the owner lock on every retry.
 *
 * Each candidate is first asked of the ONE namespace check (D5, AC23): a name
 * an active page has, or one held for somebody, is skipped before any insert, so
 * the mint can never hand out a held name. That read is advisory for active
 * names — `sites_slug_key` stays the final arbiter, and a unique violation on it
 * (`isSlugCollision`) is retried with a fresh candidate. Any other error is not
 * a collision and is rethrown.
 *
 * `candidates` is the generator, `mintSlugCandidate` in production; the AC23
 * drill passes a source that emits a held and an active name first.
 *
 * @throws {SlugUnavailableError} `MAX_SLUG_ATTEMPTS` candidates were all refused
 */
export async function withMintedSlug<T>(
  attempt: (slug: string) => Promise<T>,
  candidates: () => string = mintSlugCandidate,
): Promise<T> {
  for (let tries = 0; tries < MAX_SLUG_ATTEMPTS; tries++) {
    const slug = candidates();
    if ((await isNameAvailable(slug, null)) !== "available") continue;
    try {
      return await attempt(slug);
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
    }
  }
  throw new SlugUnavailableError();
}

/**
 * Insert the `sites` row and its first version's rows for a new anonymous draft and
 * return the slug that was actually taken.
 *
 * `status: "live"` and `expires_at` set — DRAFTS ARE `live`. There is no
 * `draft` status and there must never be one: a draft and a kept page travel
 * the identical serving path, and the only difference between them is whether
 * the clock column is set. The manifest carries no draft flag, and E03's Worker
 * knows nothing about expiry.
 *
 * The ids are supplied by the caller rather than defaulted by Postgres so the
 * R2 keys (`sites/{siteId}/{versionId}/{path}`) are known before the
 * transaction opens; nothing is committed until every row is in, so a retried
 * attempt reuses them safely.
 */
export async function insertAnonymousDraft(
  input: AnonymousDraftInput,
): Promise<{ slug: string }> {
  const { version } = input;
  return withMintedSlug(async (slug) => {
    await db.transaction(async (tx) => {
      // `sites` first: `site_versions.site_id` has an FK onto it.
      // `current_version_id` has no DB-level FK (it would be circular), so it
      // can point at the version row before that row is written.
      await tx.insert(sites).values({
        id: version.siteId,
        slug,
        status: "live",
        region: "auto",
        currentVersionId: version.versionId,
        ownerId: null,
        anonTokenHash: input.anonTokenHash,
        publisherHash: input.publisherHash,
        expiresAt: input.expiresAt,
        purgeAfter: input.purgeAfter,
        title: input.title,
        contentHash: version.contentHash,
        sizeBytes: version.sizeBytes,
        reminderEmail: input.reminderEmail ?? null,
        ...provenanceColumns(version.siteId, input.provenance),
      });
      await insertPendingVersion(version, tx);
    });
    return { slug };
  });
}

export interface OwnedPageInput {
  /** Pre-generated ids, so every R2 key is known before the row exists. */
  version: PendingVersionInput;
  /** Minted by `withMintedSlug`, which owns the collision handling. */
  slug: string;
  ownerId: string;
  publisherHash: string;
  title: string | null;
  /**
   * The draft clock, or its absence. **Both null ⇒ kept** (permanent, no
   * countdown); **both set ⇒ an owned draft** at the cap. Never one of the two:
   * a row with `expires_at` and no `purge_after` expires into a grace window
   * that has no end, and E07's purge sweep orders on the column that is missing.
   */
  expiresAt: Date | null;
  purgeAfter: Date | null;
  /** When the page became this account's. On this path, its creation. */
  claimedAt: Date;
  /** E09 D10 — `cleanProvenance`'s output; `{}` when the request sent none. */
  provenance: StoredProvenance;
}

/**
 * Insert the `sites` row and its first version's rows for a page that is OWNED from its
 * first byte — E06 task 004, epic decision D1.
 *
 * ⚠️ IT TAKES THE CALLER'S TRANSACTION, AND THAT IS THE WHOLE POINT. The cap
 * decision (`lockOwner` → count → kept-or-draft) and this insert must commit
 * together, or two concurrent publishes one slot short of the limit both read
 * the same count and both land kept.
 * `insertAnonymousDraft` above opens its own transaction because an anonymous
 * publish has no cap to decide; this one must not, and there is deliberately no
 * `db.transaction` in this function to make that impossible to forget.
 *
 * ⚠️ NO `anon_token_hash`. NOT "not yet", NOT "null for now" — never. A page
 * that already belongs to an account must not also carry a bearer credential:
 * two authorities on one page is the bug E05 was explicit about, and it is why
 * `keepSite` clears the column the moment an account takes an anonymous draft.
 * The column is written here as an explicit `null` rather than omitted, so that
 * a reader of this insert can see the decision instead of inferring it.
 *
 * `publisher_hash` IS still recorded. An owned publish is still a publish, and
 * E07's volume governors key on that column (`sites_publisher_created_idx`).
 * Dropping it because the caller is signed in would make the one class of
 * publisher that *has* a name invisible to the machinery that counts them.
 */
export async function insertOwnedPage(tx: Tx, input: OwnedPageInput): Promise<void> {
  const { version } = input;
  // `sites` first: `site_versions.site_id` has an FK onto it.
  await tx.insert(sites).values({
    id: version.siteId,
    slug: input.slug,
    // DRAFTS ARE `live`, exactly as on the anonymous path — the difference
    // between a draft and a kept page is the clock column and nothing else.
    status: "live",
    region: "auto",
    currentVersionId: version.versionId,
    ownerId: input.ownerId,
    anonTokenHash: null,
    publisherHash: input.publisherHash,
    expiresAt: input.expiresAt,
    purgeAfter: input.purgeAfter,
    claimedAt: input.claimedAt,
    title: input.title,
    contentHash: version.contentHash,
    sizeBytes: version.sizeBytes,
    ...provenanceColumns(version.siteId, input.provenance),
  });
  await insertPendingVersion(version, tx);
}

/**
 * What a manage path resolves a page to. The bearer token itself is never part
 * of this.
 *
 * ⚠️ THE NAME RECORDS WHERE IT STARTED, NOT WHO MAY READ IT. E06's owner-scoped
 * replace resolves a page by `(id, owner_id)` instead of by token hash and needs
 * exactly these columns for exactly the same reasons — see `findSiteForOwner`
 * below, which returns this shape. A second, identical interface named
 * `OwnedSite` would be the duplication that drifts the first time one of them
 * grows a column, and the *authority* difference lives in the two queries'
 * WHERE clauses where it is enforceable, not in a type where it is decorative.
 *
 * Carries the current content state as well as the identity, because the
 * replace path needs exactly these three values to put the row back if a store
 * write fails — one read instead of two, and no window in which they change
 * between them.
 *
 * `purgeAfter` and `region` are E05 task 008's, and both are load-bearing on
 * exactly one path — the late keep of an `expired` draft. Without `purgeAfter`,
 * "expired but still inside the 30-day grace" (keepable) is indistinguishable
 * from "expired past grace" (a 404 like any other), and the difference decides
 * whether somebody gets their page back. Without `region` the KV manifest that
 * restore has to rewrite cannot be built from the row at all — it is a required
 * field of `kvManifestSchema` — and hardcoding `"auto"` would silently move an
 * EU page's manifest to the wrong bucket the moment E11 lands. This is a
 * WIDENING of the one resolver, deliberately, rather than a second read.
 */
export interface AnonSite {
  id: string;
  slug: string;
  status: SiteStatus;
  region: Region;
  ownerId: string | null;
  currentVersionId: string | null;
  expiresAt: Date | null;
  /** End of the post-expiry grace window; null on a kept page. */
  purgeAfter: Date | null;
  /**
   * The page's `<title>` as of the CURRENT bytes. Carried for the same reason
   * `contentHash` and `sizeBytes` are: a failed replace has to put the row back
   * exactly as it found it, and a row describing bytes it no longer points at
   * is the bug this column was added to avoid.
   */
  title: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
  /** The current version's file count (E08) — a preview needs exactly one. `null` with no version. */
  fileCount: number | null;
  /** Why E07 restricted the page; `null` unless it is. Read for D13's byte rule. */
  moderationReason: ModerationReason | null;
}

/**
 * The columns both resolvers below project. One object so the token-scoped and
 * owner-scoped reads cannot drift in shape, which is what would make `AnonSite`
 * a lie on one of the two paths — the same rule `dashboard.ts` states about
 * `OWNED_SITE_COLUMNS`.
 */
const MANAGED_SITE_COLUMNS = {
  id: sites.id,
  slug: sites.slug,
  status: sites.status,
  region: sites.region,
  ownerId: sites.ownerId,
  currentVersionId: sites.currentVersionId,
  expiresAt: sites.expiresAt,
  purgeAfter: sites.purgeAfter,
  title: sites.title,
  contentHash: sites.contentHash,
  sizeBytes: sites.sizeBytes,
  // A scalar subquery, not a join: `lockSiteForOwner` reads these columns
  // `FOR UPDATE`, which Postgres refuses on the nullable side of an outer join.
  fileCount: sql<number | null>`(select ${siteVersions.fileCount} from ${siteVersions} where ${siteVersions.id} = ${sites.currentVersionId})`,
  moderationReason: sites.moderationReason,
} as const;

/**
 * THE ONLY QUERY IN THE REPO THAT READS `sites.anon_token_hash`.
 *
 * A single exact match on the digest — there is no `anon_token` column to
 * compare against, so there is no constant-time comparison to write and none
 * must be added. Equality against a SHA-256 of a 32-byte CSPRNG token leaks
 * nothing usable: a timing side channel on a hash comparison only tells an
 * attacker how many leading bytes of a DIGEST they matched, and inverting that
 * into a token means inverting SHA-256.
 *
 * Takes the HASH, never the raw token — the raw token exists only in the URL and
 * must not travel down into the query layer (see `lib/publish/anon-token.ts`).
 */
export async function findSiteByAnonTokenHash(
  anonTokenHash: string,
): Promise<AnonSite | null> {
  const [site] = await db
    .select(MANAGED_SITE_COLUMNS)
    .from(sites)
    .where(eq(sites.anonTokenHash, anonTokenHash))
    .limit(1);

  return site ?? null;
}

/**
 * The same page, resolved by OWNER instead of by bearer token — E06 task 006's
 * replace and delete.
 *
 * ⚠️ THE OWNER SCOPE IS IN THE SQL, NEVER APPLIED AFTERWARDS IN JS. A read that
 * fetched by id and then compared `row.ownerId` in the caller is a cross-account
 * read that happens to be discarded — one forgotten early return away from being
 * written to. `owner_id` is in the WHERE clause, so a page belonging to somebody
 * else is indistinguishable here from a page that never existed: both are
 * `null`, and both become the single `ownerNotFound()` body one layer up.
 *
 * ⚠️ IT DOES NOT FILTER ON STATUS. Replace and delete have to be able to tell an
 * owner *why* their flagged page cannot be changed (E07 decision 2: a flagged
 * page is never deletable either). A resolver that hid non-`live` rows would
 * answer both with a 404 that reads as data loss. The status decision belongs
 * to `lib/sites/manage.ts`.
 */
export async function findSiteForOwner(
  siteId: string,
  ownerId: string,
): Promise<AnonSite | null> {
  const [site] = await db
    .select(MANAGED_SITE_COLUMNS)
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.ownerId, ownerId)))
    .limit(1);

  return site ?? null;
}

/**
 * `findSiteForOwner`, with the row locked `FOR UPDATE` until `tx` ends — for a
 * restore (E06 task 007), which decides on `current_version_id` and must not
 * race a prune deleting the version it is about to point at. Same columns, same
 * owner scope in the SQL, same `null` for "not yours" and "does not exist".
 */
export async function lockSiteForOwner(
  tx: Tx,
  siteId: string,
  ownerId: string,
): Promise<AnonSite | null> {
  const [site] = await tx
    .select(MANAGED_SITE_COLUMNS)
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.ownerId, ownerId)))
    .for("update");

  return site ?? null;
}

/**
 * `sites.title` for a write that carries new bytes (D11): the HTML's title,
 * unless the owner set one (`title_source = 'owner'`), which no replace may
 * overwrite. Decided IN the UPDATE, against the row as it is at that instant,
 * so an owner's title edit racing a replace can never be lost to a value read
 * a moment earlier.
 */
function htmlTitle(title: string | null): SQL {
  return sql`case when ${sites.titleSource} = 'owner' then ${sites.title} else ${title} end`;
}

/**
 * What a site row says about the bytes it serves: the version, and the three
 * columns denormalised from it. They move together or the row describes bytes
 * it no longer points at — the dedup probe and the replace no-op read
 * `content_hash` off the row, never off `site_versions`.
 */
export interface SitePointer {
  versionId: string | null;
  /** The served bytes' `<title>`; an owner title is kept regardless (`htmlTitle`). */
  title: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
}

/**
 * Point a site at a version — THE one statement every version move runs:
 * replace, its unwind, restore and restore's unwind. Returns the title the row
 * ENDED UP with (the owner's, when they set one).
 */
export async function pointSiteAt(
  tx: Tx,
  siteId: string,
  target: SitePointer,
): Promise<{ title: string | null }> {
  const [row] = await tx
    .update(sites)
    .set({
      currentVersionId: target.versionId,
      title: htmlTitle(target.title),
      contentHash: target.contentHash,
      sizeBytes: target.sizeBytes,
      updatedAt: new Date(),
    })
    .where(eq(sites.id, siteId))
    .returning({ title: sites.title });
  return { title: row?.title ?? null };
}

/**
 * Step (c) of a replace (E08 D11): point the site at a version whose rows
 * `insertPendingVersion` committed and whose files are ALL stored — in its own
 * transaction, stamped `activated_at = now()` (the upload took a while; "newest"
 * means "most recently live", which is what the Versions list and pruning sort
 * on). Returns the title the row ended up with (the owner's, when they set one).
 *
 * ⚠️ `expires_at` AND `purge_after` ARE DELIBERATELY UNTOUCHED. The draft clock
 * belongs to the page, not to its bytes: if re-dropping a file restarted the
 * seven days, anyone could hold a page forever for free by replacing it once a
 * week, and "keep it" would stop meaning anything. This looks like an omission
 * later — it is not. The same reasoning is why the slug and `siteId` are stable
 * across a replace: it is the same page with new contents.
 *
 * The replace's provenance (E09 D10) lands in the same transaction — only the
 * fields the request sent (`provenanceColumns`); a provenance `title` is the
 * owner's and is what the row ends up with. A replace unwound after this
 * commits (`revertReplacementVersion`) puts the pointer back, not provenance:
 * it is self-reported metadata about the page, not about the bytes served.
 *
 * Throws, rolling back, when the version row is gone: a prune that ran while the
 * files were uploading (it takes the same site-row lock this UPDATE waits on)
 * may have dropped it, and a pointer at a version with no rows is unservable.
 */
export async function activatePendingVersion(
  siteId: string,
  target: SitePointer & { versionId: string },
  provenance: StoredProvenance = {},
): Promise<{ title: string | null }> {
  return db.transaction(async (tx) => {
    let pointed = await pointSiteAt(tx, siteId, target);
    if (!(await findSiteVersion(tx, siteId, target.versionId))) {
      throw new Error(`version ${target.versionId} of site ${siteId} was pruned before it could be served`);
    }
    await stampActivated(tx, siteId, target.versionId, "now");
    const columns = provenanceColumns(siteId, provenance);
    if (Object.keys(columns).length > 0) {
      const [row] = await tx
        .update(sites)
        .set(columns)
        .where(eq(sites.id, siteId))
        .returning({ title: sites.title });
      pointed = { title: row?.title ?? null };
    }
    return pointed;
  });
}

/**
 * The row half of a replace whose upload failed (E08 D11): drop the version
 * that was never pointed at (`site_version_files` cascades). The pointer never
 * moved, so there is nothing to revert.
 */
export async function deletePendingVersion(siteId: string, versionId: string): Promise<void> {
  await db.transaction((tx) => deleteVersionRow(tx, siteId, versionId));
}

/**
 * The row half of a replace whose manifest sync failed AFTER the pointer moved
 * (`activatePendingVersion`): put the site row back where it was and drop the
 * new version. Called only after the stores have been rewound.
 */
export async function revertReplacementVersion(input: {
  siteId: string;
  versionId: string;
  previous: SitePointer;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Guarded like the forward write: an owner title set in between stays.
    await pointSiteAt(tx, input.siteId, input.previous);
    await tx.delete(siteVersions).where(eq(siteVersions.id, input.versionId));
  });
}

/**
 * The statuses a delete may move to `archived` — owner and anonymous alike
 * (Arun 2026-10-15, decision 2). Everything else is refused: `archived` is
 * already there, `removed` is a takedown, and `under_review` / `quarantined`
 * are flags a delete would launder.
 */
export const DELETABLE_STATUSES = ["live", "expired"] as const satisfies readonly SiteStatus[];

/**
 * The anonymous delete, in Postgres: ARCHIVE, NEVER DESTROY.
 *
 * The row, its versions and the R2 objects all stay; only the status moves, and
 * `purge_after` — set at publish — is what E07's purge sweeps to do the hard
 * delete. Keeping the row is also what makes a second delete with the same
 * token return success instead of a 404: the token still resolves, it just
 * resolves to a page that is already archived.
 *
 * THE STATUS RE-CHECK IS THE `WHERE` (AC42). One `UPDATE` takes the row lock and
 * Postgres re-evaluates the predicate against the row as it stands once the
 * lock is granted, so a flag that committed after the caller's read leaves the
 * row alone. Returns whether the row moved; `false` is the caller's to explain.
 *
 * `anon_token_hash` is deliberately NOT cleared, for that idempotency and for
 * E07/E05's late-recovery path.
 */
export async function archiveSite(siteId: string): Promise<boolean> {
  const moved = await db
    .update(sites)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(sites.id, siteId), inArray(sites.status, [...DELETABLE_STATUSES])))
    .returning({ id: sites.id });
  return moved.length > 0;
}

/**
 * Store (or clear) the pre-expiry reminder address. E04 only persists it; E05
 * owns the cron that sends it.
 */
export async function setReminderEmail(
  siteId: string,
  email: string | null,
): Promise<void> {
  await db
    .update(sites)
    .set({ reminderEmail: email, updatedAt: new Date() })
    .where(eq(sites.id, siteId));
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
