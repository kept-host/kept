/**
 * The admin CLI (E06a §9, task 009), run from Arun's machine through
 * `scripts/admin.ts` against whatever `DATABASE_URL` is loaded:
 *
 *   pnpm --filter @kept/web admin:token new
 *   pnpm --filter @kept/web admin:founding add <email> <socialUrl> [--note …]
 *   pnpm --filter @kept/web admin:waitlist stats
 *   pnpm --filter @kept/web admin:waitlist export [--confirmed] [--founding approved]
 *   pnpm --filter @kept/web admin:scan --unscanned [--limit <n>]
 *   pnpm --filter @kept/web admin:scan --all-live --dry-run|--apply [--limit <n>]
 *   pnpm --filter @kept/web admin:badge-backfill [--limit <n>]
 *
 * `admin:scan` is the scanner's backfill (E07 §6.1): `--unscanned` scans live
 * pages that have no scan at all (pages published before E07), `--all-live`
 * re-judges every live page after a policy change — `--dry-run` only counts
 * what would be flagged and writes nothing, `--apply` scans for real (trigger
 * `backfill`; a flag goes through `setStatus` like any scan). Newest first;
 * `--limit` takes that many, for a backlog worked through in parts.
 *
 * `admin:badge-backfill` (E10 §4.10, Q4) puts the badge into the manifests
 * written before E10: it queues one `pending_purges` re-sync per `live` page,
 * oldest first, at most `--limit`, and the `repurge` job replays them — one KV
 * write each, so on dev (1,000 writes a day) it runs with a limit, after
 * 00:00 UTC. A page whose re-sync is already queued is skipped.
 *
 * Every command reuses a library function and says what it changed; each is
 * idempotent. `out` is the command's result (stdout: the CSV, the token);
 * `info` is commentary (stderr), so `export > list.csv` stays a clean file.
 *
 * The freshly minted access token is the ONE secret this prints, once, by
 * design. Nothing else that is secret is ever printed — the database is named
 * by its host's first label at most.
 */
import {
  FOUNDING_STATUSES,
  foundingDetailsSchema,
  waitlistEmailSchema,
  type FoundingStatus,
} from "@kept/shared";

import { mintAccessToken } from "../access-token";
import { foundingApplication, upsertApprovedFounding } from "../db/queries/founding";
import { enqueueLiveSyncs } from "../db/queries/manifest-sync";
import { liveVersions, unscannedLiveVersions, type ScanTarget } from "../db/queries/scans";
import { waitlistExport, waitlistStats, type WaitlistExportRow } from "../db/queries/waitlist";
import { defaultClassifier, type ContentClassifier } from "../scan/classifier";
import { judge, runScan } from "../scan/run";
import type { PolicyDecision } from "../scan/types";

export interface AdminIo {
  out: (line: string) => void;
  info: (line: string) => void;
}

const USAGE = `usage:
  admin:token new
  admin:founding add <email> <socialUrl> [--note <text>]
  admin:waitlist stats
  admin:waitlist export [--confirmed] [--founding ${FOUNDING_STATUSES.join("|")}]
  admin:scan --unscanned [--limit <n>]
  admin:scan --all-live --dry-run|--apply [--limit <n>]
  admin:badge-backfill [--limit <n>]`;

const VALUE_FLAGS = new Set(["note", "founding", "limit"]);
const SWITCH_FLAGS = new Set(["confirmed", "unscanned", "all-live", "dry-run", "apply"]);

/** `process.argv`-style words → positionals and `--flags` (`--flag value` or `--flag=value`). */
function parseArgs(args: readonly string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!;
    if (!word.startsWith("--")) {
      positional.push(word);
      continue;
    }
    const [name, inline] = word.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (SWITCH_FLAGS.has(name) && inline === undefined) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[(i += 1)];
      if (value === undefined) throw new Error(`--${name} needs a value\n${USAGE}`);
      flags.set(name, value);
    } else {
      throw new Error(`unknown option --${name}\n${USAGE}`);
    }
  }
  return { positional, flags };
}

/** Which database the command runs against: the host's first label, never the URL. */
function databaseLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL. Set it in apps/web/.env.local (see .env.example).");
  return new URL(url).hostname.split(".")[0]!;
}

