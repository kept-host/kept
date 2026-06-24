/**
 * drizzle-kit config (task 006).
 *
 * Schema is the single source of truth; `drizzle-kit generate` emits versioned
 * SQL into `drizzle/`, and `drizzle-kit migrate` applies them.
 *
 * DATABASE_URL (loaded from .env.local) is the Supabase connection-pooler URL in
 * Transaction mode (port 6543), which is correct for serverless runtime but does
 * NOT support the prepared statements / multi-statement DDL that migrations need.
 * For migrations we therefore use the pooler's Session mode on the same host
 * (port 5432). Set MIGRATION_DATABASE_URL to override explicitly (e.g. a direct
 * db.<ref>.supabase.co:5432 connection); otherwise we derive it from
 * DATABASE_URL by switching 6543 → 5432.
 */
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

function getMigrationUrl(): string {
  const explicit = process.env.MIGRATION_DATABASE_URL;
  if (explicit) return explicit;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL. Set the Supabase Postgres connection string in apps/web/.env.local.",
    );
  }
  // Pooler Transaction mode (6543) → Session mode (5432) for migrations.
  return url.replace(":6543/", ":5432/");
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: getMigrationUrl(),
  },
  strict: true,
  verbose: true,
});
