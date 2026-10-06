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
 * `page_views_daily` and `job_runs` (E06, migration 0005). Other per-epic tables
 * (E07 `scans`/`abuse_reports`/`moderation_actions`) are intentionally NOT
 * created here — they arrive via their own epic's migration.
 */
import {
  NAME_HOLD_REASONS,
  NAME_KINDS,
  PLANS,
  PUBLISH_CHANNELS,
  REGIONS,
  SITE_STATUSES,
  TITLE_SOURCES,
} from "@kept/shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
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
// and would silently rot the moment a user unlinks a provider. `handle` is a
// generic *display* handle, seeded opportunistically from whichever provider
// signed the user up first and editable by the user in E06; it is presentation,
// not identity. "Which providers is this user linked to?" queries `account`.
export const profiles = pgTable("profiles", {
  id: uuid("id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  handle: text("handle"),
  email: text("email"),
  plan: planEnum("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  ],
);

// ── site_versions ────────────────────────────────────────────────────────────
// An immutable published version of a site → R2 prefix `sites/{siteId}/{id}/`.
// `currentVersionId` on `sites` references one of these (FK wired app-side to
// avoid a circular DB constraint; the pair is kept consistent by the publish
// flow in E04).
export const siteVersions = pgTable("site_versions", {
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
  // SHA-256 (hex) of the stored HTML, and its byte length.
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
});

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
});

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

export const siteVersionsRelations = relations(siteVersions, ({ one }) => ({
  site: one(sites, {
    fields: [siteVersions.siteId],
    references: [sites.id],
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
