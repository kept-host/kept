/**
 * Race-drill plumbing for the end-of-life drills (`lib/sites/delete-races.test.ts`,
 * `lib/lifecycle/lifecycle.test.ts`) — E07 task 008.
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob. NO MOCKS — a real second connection holds a real row lock, and
 * the drill waits until Postgres SHOWS the code under test queued behind it
 * (`pg_blocking_pids`), so an interleaving is forced without a sleep.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { SiteStatus } from "@kept/shared";
import postgres from "postgres";

import { MS_PER_SECOND } from "../sites/display";
import { pointerKey } from "../storage/manifest";
import { r2Store } from "../storage/r2";

/** What a drill that touches Postgres, R2, KV and the edge needs. */
const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;

/** `false`, or why a live drill skips (fork-PR CI has no dev credentials). */
export function liveSkip(): string | false {
  const missing = LIVE_VARS.filter((name) => !process.env[name]);
  return missing.length > 0 ? `dev credentials absent (${missing.join(", ")})` : false;
}

const PROPAGATION_WINDOW_MS = 60 * MS_PER_SECOND;
const PROBE_INTERVAL_MS = 3 * MS_PER_SECOND;
const LOCK_WAIT_TIMEOUT_MS = 20 * MS_PER_SECOND;
/** How often a drill re-reads `pg_stat_activity` while it waits. */
const LOCK_POLL_MS = MS_PER_SECOND / 20;

/** The manifest the edge reads for `slug` — the R2 pointer, byte-identical to KV. */
export async function manifestAt(slug: string): Promise<{ status: string; siteId: string } | null> {
  const body = await r2Store().get(pointerKey(slug));
  return body === null ? null : (JSON.parse(body) as { status: string; siteId: string });
}

/** The edge's answer for `slug`, polled until it is `expected` or the window closes. */
export async function edgeStatus(slug: string, expected: number): Promise<number> {
  const url = `https://${slug}.${process.env.KEPT_BASE_DOMAIN}/`;
  const deadline = Date.now() + PROPAGATION_WINDOW_MS;
  for (;;) {
    const res = await fetch(url, { redirect: "manual" });
    await res.body?.cancel();
    if (res.status === expected || Date.now() > deadline) return res.status;
    await sleep(PROBE_INTERVAL_MS);
  }
}

/** A promise's value or the error it threw — a raced call is judged after the race. */
export function settle<T>(work: Promise<T>): Promise<T | unknown> {
  return work.then(
    (value) => value,
    (err: unknown) => err,
  );
}

export interface HeldLock {
  /** H's backend pid — what the code under test queues behind. */
  pid: number;
  /** Let go. `flag` (a `sites` lock only): commit `status = flag` on the way out. */
  release(flag?: SiteStatus): Promise<void>;
}

/** Connection H: its own pool, so the app's pool is exactly what the code under test sees. */
export class LockDrill {
  private readonly side = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });

  /** Hold `table`'s row `id` `FOR UPDATE` until `release`. */
  async hold(table: "profiles" | "sites", id: string): Promise<HeldLock> {
    let open!: (flag: SiteStatus | null) => void;
    const gate = new Promise<SiteStatus | null>((resolve) => (open = resolve));
    let locked!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => (locked = resolve));
    const done = this.side.begin(async (tx) => {
      await tx`select id from ${tx(table)} where id = ${id} for update`;
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      locked(row!.pid);
      const flag = await gate;
      if (flag) await tx`update sites set status = ${flag} where id = ${id}`;
    });
    return {
      pid: await Promise.race([pid, done.then(() => Promise.reject(new Error("H ended early")))]),
      release: async (flag?: SiteStatus) => {
        if (flag && table !== "sites") throw new Error("A flag can only ride on a sites lock.");
        open(flag ?? null);
        await done;
      },
    };
  }

  /**
   * Wait until `n` backends are queued, directly or transitively, behind
   * `root`: a second waiter on a row lock queues behind the first (the tuple
   * lock), not behind the holder.
   */
  async waitForWaiters(root: number, n = 1): Promise<void> {
    const started = Date.now();
    for (;;) {
      const rows = await this.side<{ pid: number; blockers: number[] }[]>`
        select pid, pg_blocking_pids(pid) as blockers
          from pg_stat_activity
         where cardinality(pg_blocking_pids(pid)) > 0`;
      const behind = new Set([root]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const row of rows) {
          if (!behind.has(row.pid) && row.blockers.some((pid) => behind.has(pid))) {
            behind.add(row.pid);
            grew = true;
          }
        }
      }
      if (behind.size - 1 >= n) return;
      if (Date.now() - started > LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Only ${behind.size - 1} of ${n} backends queued behind pid ${root}.`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  end(): Promise<void> {
    return this.side.end();
  }
}
