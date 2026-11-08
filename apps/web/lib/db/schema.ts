/**
 * Drizzle schema — core cross-epic tables (task 006).
 *
 * The Drizzle schema is the single source of truth for table shape; pgEnums are
 * driven directly from the `@kept/shared` enum value tuples so DB types can never
 * drift from the app/zod types. Columns/types mirror the shared zod schemas
 * (`siteSchema`, `profileSchema`) and `PublishPayload`.
 *
 * Core tables: `profiles`, `sites`, `site_versions`, plus Better Auth's four
 * tables (E05), plus the creator studio's `name_holds`, `name_events`,
 * `page_views_daily` and `job_runs` (E06, migration 0005), plus the launch
 * `waitlist` (migration 0006), plus E07's moderation tables — `scans`,
 * `abuse_reports`, `moderation_actions`, `appeals`, `pending_purges` — and
 * `sites.moderation_reason` (migration 0008), plus E09's `api_keys`,
 * `agent_codes`, `site_versions.client` and the `sites` provenance columns
 * (migration 0011), plus E10's `referrals`, `handle_redirects`, the profile
 * fields and the `sites` display switches (migration 0012).
 */
import {
  APPEAL_STATUSES,
  BADGE_STYLES,
  FOUNDING_NOTE_MAX,
  FOUNDING_STATUSES,
  MODERATION_ACTIONS,
  MODERATION_ACTORS,
  MODERATION_REASONS,
  NAME_HOLD_REASONS,
  NAME_KINDS,
  PLANS,
  PROFILE_BIO_MAX,
  PROVENANCE_LIMITS,
  PUBLISH_CHANNELS,
  REFERRAL_CODE_LENGTH,
  REGIONS,
  REPORT_STATUSES,
  SCAN_STATUSES,
  SCAN_TRIGGERS,
  SCAN_VERDICTS,
  SITE_STATUSES,
  TITLE_SOURCES,
  WAITLIST_SOURCES,
  type Socials,
} from "@kept/shared";
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Enums (driven from @kept/shared so values never drift) ───────────────────
export const siteStatusEnum = pgEnum("site_status", SITE_STATUSES);
export const planEnum = pgEnum("plan", PLANS);
export const regionEnum = pgEnum("region", REGIONS);
export const nameKindEnum = pgEnum("name_kind", NAME_KINDS);
export const publishChannelEnum = pgEnum("publish_channel", PUBLISH_CHANNELS);
export const nameHoldReasonEnum = pgEnum("name_hold_reason", NAME_HOLD_REASONS);
export const moderationReasonEnum = pgEnum("moderation_reason", MODERATION_REASONS);

/**
 * The body of a text `CHECK (column in (…))` — the house pattern for a value
 * set that is not a pgEnum. The values are `@kept/shared` literals, never input.
 */
