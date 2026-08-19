import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * What a test that drives the REAL remote stack is allowed to cost.
 *
 * Not a `*.spec.ts`, so Playwright never collects it as a test file.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `dc3bf9a` established the shape of this for `anon-keep-flow.spec.ts`: the
 * intermittency in the session-bearing specs is not a product fault, it is
 * Playwright's DEFAULT 30 000 ms per-test budget sitting in the middle of the
 * dev stack's real latency distribution. Measured against the dev Neon branch
 * (`br-dark-cell-ashmohpg`, eu-central-1) from a developer laptop:
 *
 *   - opening a NEW connection      ~3.0-5.5 s
 *   - a warm `select 1` on it       ~50-750 ms, median ~450 ms
 *   - `GET /api/auth/magic-link/verify`   8-12 s, warm, every time
 *
 * That last one is the dominant term and it is arithmetic, not a defect: Better
 * Auth's verify does findVerification → deleteVerification → findUserByEmail →
 * createUser → createAccount → createSession, plus this repo's `bootstrapProfile`
 * hook, which is ~8-10 sequential round trips at ~450 ms each. Co-located in
 * production (Railway EU next to Neon EU) the same path is sub-second; it is
 * slow here and only here, because the round trip is transatlantic.
 *
 * So a test that signs one user in costs ~15 s before it asserts anything, and
 * `owner-sites-api.spec.ts:213` — which signs in TWICE, to prove a stranger's
 * page is a 404 — was measured at 48.6 s. Under a 30 s budget those tests fail
 * or pass on which side of the median the database happened to land, which is
 * exactly the intermittency they showed.
 *
 * ⚠️ A TIMEOUT HERE MASQUERADES AS A PRODUCT BUG, and in this family it
 * masquerades as a SECURITY one. `owner-sites-api.spec.ts` asserts that a
 * cookie-bearing request from a hosted page's `Origin` is refused 403 AND
 * mutates neither row. A test that never got to the re-read looks, in a run
 * summary, a lot like a test that found a mutation. Every one of these
 * assertions was re-run under a wide budget and holds: 15/15 passed. If they
 * fail again, read the failure — "Test timeout of Nms exceeded" is this
 * problem, and an actual `expect(...).toEqual` diff is not.
 *
 * NOTHING IS RELAXED BY THIS NUMBER. The same statuses, the same bodies and
 * the same re-read rows are still required; only the waiting is.
 */
export const LIVE_STACK_TIMEOUT = 120_000;

/**
 * Pay the connection-establishment cost in a hook instead of in whichever test
 * happens to run first.
 *
 * Call from `beforeAll`. Playwright budgets hooks separately from tests, so the
 * ~3-5.5 s of TCP + TLS + Postgres startup this forces lands outside every
 * test's clock — and the first test in the file stops being ~5 s slower than
 * its siblings for a reason that has nothing to do with what it asserts.
 *
 * This is needed because `closeDb()` in `afterAll` ends the pool AND clears the
 * module cache (see `lib/db/index.ts` — clearing is what makes the close
 * survivable when one Playwright worker runs several spec files in turn). That
 * is correct and must stay: postgres-js sockets otherwise keep the worker
 * process alive past its last assertion. The price is that every spec file
 * after the first in a worker reconnects from cold. This moves that price.
 */
export async function warmDb(): Promise<void> {
  await db.execute(sql`select 1`);
}
