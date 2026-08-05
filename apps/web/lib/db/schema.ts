/**
 * Drizzle schema — core cross-epic tables (task 006).
 *
 * The Drizzle schema is the single source of truth for table shape; pgEnums are
 * driven directly from the `@kept/shared` enum value tuples so DB types can never
 * drift from the app/zod types. Columns/types mirror the shared zod schemas
 * (`siteSchema`, `profileSchema`) and `PublishPayload`.
 *
 * Core tables only: `profiles`, `sites`, `site_versions`. Per-epic tables
 * (E5 `scans`/`abuse_reports`/`moderation_actions`, E4 `funding_snapshot`) are
 * intentionally NOT created here — they arrive via per-epic migrations.
 */
import { PLANS, REGIONS, SITE_STATUSES } from "@kept/shared";
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Enums (driven from @kept/shared so values never drift) ───────────────────
export const siteStatusEnum = pgEnum("site_status", SITE_STATUSES);
export const planEnum = pgEnum("plan", PLANS);
export const regionEnum = pgEnum("region", REGIONS);

// ── profiles ─────────────────────────────────────────────────────────────────
// A user profile. Auth is self-hosted Better Auth, whose own tables live in this
// same database, so there is no external identity provider to mirror. E05 wires
// the FK from `id` to Better Auth's user table alongside the auth flows.
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
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
    // Denormalised from the current version so the dedup probe is a single
    // index scan on `sites` and never has to join `site_versions`.
    contentHash: text("content_hash"),
    sizeBytes: integer("size_bytes"),
    // Optional "your draft expires soon" address collected on the result screen.
    reminderEmail: text("reminder_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sites_slug_key").on(table.slug),
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
});

// ── relations ────────────────────────────────────────────────────────────────
export const profilesRelations = relations(profiles, ({ many }) => ({
  sites: many(sites),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  owner: one(profiles, {
    fields: [sites.ownerId],
    references: [profiles.id],
  }),
  versions: many(siteVersions),
}));

export const siteVersionsRelations = relations(siteVersions, ({ one }) => ({
  site: one(sites, {
    fields: [siteVersions.siteId],
    references: [sites.id],
  }),
}));