/** RFC 4180: quote a field holding a comma, quote or line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const EXPORT_HEADER = "email,source,confirmed_at,founding_status,social_url";

function csvLine(row: WaitlistExportRow): string {
  return [
    row.email,
    row.source,
    row.confirmedAt?.toISOString() ?? "",
    row.foundingStatus ?? "",
    row.socialUrl ?? "",
  ]
    .map(csvField)
    .join(",");
}

async function tokenNew(io: AdminIo): Promise<void> {
  const { token, hash } = await mintAccessToken();
  io.info("new access token — shown ONCE, never stored; hand it to the agent now:");
  io.out(token);
  io.info("its SHA-256, to append (comma-separated) to KEPT_ACCESS_TOKEN_HASHES:");
  io.out(hash);
}

async function foundingAdd(args: string[], flags: Map<string, string | true>, io: AdminIo) {
  const [rawEmail, rawSocialUrl, ...extra] = args;
  if (rawEmail === undefined || rawSocialUrl === undefined || extra.length > 0) {
    throw new Error(USAGE);
  }
  const email = waitlistEmailSchema.safeParse(rawEmail);
  if (!email.success) throw new Error("not a valid email address");
  const note = flags.get("note");
  const details = foundingDetailsSchema.safeParse({
    socialUrl: rawSocialUrl,
    note: typeof note === "string" ? note : undefined,
  });
  if (!details.success) {
    throw new Error(details.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  const wanted = { socialUrl: details.data.socialUrl, note: details.data.note ?? null };

  io.info(`database: ${databaseLabel()}`);
  const before = await foundingApplication(email.data);
  if (
    before?.foundingStatus === "approved" &&
    before.socialUrl === wanted.socialUrl &&
    before.note === wanted.note
  ) {
    io.out("unchanged: already approved with these details");
    return;
  }
  await upsertApprovedFounding(email.data, wanted.socialUrl, details.data.note);
  io.out(
    before === null
      ? "approved: new founding creator (no confirmation set, no mail sent)"
      : `approved: updated (was ${before.foundingStatus}; no confirmation set, no mail sent)`,
  );
}

async function waitlistExportCommand(flags: Map<string, string | true>, io: AdminIo) {
  const founding = flags.get("founding");
  if (founding !== undefined && !FOUNDING_STATUSES.includes(founding as FoundingStatus)) {
    throw new Error(`--founding must be one of ${FOUNDING_STATUSES.join(", ")}`);
  }
  io.info(`database: ${databaseLabel()}`);
  const rows = await waitlistExport({
    confirmed: flags.get("confirmed") === true,
    foundingStatus: founding as FoundingStatus | undefined,
  });
  io.out(EXPORT_HEADER);
  for (const row of rows) io.out(csvLine(row));
  io.info(`${rows.length} row(s)`);
}

type StatsRow = Awaited<ReturnType<typeof waitlistStats>>[number];

const STATS_SECTIONS: readonly (readonly [string, (row: StatsRow) => string])[] = [
  ["by state", (row) => row.state],
  ["by source", (row) => row.source],
  ["by source/state", (row) => `${row.source}/${row.state}`],
  ["by founding status", (row) => row.foundingStatus ?? "none"],
];

async function waitlistStatsCommand(io: AdminIo) {
  io.info(`database: ${databaseLabel()}`);
  const rows = await waitlistStats();
  const tally = (key: (row: StatsRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + row.count);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  };
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  io.out(`total: ${total}`);
  for (const [title, key] of STATS_SECTIONS) {
    io.out(`${title}:`);
    for (const [name, count] of tally(key)) io.out(`  ${name}: ${count}`);
  }
}

/** `--limit`: a positive whole number, or absent (every page). */
function parseLimit(raw: string | true | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) throw new Error(`--limit must be a positive whole number\n${USAGE}`);
  return Number(raw);
}

function verdictLine(decision: PolicyDecision | null): string {
  return decision?.verdict === "flag" ? `${decision.rule} ${decision.reason}` : "clean";
}

/** Scan each target for real (trigger `backfill`), awaited one at a time. */
async function backfill(targets: ScanTarget[], classifier: ContentClassifier | null, io: AdminIo) {
  const tally = { done: 0, skipped: 0, failed: 0, flagged: 0, notStarted: 0 };
  for (const target of targets) {
    const run = await runScan(target.siteId, target.versionId, "backfill", classifier);
    if (!run) {
      tally.notStarted += 1;
      io.out(`not started: ${target.slug}`);
      continue;
    }
    tally[run.status] += 1;
    if (run.flagged) {
      tally.flagged += 1;
      io.out(`flagged: ${run.slug} — ${verdictLine(run.decision)}`);
    } else if (run.status === "failed") {
      io.out(`failed: ${run.slug} (retried by scan-retry)`);
    }
  }
  io.out(
    `scanned ${targets.length} page(s): ${tally.done} done, ${tally.skipped} skipped, ${tally.failed} failed, ${tally.notStarted} not started; ${tally.flagged} flagged`,
  );
}

