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
// A hosted page. `region` defaults to 'auto' so EU residency (E8) needs no
// migration. `ownerId` is null while a page is anonymous/unclaimed (E1/E2).
// `currentVersionId` points at the live row in `site_versions`.
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("sites_slug_key").on(table.slug)],
);

// ── site_versions ────────────────────────────────────────────────────────────
// An immutable published version of a site → R2 prefix `sites/{siteId}/{id}/`.
// `currentVersionId` on `sites` references one of these (FK wired app-side to
// avoid a circular DB constraint; the pair is kept consistent by the publish
// flow in E1).
export const siteVersions = pgTable("site_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  region: regionEnum("region").notNull().default("auto"),
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
