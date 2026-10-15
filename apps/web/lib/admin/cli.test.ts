/**
 * The admin CLI (E06a §9, task 009, AC14 + AC11's export half), run through
 * `runAdmin` exactly as `scripts/admin.ts` runs it, with its output captured.
 *
 * NO MOCKS. Real dev Neon (SKIPS without `DATABASE_URL`). No mail is sent by
 * any command under test, except the scanner's admin alert for the one page
 * `admin:scan --all-live --apply` flags, which goes to Resend's test inbox.
 *
 * `admin:scan` (E07 task 007) runs on real pages — `lib/testing/scan-drill.ts`
 * rows plus their R2 objects — made the newest so `--limit 1` picks them. KV:
 * one write (the flag) and one delete (teardown). Rows are per-run `admin-cli-…@resend.dev` addresses,
 * deleted in `after`. The minted token is asserted on shape and hash only and
 * never printed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import { config } from "dotenv";

import { runAdmin } from "./cli";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const RUN = crypto.randomUUID().slice(0, 8);
const emails = new Set<string>();
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-007-cli-${RUN}@resend.dev`;

const STORE_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_AUTO", "KV_NAMESPACE_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "KEPT_BASE_DOMAIN"];
const skipStores =
  skipLive || (STORE_VARS.some((name) => !process.env[name]) ? "dev store credentials absent — admin:scan reads R2" : false);
const scanDrill = skipStores ? null : import("../testing/scan-drill").then(({ ScanDrill }) => new ScanDrill("e07-007-cli"));
function address(label: string): string {
  const email = `admin-cli-${RUN}-${label}@resend.dev`;
  emails.add(email);
  return email;
}

after(async () => {
  if (skipLive) return;
  const { db, closeDb } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  if (emails.size > 0) await db.delete(waitlist).where(inArray(waitlist.email, [...emails]));
  if (scanDrill) await (await scanDrill).cleanup();
  await closeDb();
});

/** Run one command; `out` is stdout's lines, `info` stderr's. */
async function run(...args: string[]): Promise<{ out: string[]; info: string[] }> {
  const out: string[] = [];
  const info: string[] = [];
  await runAdmin(args, { out: (line) => out.push(line), info: (line) => info.push(line) });
  return { out, info };
}

async function row(email: string) {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [found] = await db.select().from(waitlist).where(eq(waitlist.email, email));
  return found;
}