/** Judge each target and count; writes nothing and changes no status. */
async function dryRun(targets: ScanTarget[], classifier: ContentClassifier | null, io: AdminIo) {
  let wouldFlag = 0;
  let unjudged = 0;
  let costUsd = 0;
  for (const target of targets) {
    const judgment = await judge(target, classifier);
    if (judgment.status === "done") costUsd += Number(judgment.costUsd);
    if (judgment.status === "failed") {
      unjudged += 1;
      io.info(`could not judge ${target.slug}: ${judgment.error}`);
    }
    if (judgment.decision?.verdict === "flag") {
      wouldFlag += 1;
      io.out(`would flag: ${target.slug} — ${verdictLine(judgment.decision)}`);
    }
  }
  io.out(
    `dry run: ${targets.length} live page(s), ${wouldFlag} would be flagged, ${unjudged} could not be fully judged — nothing written, no status changed`,
  );
  io.info(`classifier cost: $${costUsd.toFixed(6)}`);
}

async function scanCommand(flags: Map<string, string | true>, io: AdminIo) {
  const limit = parseLimit(flags.get("limit"));
  io.info(`database: ${databaseLabel()}`);
  const classifier = defaultClassifier();
  io.info(
    classifier
      ? `scanner: on (${classifier.model})`
      : "scanner: off — no OPENROUTER_API_KEY, so scans record `skipped` and only P4 can flag",
  );
  if (flags.has("unscanned")) return backfill(await unscannedLiveVersions(new Date(), limit), classifier, io);
  const targets = await liveVersions(limit);
  return flags.has("apply") ? backfill(targets, classifier, io) : dryRun(targets, classifier, io);
}

/** Queue a badge re-sync for `live` pages, oldest first (E10 §4.10). */
async function badgeBackfill(flags: Map<string, string | true>, io: AdminIo) {
  const limit = parseLimit(flags.get("limit"));
  io.info(`database: ${databaseLabel()}`);
  const queued = await enqueueLiveSyncs(limit);
  io.out(`queued ${queued} badge re-sync(s) — the repurge job writes them (one KV write each)`);
}

/** Exactly one of `--unscanned` and `--all-live`; `--all-live` takes exactly one of `--dry-run` and `--apply`. */
function validScanFlags(flags: Map<string, string | true>): boolean {
  const names = [...flags.keys()].filter((name) => name !== "limit");
  if (names.length === 1 && names[0] === "unscanned") return true;
  return (
    names.length === 2 &&
    names.includes("all-live") &&
    (names.includes("dry-run") || names.includes("apply"))
  );
}

/** Run one admin command. Throws (with the usage) on a bad invocation. */
export async function runAdmin(args: readonly string[], io: AdminIo): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [group, command, ...rest] = positional;
  const noFlags = () => {
    if (flags.size > 0) throw new Error(USAGE);
  };

  if (group === "token" && command === "new" && rest.length === 0) {
    noFlags();
    return tokenNew(io);
  }
  if (group === "founding" && command === "add") {
    if ([...flags.keys()].some((name) => name !== "note")) throw new Error(USAGE);
    return foundingAdd(rest, flags, io);
  }
  if (group === "waitlist" && command === "stats" && rest.length === 0) {
    noFlags();
    return waitlistStatsCommand(io);
  }
  if (group === "waitlist" && command === "export" && rest.length === 0) {
    if ([...flags.keys()].some((name) => name !== "confirmed" && name !== "founding")) throw new Error(USAGE);
    return waitlistExportCommand(flags, io);
  }
  if (group === "scan" && command === undefined) {
    if (!validScanFlags(flags)) throw new Error(USAGE);
    return scanCommand(flags, io);
  }
  if (group === "badge-backfill" && command === undefined) {
    if ([...flags.keys()].some((name) => name !== "limit")) throw new Error(USAGE);
    return badgeBackfill(flags, io);
  }
  throw new Error(USAGE);
}