function inValues(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/** `char_length(column) <= max` — a CHECK whose bound is a `@kept/shared` number. */
function maxLength(column: AnyPgColumn, max: number) {
  return sql`char_length(${column}) <= ${sql.raw(String(max))}`;
}

// ── Better Auth (E05) ────────────────────────────────────────────────────────
// Self-hosted Better Auth v1.6.x through the Drizzle adapter, in this same Neon
// database — there is no external identity store. These four tables were emitted
// by `@better-auth/cli generate` and then folded into this file's conventions
// (timestamptz, snake_case index names) with ONE substantive edit, below.
//
// ⚠️⚠️ UUID IDS ARE A DELIBERATE NON-DEFAULT CONFIGURATION. READ BEFORE ADDING
// ANY BETTER AUTH TABLE. ⚠️⚠️
//
// Better Auth mints TEXT ids out of the box, and its CLI generates `text("id")`
// columns to match. We override both halves:
//   1. HERE — every Better Auth id and every FK onto one is `uuid`.
//   2. In `lib/auth/index.ts` — `advanced.database.generateId` mints uuids, so
//      the values the adapter inserts fit these columns.
// Remove either half and every insert fails on the uuid column. (That failure is
// the correct one: it is loud, immediate, and cannot corrupt data.)
//
// WHY: `profiles.id` IS the auth user id — same value, with the FK below to
// prove it — and `sites.owner_id` is a `uuid` FK onto `profiles.id` that already
// carries rows. Text ids would have meant either rewriting `sites.owner_id` or
// carrying a second, competing user identifier and a join on every
// session→profile resolution. (Epic E05, decision D1.)
//
// THE STANDING RULE THIS IMPOSES ON FUTURE WORK: **every Better Auth table added
// from here on — in any epic, including tables a plugin brings (`organization`,
// `apikey`, `twoFactor`, …) — must use a `uuid` id and `uuid` FKs.** The CLI will
// not do this for you; its output must be re-typed before `drizzle-kit generate`
// runs. A plugin table that lands with a `text("user_id")` breaks the FK graph.
export const user = pgTable("user", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

// One row per linked identity: `(userId, providerId, accountId)`. THIS is where
// provider identities live — see the note on `profiles.handle` below.
export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

// Backs both email verification and the magic-link plugin's one-time tokens.
export const verification = pgTable(
  "verification",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ── profiles ─────────────────────────────────────────────────────────────────
// A user profile. `id` is not merely *derived from* the auth user id — it IS the
// auth user id, enforced by the FK below. There is deliberately no
// `.defaultRandom()`: a randomly generated id could never satisfy that FK, so
// every insert supplies the Better Auth user id explicitly.
//
// ⚠️ NO PROVIDER-SPECIFIC COLUMN, EVER. No `github_handle`, no `google_handle`,
// no `provider`. Linked identities live in Better Auth's `account` table as
// `(userId, providerId, accountId)` — that is the only place they stay correct
// across a link and an unlink. A copy here would need backfilling on every link
// and would silently rot the moment a user unlinks a provider. "Which providers
// is this user linked to?" queries `account`.
//
// `handle` (E10 D9, migration 0012) is a NAME in the one namespace page names
// live in — `{handle}.kept.host` — chosen by the user and validated like a page
// name. It is not a display handle and is never seeded: `0012` nulled every
// value, and a new sign-up starts with `null`. Unique where set. The display
// name is Better Auth's `user.name`.
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    handle: text("handle"),
    email: text("email"),
    plan: planEnum("plan").notNull().default("free"),
    // When the handle last changed; it may change once per `HANDLE_CHANGE_DAYS`
    // (D10). NULL until the first change.
    handleChangedAt: timestamp("handle_changed_at", { withTimezone: true }),
    // D12. Capped by a CHECK at `PROFILE_BIO_MAX`. ⚠️ UNTRUSTED USER INPUT.
    bio: text("bio"),
    // D12: `Socials` from `@kept/shared`, validated by `socialsSchema` on write.
    socials: jsonb("socials").$type<Socials>(),
    // The badge on this account's kept pages (D3); `minimal` is a Pro choice,
    // gated in `lib/plans/`, not here.
    badgeStyle: text("badge_style", { enum: BADGE_STYLES })
      .notNull()
      .default("standard"),
    // Q3: a permanent random code, never rewritten — a handle change cannot
    // orphan a shared link. Minted by the database on every insert (so no
    // writer can forget it, and `0012`'s ADD COLUMN filled existing rows):
    // `REFERRAL_CODE_LENGTH` hex characters of a v4 uuid. Not a secret — it is
    // shared in links. `ensureProfile` redraws on the unique violation.
    referralCode: text("referral_code")
      .notNull()
      .unique()
      .default(
        sql`left(md5(gen_random_uuid()::text), ${sql.raw(String(REFERRAL_CODE_LENGTH))})`,
      ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("profiles_handle_key")
      .on(table.handle)
      .where(sql`${table.handle} is not null`),
    check("profiles_bio_length_check", maxLength(table.bio, PROFILE_BIO_MAX)),
    check(
      "profiles_badge_style_check",
      sql`${table.badgeStyle} in (${inValues(BADGE_STYLES)})`,
    ),
  ],
);

// ── sites ────────────────────────────────────────────────────────────────────
// A hosted page. `region` defaults to 'auto' so EU residency (E11) needs no
// migration. `ownerId` is null while a page is anonymous/unclaimed.
// `currentVersionId` points at the live row in `site_versions`.
//
// ⚠️ DRAFT IS DERIVED, NOT A STATUS. `isDraft = expiresAt != null`. A draft and
// a kept page are both `status: 'live'` and travel the identical serving path;
// the only difference is whether the clock column is set. There is no `draft`
// value in `site_status` and no `is_draft` column — do not add either. Keeping a
// page (E05) clears `expiresAt`/`purgeAfter`; demoting sets a fresh clock.
export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    status: siteStatusEnum("status").notNull().default("live"),
    region: regionEnum("region").notNull().default("auto"),
    currentVersionId: uuid("current_version_id"),
    ownerId: uuid("owner_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    // SHA-256 (hex) of the anonymous bearer token — NEVER the token itself. The
    // raw token exists only in the claim/manage URL handed to the publisher: it
    // is never persisted, never logged, never echoed into an error body, and is
    // unrecoverable from this database by design. Lookup is an exact equality
    // against this digest, so no constant-time comparison is required or wanted.
    // Nullable because rows created by a signed-in user (E05/E06) have no
    // anonymous token; Postgres permits many NULLs under a unique index.
    anonTokenHash: text("anon_token_hash"),
    // Salted SHA-256 (hex) of client IP + user-agent — never the raw IP, which
    // is used to compute the digest and then discarded. Scopes the dedup probe
    // and E07's rate limiter to a single publisher. Nullable for the same reason
    // as `anonTokenHash`. Salt: PUBLISHER_HASH_SALT (server-only env var).
    publisherHash: text("publisher_hash"),
    // The draft clock. Set → draft (7 days, DRAFT_TTL_DAYS); null → kept.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // End of the post-expiry grace window (DRAFT_GRACE_DAYS), after which E07
    // hard-deletes. E04 sets both clocks and indexes them; it enforces neither.
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    // When an account FIRST took this page (E05's keep). It is a historical
    // stamp, not a state flag: it is set on keep and deliberately LEFT SET
    // through a later demote, because it records when the page stopped being
    // anonymous — not whether it is kept right now. `kept ⇔ owner_id != null
    // AND expires_at IS NULL` remains the only definition of kept-ness; never
    // read this column to answer that question.
    //
    // The name is the one piece of pre-pivot `claim` vocabulary E05 retains,
    // because the PRD's data model specifies it. Do not spread `claim` into any
    // new identifier — the product word is **keep**.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // The page's own `<title>`, extracted from the HTML on every write path by
    // `lib/publish/page-title.ts` (E06 task 001, migration 0004).
    //
    // ⚠️ NULLABLE ON PURPOSE, AND IT STAYS THAT WAY. Every consumer renders
    // `title ?? slug` — the dashboard wall and the OG card — so a page with no
    // readable `<title>` is a page named by its slug, not a failed publish.
    // `0004` backfills nothing, so rows published before it read NULL forever
    // and that is a correct terminal state. Do NOT add `notNull()`, a default,
    // or an index: nothing queries by title.
    //
    // ⚠️ UNTRUSTED STRANGER-AUTHORED INPUT. It is rendered into a dashboard
    // card and painted into an image. `extractPageTitle` is the only writer:
    // it trims, collapses whitespace, decodes the common entities, caps the
    // length and never throws. Never write this column from anywhere else.
    title: text("title"),
    // Who wrote `title` (D11, migration 0005). `html`: the page's own `<title>`,
    // refreshed by every write path. `owner`: set by the owner, and no write
    // path may overwrite it. A text CHECK, not a pgEnum, as the PRD specifies.
    titleSource: text("title_source", { enum: TITLE_SOURCES })
      .notNull()
      .default("html"),
    // D3: `generated` (minted at publish) or `chosen` (an owner's rename). A
    // chosen name counts against the plan's name quota while the page is not
    // archived/removed, so it keeps counting after a demote. Rows renamed
    // before 0005 backfill as `generated`; there is no history to recover.
    nameKind: nameKindEnum("name_kind").notNull().default("generated"),
    // D12: stored now for the public gallery (E10), and preserved through demote.
    listedPublic: boolean("listed_public").notNull().default(false),
    // Denormalised from the current version so the dedup probe is a single
    // index scan on `sites` and never has to join `site_versions`.
    contentHash: text("content_hash"),
    sizeBytes: integer("size_bytes"),
    // Optional "your draft expires soon" address collected on the result screen.
    reminderEmail: text("reminder_email"),
    // When the single pre-expiry reminder was sent (E05 task 011). NULL means
    // "not yet sent" and is the ONLY thing that makes "one reminder maximum"
    // enforceable — the sweep both selects on it and stamps it, so a replayed
    // or crashed run cannot mail the same publisher twice. It is stamped
    // *before* the send and cleared again if the send fails, so the failure
    // mode is "retried next run", never "sent twice".
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    // SHA-256 (hex) of the one-time keep token carried by the reminder email —
    // NEVER the token itself, exactly like `anonTokenHash` above.
    //
    // ⚠️ WHY A SECOND TOKEN EXISTS AT ALL. The reminder has to contain a link
    // the recipient can act on, and the only handle on an anonymous page is a
    // bearer token. The publisher's original token is unrecoverable from this
    // database by design, so the sweep cannot re-send it; instead it mints a
    // fresh token per reminder and stores only its digest here, in the SAME
    // update that stamps `reminderSentAt`. The raw value exists solely inside
    // the one email. `lib/publish/anon-token.ts` resolves it through the one
    // existing resolver — it is a second credential for the same page, not a
    // second code path — and it is revoked (set NULL) by unsubscribing.
    reminderKeepTokenHash: text("reminder_keep_token_hash"),
    // Why the page is restricted (E07, migration 0008). Written and cleared ONLY
    // by `lib/moderation` (`setStatus`), with the status, in one update; NULL
    // on every page nobody has restricted.
    moderationReason: moderationReasonEnum("moderation_reason"),
    // Provenance (E09, migration 0011): what the publisher says made the page.
    // Optional, self-reported, never verified; each capped by a CHECK at
    // `PROVENANCE_LIMITS`. Two writers: the publish pipelines
    // (`queries/publish.ts`) and the owner's details panel in the studio (E10).
    // ⚠️ UNTRUSTED STRANGER-AUTHORED INPUT, like `title`.
    model: text("model"),
    tool: text("tool"),
    prompt: text("prompt"),
    readme: text("readme"),
    sourceUrl: text("source_url"),
    // The page this one remixes (Q8). A uuid FK, resolved from a slug at
    // publish; it goes NULL when that page is purged — the remix stays.
    remixOf: uuid("remix_of").references((): AnyPgColumn => sites.id, {
      onDelete: "set null",
    }),
    // E10 (migration 0012), set by the owner. `showMadeWith`: the badge names
    // the model/tool (D2). `showPrompt`: the prompt is public on the page and in
    // remix links (D7). `allowRemix`: NULL means the default rule (D8).
    showMadeWith: boolean("show_made_with").notNull().default(true),
    showPrompt: boolean("show_prompt").notNull().default(false),
    allowRemix: boolean("allow_remix"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The OG card's `?v=` cache key (E06 task 010) is built on this, so every
    // write must move it. `$onUpdate` covers every Drizzle `update(sites)` that
    // does not set it; a raw-SQL `UPDATE sites` bypasses it and must set
    // `updated_at` itself.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // D5: one name per ACTIVE page. An archived or removed row releases its
    // slug to the index; `name_holds` then guards the released name.
    //
    // ⚠️ THE NAME `sites_slug_key` IS LOAD-BEARING. `isSlugCollision`
    // (`queries/publish.ts`) matches on it, so renaming this index turns every
    // slug collision into a 500. An `ON CONFLICT (slug)` would also have to
    // repeat this predicate.
    uniqueIndex("sites_slug_key")
      .on(table.slug)
      .where(sql`${table.status} not in ('archived', 'removed')`),
    check("sites_title_source_check", sql`${table.titleSource} in ('html', 'owner')`),
    check("sites_model_length_check", maxLength(table.model, PROVENANCE_LIMITS.model)),
    check("sites_tool_length_check", maxLength(table.tool, PROVENANCE_LIMITS.tool)),
    check("sites_prompt_length_check", maxLength(table.prompt, PROVENANCE_LIMITS.prompt)),
    check("sites_readme_length_check", maxLength(table.readme, PROVENANCE_LIMITS.readme)),
    check(
      "sites_source_url_length_check",
      maxLength(table.sourceUrl, PROVENANCE_LIMITS.source_url),
    ),
    // The bearer-token lookup for /p/[anonToken] and the anonymous
    // replace/delete routes; unique because a token identifies exactly one page.
    uniqueIndex("sites_anon_token_hash_key").on(table.anonTokenHash),
    // E07's expiry sweep: drafts past their clock, per owner.
    index("sites_owner_status_expires_idx").on(
      table.ownerId,
      table.status,
      table.expiresAt,
    ),
    // E07's grace-end purge sweep.
    index("sites_status_purge_after_idx").on(table.status, table.purgeAfter),
    // The dedup probe. NOTE: this SUPERSEDES the two-column
    // `(content_hash, created_at)` index in the E04 PRD's data model — the
    // divergence is deliberate, not an oversight. Dedup is scoped per
    // publisher, so byte-identical HTML from two different publishers mints two
    // separate pages with two separate tokens; nobody is ever handed a
    // stranger's page, or delete rights over it, because their bytes matched.
    index("sites_publisher_content_created_idx").on(
      table.publisherHash,
      table.contentHash,
      table.createdAt,
    ),
    // E07's per-publisher rate limiting / volume governors read this key. It is
    // why `publisher_hash` is not merely a dedup detail.
    index("sites_publisher_created_idx").on(
      table.publisherHash,
      table.createdAt,
    ),
    // The reminder sweep's lookup for the one-time keep token in the email.
    // Unique for the same reason `sites_anon_token_hash_key` is: a token
    // identifies exactly one page. Many NULLs are permitted under it.
    uniqueIndex("sites_reminder_keep_token_hash_key").on(
      table.reminderKeepTokenHash,
    ),
    // E05 task 011's due-draft selection, and the shape E07's sweeps should
    // copy. PARTIAL, not composite: every column in the predicate below is
    // either constant across the candidate set (`owner_id IS NULL`,
    // `status = 'live'`) or purely existential (`reminder_email IS NOT NULL`,
    // `reminder_sent_at IS NULL`), so putting them in the index KEY would only
    // widen every entry with a value the scan already knows. Moving them into
    // the predicate instead leaves a single-column `expires_at` btree over the
    // handful of rows that can ever match — which is also exactly the order the
    // sweep reads in (nearest expiry first), so the cap's LIMIT terminates the
    // scan instead of sorting the whole set.
    index("sites_reminder_due_idx")
      .on(table.expiresAt)
      .where(
        sql`${table.reminderEmail} is not null and ${table.reminderSentAt} is null and ${table.ownerId} is null and ${table.status} = 'live'`,
      ),
    // E07's expiry sweep (migration 0008): every live draft, nearest clock
    // first, owned or not. `sites_owner_status_expires_idx` leads with
    // `owner_id` and cannot serve it. Partial for the reason given above.
    index("sites_live_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'live' and ${table.expiresAt} is not null`),
  ],
);

// ── site_versions ────────────────────────────────────────────────────────────
// An immutable published version of a site → R2 prefix `sites/{siteId}/{id}/`.
// `currentVersionId` on `sites` references one of these (FK wired app-side to
// avoid a circular DB constraint; the pair is kept consistent by the publish
// flow in E04).
export const siteVersions = pgTable(
  "site_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    region: regionEnum("region").notNull().default("auto"),
    // The exact R2 object key this version was written to —
    // `sites/{siteId}/{versionId}/index.html`. Stored rather than recomputed so a
    // rollback/purge never has to re-derive a key from a naming convention that
    // may have changed since the object was written.
    r2Key: text("r2_key").notNull(),
    // SHA-256 (hex) of the version's file set (`hashFileSet`; for a set of one,
    // the `index.html` bytes' own hash, D10), and the SET TOTAL in bytes (E08).
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // When this version last became the live one (D7): set on replace and again
    // on restore. 0005 backfills existing rows to `created_at`.
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The channel that published this version.
    publishedVia: publishChannelEnum("published_via").notNull().default("web"),
    // E08: how many files the set holds (one `site_version_files` row each), and
    // the two manifest flags the Worker reads — D12 SPA rewrite, D13 the set
    // ships its own `404.html`.
    fileCount: integer("file_count").notNull().default(1),
    spa: boolean("spa").notNull().default(false),
    has404: boolean("has_404").notNull().default(false),
    // The agent that published this version (E09), from `X-Kept-Client` or the
    // MCP client name, via `parseKeptClient`. NULL when none was sent or it was
    // malformed — a bad value is dropped, never refused.
    client: text("client"),
  },
  (table) => [
    // The shape `parseKeptClient` accepts; SQL repeats it (migration test).
    check("site_versions_client_check", sql`${table.client} ~ '^[a-z0-9._/-]{1,40}$'`),
  ],
);

// ── site_version_files ───────────────────────────────────────────────────────
// Every object of a version (E08 D1): one row per stored path, at R2 key
// `sites/{siteId}/{versionId}/{path}`. The authority on what a version holds —
// every reader that enumerates a version's objects reads this, never an R2
// list. Cascades with its version. `size_bytes` is the file's own length.
export const siteVersionFiles = pgTable(
  "site_version_files",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => siteVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.path] })],
);