test("token new: prints a token once plus its SHA-256; that hash in the env admits the token", async () => {
  const { out, info } = await run("token", "new");
  assert.equal(out.length, 2, "stdout carries exactly the token and its hash");
  const [token, hash] = out as [string, string];
  assert.match(token, /^kpt_access_[A-Za-z0-9_-]{43}$/, "token shape");
  assert.match(hash, /^[0-9a-f]{64}$/, "hash shape");
  assert.equal(hash, createHash("sha256").update(token).digest("hex"), "hash is the token's SHA-256");
  assert.ok(info.some((line) => line.includes("KEPT_ACCESS_TOKEN_HASHES")), "says where the hash goes");
  assert.ok(!info.some((line) => line.includes(token)), "the token is printed once, to stdout only");

  const { carriesAccessToken } = await import("../access-token");
  const bearer = () =>
    new Request("https://app.example.test/api/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  const saved = process.env.KEPT_ACCESS_TOKEN_HASHES;
  try {
    process.env.KEPT_ACCESS_TOKEN_HASHES = "";
    assert.equal(await carriesAccessToken(bearer()), false, "refused before its hash is configured");
    process.env.KEPT_ACCESS_TOKEN_HASHES = `${"0".repeat(64)},${hash}`;
    assert.equal(await carriesAccessToken(bearer()), true, "accepted once its hash is configured");
  } finally {
    if (saved === undefined) delete process.env.KEPT_ACCESS_TOKEN_HASHES;
    else process.env.KEPT_ACCESS_TOKEN_HASHES = saved;
  }
});

test("founding add: approves without confirming or mailing; re-running changes nothing", { skip: skipLive }, async () => {
  const email = address("founding");
  const first = await run("founding", "add", email.toUpperCase(), "https://example.com/me", "--note", "films");
  assert.deepEqual(first.out, ["approved: new founding creator (no confirmation set, no mail sent)"]);
  assert.ok(first.info.some((line) => line.startsWith("database: ")), "names the database");
  assert.ok(!first.info.join("\n").includes("postgres"), "never prints the connection URL");

  const created = await row(email);
  assert.ok(created, "stored lowercased");
  assert.equal(created.foundingStatus, "approved");
  assert.equal(created.source, "admin");
  assert.equal(created.socialUrl, "https://example.com/me");
  assert.equal(created.note, "films");
  assert.equal(created.confirmedAt, null, "no confirmed_at: no marketing consent was given");
  assert.equal(created.confirmSentAt, null, "no confirmation mail");
  assert.ok(created.foundingDecidedAt);

  const again = await run("founding", "add", email, "https://example.com/me", "--note=films");
  assert.deepEqual(again.out, ["unchanged: already approved with these details"]);
  const same = await row(email);
  assert.deepEqual(same, created, "the row is untouched");

  const edited = await run("founding", "add", email, "https://example.com/me");
  assert.deepEqual(edited.out, ["approved: updated (was approved; no confirmation set, no mail sent)"]);
  const updated = await row(email);
  assert.equal(updated?.note, null);
  assert.equal(updated?.foundingDecidedAt?.getTime(), created.foundingDecidedAt.getTime(), "keeps its decision time");
});

test("founding add: a pending applicant becomes approved, keeping its confirmation", { skip: skipLive }, async () => {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const email = address("pending");
  const confirmedAt = new Date("2026-10-01T00:00:00Z");
  await db.insert(waitlist).values({
    email,
    source: "founding",
    foundingStatus: "pending",
    socialUrl: "https://example.com/old",
    confirmedAt,
  });
  const { out } = await run("founding", "add", email, "https://example.com/new");
  assert.deepEqual(out, ["approved: updated (was pending; no confirmation set, no mail sent)"]);
  const updated = await row(email);
  assert.equal(updated?.foundingStatus, "approved");
  assert.equal(updated?.source, "founding", "source is not rewritten");
  assert.equal(updated?.confirmedAt?.getTime(), confirmedAt.getTime());
});

test("bad invocations throw the usage and touch nothing", async () => {
  await assert.rejects(run(), /usage:/);
  await assert.rejects(run("token", "new", "--confirmed"), /usage:/);
  await assert.rejects(run("waitlist", "export", "--bogus"), /unknown option --bogus/);
  await assert.rejects(run("waitlist", "export", "--founding", "maybe"), /--founding must be one of/);
  await assert.rejects(run("founding", "add", "not-an-email", "https://example.com"), /not a valid email/);
  await assert.rejects(run("founding", "add", "a@resend.dev", "javascript:alert(1)"), /socialUrl/);
  await assert.rejects(run("founding", "add", "a@resend.dev"), /usage:/);
  await assert.rejects(run("scan"), /usage:/);
  await assert.rejects(run("scan", "--all-live"), /usage:/, "--all-live needs --dry-run or --apply");
  await assert.rejects(run("scan", "--all-live", "--dry-run", "--apply"), /usage:/);
  await assert.rejects(run("scan", "--unscanned", "--apply"), /usage:/);
  await assert.rejects(run("scan", "--unscanned", "--all-live", "--dry-run"), /usage:/);
  await assert.rejects(run("scan", "now", "--unscanned"), /usage:/);
  await assert.rejects(run("scan", "--unscanned", "--limit", "0"), /--limit must be a positive whole number/);
  await assert.rejects(run("waitlist", "export", "--apply"), /usage:/, "a scan switch is not an export filter");
});

test("scan: --all-live --dry-run counts a would-be flag and writes nothing; --unscanned backfills; --apply flags", { skip: skipStores }, async () => {
  const { db } = await import("../db");
  const { scans, sites } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const drill = (await scanDrill)!;
  const { readFileSync } = await import("node:fs");
  const p4 = `${readFileSync(new URL("../scan/fixtures/obfuscated-eval-base64.html", import.meta.url), "utf8")}\n<!-- ${RUN} -->\n`;
  const statusOf = async (siteId: string) => (await db.select().from(sites).where(eq(sites.id, siteId)))[0]?.status;
  const scansOf = (versionId: string) => db.select().from(scans).where(eq(scans.versionId, versionId));

  // The newest live page (activated an hour ahead), so `--all-live --limit 1` takes it.
  const flaggable = await drill.page(p4, new Date(Date.now() + 60 * 60 * 1000));

  const dry = await run("scan", "--all-live", "--dry-run", "--limit", "1");
  assert.ok(dry.info.some((line) => line.startsWith("database: ")));
  assert.ok(dry.info.some((line) => line.startsWith("scanner: ")), "says whether the classifier runs");
  assert.match(dry.out.join("\n"), new RegExp(`^would flag: ${flaggable.slug} — P\\d \\w+$`, "m"));
  assert.equal(dry.out.at(-1), "dry run: 1 live page(s), 1 would be flagged, 0 could not be fully judged — nothing written, no status changed");
  assert.equal(await statusOf(flaggable.siteId), "live", "a dry run changes no status");
  assert.equal((await scansOf(flaggable.versionId)).length, 0, "a dry run writes no scans row");

  // Unscanned and current since a moment ago: the newest one `--unscanned` sees.
  const unscanned = await drill.page(`<!doctype html><title>e07-007 cli</title><p>${RUN}</p>`, new Date(Date.now() - 1_000));
  const backfilled = await run("scan", "--unscanned", "--limit", "1");
  assert.match(backfilled.out.at(-1)!, /^scanned 1 page\(s\): \d done, \d skipped, 0 failed, 0 not started; 0 flagged$/);
  const [row] = await scansOf(unscanned.versionId);
  assert.equal(row?.trigger, "backfill");
  assert.ok(row?.status === "done" || row?.status === "skipped", row?.status);

  const applied = await run("scan", "--all-live", "--apply", "--limit", "1");
  assert.match(applied.out.join("\n"), new RegExp(`^flagged: ${flaggable.slug} — P\\d \\w+$`, "m"));
  assert.match(applied.out.at(-1)!, /^scanned 1 page\(s\): .*; 1 flagged$/);
  assert.equal(await statusOf(flaggable.siteId), "under_review");
  assert.equal((await scansOf(flaggable.versionId))[0]?.trigger, "backfill");
});

test("waitlist export and stats: CSV with filters, counts by state/source", { skip: skipLive }, async () => {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const before = await run("waitlist", "stats");

  const now = new Date("2026-10-02T03:04:05.000Z");
  const confirmed = address("confirmed");
  const unsubscribed = address("unsubscribed");
  const pending = address("pending-plain");
  const approved = address("approved");
  const legacy = address("legacy");
  await db.insert(waitlist).values([
    { email: confirmed, source: "landing_drop", confirmedAt: now },
    { email: unsubscribed, source: "landing_nav", confirmedAt: now, unsubscribedAt: now },
    { email: pending, source: "landing_notify" },
    {
      email: approved,
      source: "admin",
      foundingStatus: "approved",
      socialUrl: 'https://example.com/a,b?q="x"',
    },
    { email: legacy, source: "legacy" },
  ]);

  const listed = [confirmed, unsubscribed, pending, approved, legacy];
  const mine = (lines: string[]) => lines.filter((line) => listed.some((email) => line.startsWith(`${email},`)));

  const all = await run("waitlist", "export");
  assert.equal(all.out[0], "email,source,confirmed_at,founding_status,social_url");
  const allMine = mine(all.out);
  assert.equal(allMine.length, 5, "every row, unfiltered");
  assert.ok(allMine.includes(`${confirmed},landing_drop,2026-10-02T03:04:05.000Z,,`));
  assert.ok(allMine.includes(`${approved},admin,,approved,"https://example.com/a,b?q=""x"""`), "RFC 4180 quoting");
  assert.ok(all.info.some((line) => /^\d+ row\(s\)$/.test(line)), "count on stderr, off the CSV");

  const onlyConfirmed = mine((await run("waitlist", "export", "--confirmed")).out);
  assert.deepEqual(onlyConfirmed, [`${confirmed},landing_drop,2026-10-02T03:04:05.000Z,,`], "unsubscribed and unconfirmed are out");

  const onlyApproved = mine((await run("waitlist", "export", "--founding", "approved")).out);
  assert.equal(onlyApproved.length, 1);
  assert.ok(onlyApproved[0]!.startsWith(`${approved},`));

  assert.deepEqual(mine((await run("waitlist", "export", "--confirmed", "--founding=approved")).out), []);

  const afterStats = await run("waitlist", "stats");
  const count = (lines: string[], label: string) =>
    Number(lines.find((line) => line.startsWith(`  ${label}: `))?.slice(label.length + 4) ?? 0);
  const delta = (label: string) => count(afterStats.out, label) - count(before.out, label);
  assert.ok(afterStats.out[0]!.startsWith("total: "));
  assert.ok(delta("landing_drop/confirmed") >= 1);
  assert.ok(delta("landing_nav/unsubscribed") >= 1);
  assert.ok(delta("landing_notify/pending") >= 1);
  assert.ok(delta("legacy/pending") >= 1, "legacy rows are counted");
  assert.ok(delta("approved") >= 1, "founding status is counted");
});
