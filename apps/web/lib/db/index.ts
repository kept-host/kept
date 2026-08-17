/**
 * Typed Drizzle client over Neon Postgres.
 *
 * All Postgres data access goes through this client.
 *
 * Runtime connection: `DATABASE_URL` is the Neon *pooled* URL
 * (`ep-xxx-pooler.<region>.aws.neon.tech`), which is PgBouncer in transaction
 * mode. Transaction pooling does not support prepared statements, so
 * `prepare: false` is required.
 *
 * `idle_timeout` is functional, not cosmetic: Railway puts a service to sleep
 * only after 10 minutes with no *outbound* packets, and explicitly names a
 * held-open database pool as something that prevents sleeping. Letting idle
 * connections close is what makes Serverless on the dev environment actually
 * save money. It also lets Neon's own scale-to-zero (5 min idle) kick in.
 *
 * Migrations use the *direct* (non-pooled) URL and are run by drizzle-kit, not
 * this client — see drizzle.config.ts.
 *
 * The connection is built on first *use*, never on import. `next build`
 * evaluates every route module while collecting page data, and CI builds with
 * no secrets, so constructing the client at module scope fails the build on
 * `Missing DATABASE_URL` for any route that imports this file. Keep it lazy.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL. Set the Neon pooled connection string (see apps/web/.env.example).",
    );
  }
  return url;
}

/**
 * What `drizzle()` actually returns: the query builder plus `$client`, the
 * underlying `postgres` connection (tests close it through `closeDb()`).
 */
type Db = PostgresJsDatabase<typeof schema> & { $client: ReturnType<typeof postgres> };

let cached: Db | undefined;

function getDb(): Db {
  if (!cached) {
    const client = postgres(getDatabaseUrl(), {
      // Not supported by PgBouncer transaction mode (Neon's pooled endpoint).
      prepare: false,
      max: 5,
      idle_timeout: 30,
    });
    cached = drizzle(client, { schema });
  }
  return cached;
}

/**
 * The Drizzle client. Reads resolve against the real client on first property
 * access, so `db.select(...)` behaves exactly as before while merely importing
 * this module touches neither `process.env` nor the network.
 */
/**
 * Close the pooled connection and forget it, so the next use builds a fresh
 * one.
 *
 * For test teardown: postgres-js holds sockets open, which keeps a Playwright
 * worker process alive after its last assertion. Calling `db.$client.end()`
 * directly is the trap — the client is a module-scoped singleton and a
 * Playwright worker runs several spec files in turn, so the first file's
 * teardown left every later file in that worker querying a dead connection
 * (`write CONNECTION_ENDED`). Clearing the cache is what makes the close
 * survivable.
 */
export async function closeDb(): Promise<void> {
  const current = cached;
  cached = undefined;
  await current?.$client.end();
}

export const db = new Proxy({} as Db, {
  // No `.bind()` here: `db.$client` is postgres-js's callable client, and
  // binding a function drops the own properties hanging off it (`.end()`,
  // `.begin()`). Methods reached through the proxy get `this` = the proxy,
  // whose own reads forward here anyway.
  get: (_target, prop) => Reflect.get(getDb(), prop),
});

export { schema };