export type SiteVersionFile = typeof siteVersionFiles.$inferSelect;

// ── name_holds ───────────────────────────────────────────────────────────────
// A released name, held until `held_until` (D4: 365 days after a delete,
// rename, purge or account deletion) so that only its last owner can take it
// back. `user_id` is that owner; it goes NULL when the profile is deleted and
// the hold stays. `site_id` has no FK: a hold outlives the page's purge.
export const nameHolds = pgTable(
  "name_holds",
  {
    name: text("name").primaryKey(),
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id"),
    reason: nameHoldReasonEnum("reason").notNull(),
    heldUntil: timestamp("held_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("name_holds_user_id_idx").on(table.userId)],
);

// ── name_events ──────────────────────────────────────────────────────────────
// One row per rename. The rename limit (D6, 10 per rolling 24 h) counts them by
// `(user_id, created_at)`; the visits sync maps a past day's hostnames back to
// sites through them by `created_at`. `site_id` has no FK: the history outlives
// the page.
export const nameEvents = pgTable(
  "name_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id").notNull(),
    oldName: text("old_name").notNull(),
    newName: text("new_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("name_events_user_created_idx").on(table.userId, table.createdAt),
    index("name_events_created_idx").on(table.createdAt),
  ],
);

// ── page_views_daily ─────────────────────────────────────────────────────────
// Per-site daily visits, read in bulk from Cloudflare's aggregates (D8) and
// upserted by the visits sync. Never counted per view: the serve path writes
// nothing here. `day` is a UTC calendar date.
export const pageViewsDaily = pgTable(
  "page_views_daily",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    views: integer("views").notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.day] })],
);

