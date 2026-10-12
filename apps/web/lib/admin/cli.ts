/**
 * The admin CLI (E06a §9, task 009), run from Arun's machine through
 * `scripts/admin.ts` against whatever `DATABASE_URL` is loaded:
 *
 *   pnpm --filter @kept/web admin:token new
 *   pnpm --filter @kept/web admin:founding add <email> <socialUrl> [--note …]
 *   pnpm --filter @kept/web admin:waitlist stats
 *   pnpm --filter @kept/web admin:waitlist export [--confirmed] [--founding approved]
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
import { waitlistExport, waitlistStats, type WaitlistExportRow } from "../db/queries/waitlist";

export interface AdminIo {
  out: (line: string) => void;
  info: (line: string) => void;
}

const USAGE = `usage:
  admin:token new
  admin:founding add <email> <socialUrl> [--note <text>]
  admin:waitlist stats
  admin:waitlist export [--confirmed] [--founding ${FOUNDING_STATUSES.join("|")}]`;

const VALUE_FLAGS = new Set(["note", "founding"]);
const SWITCH_FLAGS = new Set(["confirmed"]);

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
    if (flags.has("note")) throw new Error(USAGE);
    return waitlistExportCommand(flags, io);
  }
  throw new Error(USAGE);
}
