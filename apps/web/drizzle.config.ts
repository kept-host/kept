/**
 * drizzle-kit config.
 *
 * Schema is the single source of truth; `drizzle-kit generate` emits versioned
 * SQL into `drizzle/`, and `drizzle-kit migrate` applies them.
 *
 * Postgres is Neon. Neon exposes two hostnames for the same database:
 *   - pooled  ep-xxx-pooler.<region>.aws.neon.tech  (PgBouncer, transaction mode)
 *   - direct  ep-xxx.<region>.aws.neon.tech
 * They share a port — the difference is the `-pooler` infix, NOT the port number.
 *
 * Migrations MUST use the direct hostname: transaction-mode pooling does not
 * support the session-scoped advisory locks and multi-statement DDL that
 * drizzle-kit needs. Set MIGRATION_DATABASE_URL explicitly (this is what CI
 * does); otherwise we derive it from DATABASE_URL by stripping `-pooler`.
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
      "Missing MIGRATION_DATABASE_URL and DATABASE_URL. Set the Neon connection string in apps/web/.env.local (see .env.example).",
    );
  }

  if (!url.includes("-pooler.")) return url;

  console.warn(
    "[drizzle] MIGRATION_DATABASE_URL is unset and DATABASE_URL points at the Neon pooler.\n" +
      "[drizzle] Deriving the direct URL by stripping `-pooler`. Set MIGRATION_DATABASE_URL explicitly in CI.",
  );
  return url.replace("-pooler.", ".");
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