// ── job_runs ─────────────────────────────────────────────────────────────────
// The last attempt and last success of each scheduled job, keyed by job name
// (`visits-sync`), so the studio can say "as of" and a stale job is visible.
export const jobRuns = pgTable("job_runs", {
  job: text("job").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  // The UTC day a job last finished checking (E07, migration 0008). Written
  // only by `spike-check`, which cannot derive it from its own
  // `last_success_at`: a late manual visits sync puts the two on different UTC
  // days and the same day would be re-checked every run. NULL for every other
  // job — the visits sync's code is frozen (E07 AC22) and never writes it.
  lastDay: date("last_day"),
});

// ── waitlist ─────────────────────────────────────────────────────────────────
// Addresses left on the landing while kept is closed (`lib/launch.ts`). Stored
// lowercased, so the primary key is the dedup. 0007 (E06a) adds double opt-in
// (only the confirm token's SHA-256 is stored), unsubscribe suppression and the
// founding application. Every added column is nullable or defaulted, so a 0006
// row is a valid `legacy` row that never confirmed.
export const waitlist = pgTable(
  "waitlist",
  {
    email: text("email").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text("source", { enum: WAITLIST_SOURCES }).notNull().default("legacy"),
    confirmTokenHash: text("confirm_token_hash"),
    confirmSentAt: timestamp("confirm_sent_at", { withTimezone: true }),
    /** Sends on the UTC day of `confirm_sent_at`; reset when that day changes. */
    confirmSendCount: integer("confirm_send_count").notNull().default(0),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    foundingStatus: text("founding_status", { enum: FOUNDING_STATUSES }),
    socialUrl: text("social_url"),
    note: text("note"),
    foundingDecidedAt: timestamp("founding_decided_at", { withTimezone: true }),
  },
  (table) => [
    check("waitlist_source_check", sql`${table.source} in (${inValues(WAITLIST_SOURCES)})`),
    check(
      "waitlist_founding_status_check",
      sql`${table.foundingStatus} in (${inValues(FOUNDING_STATUSES)})`,
    ),
    check(
      "waitlist_note_length_check",
      sql`char_length(${table.note}) <= ${sql.raw(String(FOUNDING_NOTE_MAX))}`,
    ),
    // The confirm page looks a row up by the digest of the token in its link.
    uniqueIndex("waitlist_confirm_token_hash_key").on(table.confirmTokenHash),
  ],
);

