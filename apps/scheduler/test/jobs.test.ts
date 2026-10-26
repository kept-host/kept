import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dueJobs, parseCronJobs, type CronJob } from "../src/jobs";

const ALL: CronJob[] = [
  "scan-retry",
  "repurge",
  "expire",
  "visits-sync",
  "waitlist-prune",
  "purge",
  "draft-reminder",
];
const DAY_START = Date.UTC(2026, 9, 26);
const MINUTE = 60_000;

/** Every (minute, job) firing over one UTC day, with all jobs enabled. */
function firingsOverOneDay(): Map<CronJob, string[]> {
  const firings = new Map<CronJob, string[]>(ALL.map((job) => [job, []]));
  for (let m = 0; m < 24 * 60; m++) {
    for (const job of dueJobs(DAY_START + m * MINUTE, ALL)) {
      firings.get(job)!.push(new Date(DAY_START + m * MINUTE).toISOString().slice(11, 16));
    }
  }
  return firings;
}

describe("dueJobs", () => {
  const firings = firingsOverOneDay();

  it("fires the 12-minute jobs 120 times a day at their offsets", () => {
    const scanRetry = firings.get("scan-retry")!;
    const repurge = firings.get("repurge")!;
    console.log("scan-retry first/last:", scanRetry[0], scanRetry.at(-1), "count", scanRetry.length);
    console.log("repurge first/last:", repurge[0], repurge.at(-1), "count", repurge.length);
    expect(scanRetry).toHaveLength(120);
    expect(repurge).toHaveLength(120);
    expect(scanRetry.slice(0, 5)).toEqual(["00:03", "00:15", "00:27", "00:39", "00:51"]);
    expect(repurge.slice(0, 5)).toEqual(["00:07", "00:19", "00:31", "00:43", "00:55"]);
  });

  it("fires expire hourly at :23", () => {
    const expire = firings.get("expire")!;
    expect(expire).toHaveLength(24);
    expect(expire.every((hhmm) => hhmm.endsWith(":23"))).toBe(true);
  });

  it("fires each daily job once, at its old crontab time", () => {
    expect(firings.get("visits-sync")).toEqual(["03:17"]);
    expect(firings.get("waitlist-prune")).toEqual(["04:41"]);
    expect(firings.get("purge")).toEqual(["05:29"]);
    expect(firings.get("draft-reminder")).toEqual(["09:00"]);
  });

  it("never puts the two 12-minute jobs on the same tick", () => {
    const repurge = new Set(firings.get("repurge"));
    expect(firings.get("scan-retry")!.filter((hhmm) => repurge.has(hhmm))).toEqual([]);
  });

  it("uses the minute containing scheduledTime, whatever the seconds", () => {
    const at = Date.UTC(2026, 9, 26, 5, 29, 59, 999);
    expect(dueJobs(at, ALL)).toEqual(["purge"]);
    expect(dueJobs(at + 1, ALL)).toEqual([]);
  });

  it("runs only the enabled jobs", () => {
    const at = Date.UTC(2026, 9, 26, 5, 7);
    expect(dueJobs(at, ALL)).toEqual(["repurge"]);
    expect(dueJobs(at, ["expire", "purge"])).toEqual([]);
    expect(dueJobs(at, [])).toEqual([]);
  });
});

describe("parseCronJobs", () => {
  it("reads a comma list, ignoring spaces, empties and repeats", () => {
    expect(parseCronJobs(" repurge, expire,,repurge ")).toEqual(["repurge", "expire"]);
  });

  it("treats an empty string as no jobs", () => {
    expect(parseCronJobs("")).toEqual([]);
  });

  it("throws on an unknown job name", () => {
    expect(() => parseCronJobs("repurge,expiry")).toThrow('unknown job: "expiry"');
    expect(() => parseCronJobs("toString")).toThrow('unknown job: "toString"');
  });

  it("accepts the dev CRON_JOBS from wrangler.toml", () => {
    console.log("dev CRON_JOBS:", env.CRON_JOBS);
    expect(parseCronJobs(env.CRON_JOBS)).toEqual([
      "repurge",
      "scan-retry",
      "expire",
      "purge",
      "visits-sync",
    ]);
    expect(env.KEPT_APP_ORIGIN).toBe("https://app.kept-dev.xyz");
  });
});