// ── rate_limits ──────────────────────────────────────────────────────────────
// `lib/rate-limit`'s fixed-window counters (E06a D4; E07 reuses them). `bucket`
// is `route:sha256(...)` — never a raw IP or address. One row per bucket per
// window; rows older than `RATE_LIMIT_RETENTION_DAYS` are pruned.
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucket, table.windowStart] })],
);

// ── scans (E07) ──────────────────────────────────────────────────────────────
// One row per scan of one version (§6.1). The row is written first, so a crash
// leaves a `pending` row that `scan-retry` finds. No page text is stored —
// `facts` and the typed `answers` only; R2 holds the HTML. A `done` row is
// reused for the same `(content_hash, policy_version)`.
export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => siteVersions.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    trigger: text("trigger", { enum: SCAN_TRIGGERS }).notNull(),
    status: text("status", { enum: SCAN_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    verdict: text("verdict", { enum: SCAN_VERDICTS }),
    rule: text("rule"),
    reason: moderationReasonEnum("reason"),
    policyVersion: text("policy_version").notNull(),
    model: text("model"),
    facts: jsonb("facts"),
    answers: jsonb("answers"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("scans_trigger_check", sql`${table.trigger} in (${inValues(SCAN_TRIGGERS)})`),
    check("scans_status_check", sql`${table.status} in (${inValues(SCAN_STATUSES)})`),
    check("scans_verdict_check", sql`${table.verdict} in (${inValues(SCAN_VERDICTS)})`),
    // `scan-retry`'s due rows.
    index("scans_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    // The reuse probe.
    index("scans_content_hash_policy_idx")
      .on(table.contentHash, table.policyVersion)
      .where(sql`${table.status} = 'done'`),
    // A version's latest scan ("scanned in the last 24 h", the admin screen).
    index("scans_version_created_idx").on(table.versionId, table.createdAt),
  ],
);

// ── abuse_reports (E07) ──────────────────────────────────────────────────────
// A report from `/report` (§6.8). Outlives the page: `site_id` goes NULL on
// purge and `slug` keeps the record readable. `reporter_bucket` is a salted
// digest for the 24 h duplicate collapse — never a raw IP. Name and email are
// cleared `REPORTER_CONTACT_RETENTION_DAYS` after resolution, by `purge`.
export const abuseReports = pgTable(
  "abuse_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    category: moderationReasonEnum("category").notNull(),
    details: text("details").notNull(),
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    reporterBucket: text("reporter_bucket").notNull(),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    check("abuse_reports_status_check", sql`${table.status} in (${inValues(REPORT_STATUSES)})`),
    index("abuse_reports_status_created_idx").on(table.status, table.createdAt),
    index("abuse_reports_site_created_idx").on(table.siteId, table.createdAt),
  ],
);

// ── moderation_actions (E07) ─────────────────────────────────────────────────
// The log: one row per status change or decision (§6.7). Outlives the page
// (`SET NULL` + `slug`). The version / scan / report / appeal ids carry no FK
// for the same reason — the record stays whole after its subject is purged.
// `version_id` is the version the page served when the action was taken: an
// admin restore is keyed by it, so the scanner leaves that version alone.
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    actor: text("actor", { enum: MODERATION_ACTORS }).notNull(),
    actorUserId: uuid("actor_user_id"),
    action: text("action", { enum: MODERATION_ACTIONS }).notNull(),
    fromStatus: siteStatusEnum("from_status").notNull(),
    toStatus: siteStatusEnum("to_status"),
    reason: moderationReasonEnum("reason"),
    automated: boolean("automated").notNull(),
    note: text("note"),
    versionId: uuid("version_id"),
    scanId: uuid("scan_id"),
    reportId: uuid("report_id"),
    appealId: uuid("appeal_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "moderation_actions_actor_check",
      sql`${table.actor} in (${inValues(MODERATION_ACTORS)})`,
    ),
    check(
      "moderation_actions_action_check",
      sql`${table.action} in (${inValues(MODERATION_ACTIONS)})`,
    ),
    index("moderation_actions_site_created_idx").on(table.siteId, table.createdAt),
    index("moderation_actions_created_idx").on(table.createdAt),
  ],
);

// ── appeals (E07) ────────────────────────────────────────────────────────────
// An owner's (or token holder's) request for review (§6.10). Goes with the
// page. `submitted_by_user_id` NULL = sent through the anonymous token.
export const appeals = pgTable(
  "appeals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    submittedByUserId: uuid("submitted_by_user_id"),
    message: text("message").notNull(),
    status: text("status", { enum: APPEAL_STATUSES }).notNull().default("open"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    check("appeals_status_check", sql`${table.status} in (${inValues(APPEAL_STATUSES)})`),
    // One open appeal per site; a second answers `409 appeal_open`.
    uniqueIndex("appeals_site_open_key")
      .on(table.siteId)
      .where(sql`${table.status} = 'open'`),
  ],
);

// ── pending_purges (E07) ─────────────────────────────────────────────────────
// The durable re-purge (§6.14): written before the in-process delayed purge is
// scheduled, deleted when it succeeds, replayed by the `repurge` cron.
// `site_id` set → replay is `syncManifest(site_id)` then purge; NULL → purge
// `urls` only. No FK: the row must outlive a purged page.
export const pendingPurges = pgTable(
  "pending_purges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id"),
    slug: text("slug").notNull(),
    urls: jsonb("urls").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("pending_purges_due_idx").on(table.dueAt)],
);

// ── api_keys (E09) ───────────────────────────────────────────────────────────
// A Pro-style key an agent publishes with (`Authorization: Bearer kpt_live_…`).
// Only the SHA-256 (hex) of the key is stored — the raw key is shown once, at
// creation. `prefix` is its first characters, for the settings table. Revoking
// stamps `revoked_at`; the row stays. Keys cascade with the profile, so account
// deletion needs nothing extra. `last_used_on` is a date: at most one write a
// day (`touchKeyLastUsed`).
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedOn: date("last_used_on"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("api_keys_name_length_check", sql`char_length(${table.name}) between 1 and 60`),
    // The settings list and the per-account cap count read active keys only.
    index("api_keys_user_active_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

// ── agent_codes (E09 D7, Q3) ─────────────────────────────────────────────────
// The one live sign-in code per address an agent asked for. Only its SHA-256
// is stored. A new request replaces the row; a correct verify deletes it; five
// wrong tries kill it. No FK: the address may have no account yet.
export const agentCodes = pgTable("agent_codes", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  // The requesting agent (`parseKeptClient`), carried to the key it mints.
  client: text("client"),
});

// ── referrals (E10 D11) ──────────────────────────────────────────────────────
// Who referred whom: one row per referred account. It counts once
// `verified_at` is set (a verified email, edge case 10). The referrer goes NULL
// when their account is deleted; the row goes with the referred account.
export const referrals = pgTable(
  "referrals",
  {
    referredId: uuid("referred_id")
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    referrerId: uuid("referrer_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    check("referrals_not_self_check", sql`${table.referrerId} <> ${table.referredId}`),
    index("referrals_referrer_idx").on(table.referrerId),
  ],
);

// ── handle_redirects (E10 Q2) ────────────────────────────────────────────────
// Every handle an account has left behind, pointing at the account — so its
// redirect always targets the CURRENT handle (no chains). The KV redirect is
// written from here. `profile_id` goes NULL on account deletion; the name then
// stays held, ownerless, forever (Q17).
export const handleRedirects = pgTable(
  "handle_redirects",
  {
    oldHandle: text("old_handle").primaryKey(),
    profileId: uuid("profile_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("handle_redirects_profile_idx").on(table.profileId)],
);

// ── relations ────────────────────────────────────────────────────────────────
export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  profile: one(profiles, {
    fields: [user.id],
    references: [profiles.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(user, {
    fields: [profiles.id],
    references: [user.id],
  }),
  sites: many(sites),
  nameHolds: many(nameHolds),
  nameEvents: many(nameEvents),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  owner: one(profiles, {
    fields: [sites.ownerId],
    references: [profiles.id],
  }),
  versions: many(siteVersions),
  pageViews: many(pageViewsDaily),
}));

export const siteVersionsRelations = relations(siteVersions, ({ one, many }) => ({
  site: one(sites, {
    fields: [siteVersions.siteId],
    references: [sites.id],
  }),
  files: many(siteVersionFiles),
}));

export const siteVersionFilesRelations = relations(siteVersionFiles, ({ one }) => ({
  version: one(siteVersions, {
    fields: [siteVersionFiles.versionId],
    references: [siteVersions.id],
  }),
}));

export const nameHoldsRelations = relations(nameHolds, ({ one }) => ({
  user: one(profiles, {
    fields: [nameHolds.userId],
    references: [profiles.id],
  }),
}));

export const nameEventsRelations = relations(nameEvents, ({ one }) => ({
  user: one(profiles, {
    fields: [nameEvents.userId],
    references: [profiles.id],
  }),
}));

export const pageViewsDailyRelations = relations(pageViewsDaily, ({ one }) => ({
  site: one(sites, {
    fields: [pageViewsDaily.siteId],
    references: [sites.id],
  }),
}));
