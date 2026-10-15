/**
 * `setStatus` (E07 task 004): the transition table, D4 (AC9), the D19 name hold
 * (AC36), the restore clock rules, the flagged-version restore (edge case 4)
 * and the action row + statement of reasons (AC14).
 *
 * NO MOCKS. Real dev Postgres for every row; real `syncManifest` (R2 pointer +
 * KV + purge) for every change that commits; real Resend for every mail.
 *
 * MAIL. Every drill owner is a `delivered+…@resend.dev` address
 * (Resend's test inbox) and `KEPT_ADMIN_EMAILS` is pointed at one too, below,
 * so no alert reaches a person. Without `RESEND_API_KEY` the sends fail and the
 * result says `failed` — asserted as such, with the reason logged.
 *
 * KV QUOTA (dev free plan): refusals write nothing; each committed change is
 * one KV write or delete, plus one delete per page left with a manifest in
 * `after`. About 20 KV operations for the file.
 *
 * SKIPS without the database or the dev store credentials (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, limitsFor, SCAN_POLICY_VERSION, type SiteStatus } from "@kept/shared";
import { config } from "dotenv";
import { and, eq, inArray, or } from "drizzle-orm";

import { closeDb, db } from "../db";
import { appeals, moderationActions, nameHolds, pendingPurges, scans, sites, siteVersions, user } from "../db/schema";
import { isNameAvailable } from "../names/availability";
import { restoreVersion } from "../sites/restore";
import { removeManifest } from "../storage/manifest";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } from "../storage/r2";
import { NamesDrill } from "../testing/names-drill";
import { stillServed } from "../testing/moderation-drill";

import { isAllowedTransition, lastVerdictFor, setStatus } from "./status";

config({ path: ".env.local", quiet: true });

const RUN = crypto.randomUUID().slice(0, 8);
// Operator alerts go to Resend's test inbox, never to a person.
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-004-admin-${RUN}@resend.dev`;
const mailOn = Boolean(process.env.RESEND_API_KEY);
if (!mailOn) console.log("[status] RESEND_API_KEY absent: statement sends are expected to report `failed`");

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
const missing = LIVE_VARS.filter((name) => !process.env[name]);
const skip = missing.length > 0 ? `dev credentials absent (${missing.join(", ")})` : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const drill = new NamesDrill("e07-004");
const siteIds = new Set<string>();
const slugs = new Set<string>();
const r2Keys = new Set<string>();

after(async () => {
  if (skip) return;
  if (siteIds.size > 0) {
    // Only a page a committed change synced has a manifest; only one still
    // served costs a KV delete. (Never the quota fillers — 50 deletes.)
    for (const slug of await stillServed([...siteIds])) await removeManifest(slug).catch(() => undefined);
    await db.delete(moderationActions).where(inArray(moderationActions.siteId, [...siteIds]));
    await db
      .delete(pendingPurges)
      .where(or(inArray(pendingPurges.siteId, [...siteIds]), inArray(pendingPurges.slug, [...slugs])));
  }
  for (const key of r2Keys) await r2Store().delete(key).catch(() => undefined);
  await drill.cleanup();
  await closeDb();
});

/** A page in `status`, tracked for teardown. Owned and kept unless told otherwise. */
async function page(options: {
  status?: SiteStatus;
  kept?: boolean;
  anonymous?: boolean;
  chosen?: boolean;
  expiresAt?: Date;
}) {
  const ownerId = await drill.profile();
  // Resend's test inbox: a statement to the drill's `.invalid` address would bounce.
  await db
    .update(user)
    .set({ email: `delivered+e07-004-${RUN}-${ownerId.slice(0, 8)}@resend.dev` })
    .where(eq(user.id, ownerId));
  const site = await drill.site({
    ownerId,
    kept: options.kept ?? true,
    status: options.status ?? "live",
    nameKind: options.chosen ? "chosen" : "generated",
  });
  siteIds.add(site.id);
  slugs.add(site.slug);
  if (options.anonymous) await db.update(sites).set({ ownerId: null }).where(eq(sites.id, site.id));
  if (options.expiresAt) {
    await db
      .update(sites)
      .set({ expiresAt: options.expiresAt, purgeAfter: new Date(options.expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY) })
      .where(eq(sites.id, site.id));
  }
  return { ...site, ownerId: options.anonymous ? null : ownerId };
}

async function actionsFor(siteId: string) {
  return db.select().from(moderationActions).where(eq(moderationActions.siteId, siteId));
}

function near(actual: Date | null, expected: Date, toleranceMs = 60_000): void {
  assert.ok(actual, "expected a date");
  assert.ok(Math.abs(actual.getTime() - expected.getTime()) < toleranceMs, `${actual.toISOString()} ≉ ${expected.toISOString()}`);
}

test("the transition table (§6.7), as data", () => {
  assert.equal(isAllowedTransition("live", "under_review", "scanner", "phishing"), true);
  assert.equal(isAllowedTransition("live", "under_review", "admin", "phishing"), true);
  assert.equal(isAllowedTransition("under_review", "under_review", "scanner", "phishing"), false);
  assert.equal(isAllowedTransition("live", "quarantined", "admin", "scam"), true);
  assert.equal(isAllowedTransition("under_review", "quarantined", "report", "child_sexual_abuse"), true);
  assert.equal(isAllowedTransition("live", "quarantined", "report", "phishing"), false, "only CSAM hides on report");
  assert.equal(isAllowedTransition("quarantined", "quarantined", "admin", "scam"), false);
  for (const from of ["live", "under_review", "quarantined", "expired", "archived"] as const) {
    assert.equal(isAllowedTransition(from, "removed", "admin", "scam"), true, from);
  }
  assert.equal(isAllowedTransition("removed", "removed", "admin", "scam"), false);
  assert.equal(isAllowedTransition("live", "removed", "report", "child_sexual_abuse"), false);
  for (const from of ["under_review", "quarantined", "removed"] as const) {
    assert.equal(isAllowedTransition(from, "live", "admin", undefined), true, from);
    assert.equal(isAllowedTransition(from, "live", "scanner", undefined), false, from);
  }
  assert.equal(isAllowedTransition("expired", "live", "admin", undefined), false);
  assert.equal(isAllowedTransition("archived", "live", "admin", undefined), false);
});

test("AC9 (D4): the scanner changes nothing but live → under_review on the current version", { skip }, async () => {
  const flagged = await page({ status: "under_review" });
  await db.update(sites).set({ moderationReason: "phishing" }).where(eq(sites.id, flagged.id));
  const [row] = await db.select({ v: sites.currentVersionId }).from(sites).where(eq(sites.id, flagged.id));
  const versionId = row!.v!;

  // Not live: refused, nothing written.
  const notLive = await setStatus(flagged.id, "under_review", { actor: "scanner", versionId, reason: "scam", automated: true });
  assert.deepEqual(notLive.ok ? null : notLive.refusal, "not_allowed");

  const live = await page({});
  const [liveRow] = await db.select({ v: sites.currentVersionId }).from(sites).where(eq(sites.id, live.id));
  const liveVersion = liveRow!.v!;
  // Any other target: refused before the database is read.
  for (const to of ["quarantined", "removed", "live"] as const) {
    const result = await setStatus(live.id, to, { actor: "scanner", versionId: liveVersion, reason: "phishing", automated: true });
    assert.equal(result.ok ? "ok" : result.refusal, "not_allowed", to);
  }
  // Edge case 3: the version it scanned was replaced meanwhile.
  const stale = await setStatus(live.id, "under_review", {
    actor: "scanner",
    versionId: crypto.randomUUID(),
    reason: "phishing",
    automated: true,
  });
  assert.equal(stale.ok ? "ok" : stale.refusal, "not_current_version");
  // A restriction without a reason.
  const noReason = await setStatus(live.id, "quarantined", { actor: "admin", automated: false });
  assert.equal(noReason.ok ? "ok" : noReason.refusal, "reason_required");

  for (const id of [flagged.id, live.id]) {
    assert.deepEqual(await actionsFor(id), [], "a refusal writes no action");
  }
  assert.equal((await drill.read(flagged.id)).status, "under_review");
  assert.equal((await drill.read(flagged.id)).moderationReason, "phishing");
  assert.equal((await drill.read(live.id)).status, "live");
  assert.equal((await drill.read(live.id)).moderationReason, null);

  // The one edge it has: flag, record, manifest, mail, PRIORITY-less alert.
  const flag = await setStatus(live.id, "under_review", {
    actor: "scanner",
    versionId: liveVersion,
    reason: "phishing",
    automated: true,
  });
  console.log(`[status] scanner flag → ${JSON.stringify(flag)}`);
  assert.ok(flag.ok);
  assert.equal(flag.manifest.ok && flag.manifest.outcome, "written");
  assert.equal(flag.alert, mailOn ? "sent" : "failed");
  const after = await drill.read(live.id);
  assert.equal(after.status, "under_review");
  assert.equal(after.moderationReason, "phishing");
  const [action] = await actionsFor(live.id);
  assert.equal(action?.actor, "scanner");
  assert.equal(action?.action, "flag");
  assert.equal(action?.fromStatus, "live");
  assert.equal(action?.toStatus, "under_review");
  assert.equal(action?.automated, true);
});

test("AC36 (D19): removal holds the name with no owner; restore lifts it; re-removal holds it again", { skip }, async () => {
  const chosen = await page({ chosen: true });
  const stranger = await drill.profile();

  const removed = await setStatus(chosen.id, "removed", { actor: "admin", reason: "phishing", automated: false, note: "Fake bank login." });
  console.log(`[status] remove → ${JSON.stringify(removed)}`);
  assert.ok(removed.ok);
  assert.equal(removed.manifest.ok && removed.manifest.outcome, "removed");
  assert.equal(removed.statement, mailOn ? "sent" : "failed");
  assert.equal(removed.alert, null, "a person's action sends no operator alert");

  const row = await drill.read(chosen.id);
  assert.equal(row.status, "removed");
  assert.equal(row.moderationReason, "phishing");
  near(row.purgeAfter, new Date(Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY));
  const hold = await drill.holdOf(chosen.slug);
  assert.equal(hold?.userId, null);
  assert.equal(hold?.reason, "removed");
  assert.equal(hold?.siteId, chosen.id);
  // The last owner, the anonymous mint (the original publisher's next publish) and a stranger.
  assert.equal(await isNameAvailable(chosen.slug, chosen.ownerId), "taken");
  assert.equal(await isNameAvailable(chosen.slug, null), "taken");
  assert.equal(await isNameAvailable(chosen.slug, stranger), "taken");

  const restored = await setStatus(chosen.id, "live", { actor: "admin", automated: false, note: "False positive." });
  assert.ok(restored.ok);
  assert.equal(restored.manifest.ok && restored.manifest.outcome, "written");
  assert.equal(await drill.holdOf(chosen.slug), null, "restore lifts the removed hold");
  const back = await drill.read(chosen.id);
  assert.equal(back.status, "live");
  assert.equal(back.moderationReason, null);
  assert.equal(back.purgeAfter, null, "a kept page loses the removal's purge_after");
  assert.equal(back.expiresAt, null);

  const again = await setStatus(chosen.id, "removed", { actor: "admin", reason: "phishing", automated: false });
  assert.ok(again.ok);
  assert.equal((await drill.holdOf(chosen.slug))?.reason, "removed");
  assert.equal(await isNameAvailable(chosen.slug, chosen.ownerId), "taken");

  // A generated name on an anonymous draft is held too.
  const anon = await page({ anonymous: true, kept: false });
  const anonRemoved = await setStatus(anon.id, "removed", { actor: "admin", reason: "spam", automated: false });
  assert.ok(anonRemoved.ok);
  assert.equal(anonRemoved.statement, "no_recipient", "edge case 20: no address, no mail");
  assert.equal((await drill.holdOf(anon.slug))?.reason, "removed");
  assert.equal(await isNameAvailable(anon.slug, null), "taken");

  const log = await actionsFor(chosen.id);
  assert.deepEqual(
    log.map((a) => a.action).sort(),
    ["remove", "remove", "restore"],
  );
});

test("restore refuses when another page took the name, and writes nothing", { skip }, async () => {
  const gone = await page({ status: "removed" });
  await db.update(sites).set({ moderationReason: "scam" }).where(eq(sites.id, gone.id));
  // Bypass the hold the way only a bug could: another active page on the name.
  const taker = await drill.site({ ownerId: await drill.profile(), slug: gone.slug });
  siteIds.add(taker.id);
  const result = await setStatus(gone.id, "live", { actor: "admin", automated: false });
  assert.equal(result.ok ? "ok" : result.refusal, "slug_taken");
  assert.equal((await drill.read(gone.id)).status, "removed");
  assert.deepEqual(await actionsFor(gone.id), []);
});

test("restore clocks (§6.7, edge cases 15 and 23)", { skip }, async () => {
  const now = Date.now();

  // A draft whose clock is still running keeps it.
  const running = new Date(now + 3 * MS_PER_DAY);
  const draft = await page({ status: "under_review", kept: false, expiresAt: running });
  const r1 = await setStatus(draft.id, "live", { actor: "admin", automated: false });
  assert.ok(r1.ok);
  const d1 = await drill.read(draft.id);
  assert.equal(d1.expiresAt?.getTime(), running.getTime());
  assert.equal(d1.purgeAfter?.getTime(), running.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY);

  // A draft whose clock ran out while it was hidden gets a fresh one.
  const ranOut = await page({ status: "quarantined", kept: false, expiresAt: new Date(now - MS_PER_DAY) });
  const r2 = await setStatus(ranOut.id, "live", { actor: "admin", automated: false });
  assert.ok(r2.ok);
  const d2 = await drill.read(ranOut.id);
  near(d2.expiresAt, new Date(now + DRAFT_TTL_DAYS * MS_PER_DAY));
  near(d2.purgeAfter, new Date(now + (DRAFT_TTL_DAYS + DRAFT_GRACE_DAYS) * MS_PER_DAY));

  // A removed draft: its purge_after is recomputed from its clock, not the removal's.
  const removedDraft = await page({ status: "removed", kept: false, expiresAt: running });
  await db.update(sites).set({ purgeAfter: new Date(now + DRAFT_GRACE_DAYS * MS_PER_DAY) }).where(eq(sites.id, removedDraft.id));
  const r3 = await setStatus(removedDraft.id, "live", { actor: "admin", automated: false });
  assert.ok(r3.ok);
  assert.equal((await drill.read(removedDraft.id)).purgeAfter?.getTime(), running.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY);

  // A removed KEPT page comes back kept even with the owner at the cap.
  const capped = await page({ status: "removed" });
  await db.update(sites).set({ purgeAfter: new Date(now + DRAFT_GRACE_DAYS * MS_PER_DAY) }).where(eq(sites.id, capped.id));
  const filler = await drill.sites(limitsFor("free").keptPages, { ownerId: capped.ownerId! });
  for (const s of filler) siteIds.add(s.id);
  const r4 = await setStatus(capped.id, "live", { actor: "admin", automated: false });
  assert.ok(r4.ok, JSON.stringify(r4));
  const d4 = await drill.read(capped.id);
  assert.equal(d4.status, "live");
  assert.equal(d4.expiresAt, null, "still kept");
  assert.equal(d4.purgeAfter, null);
});

test("a restore grants the open appeal; a named appeal must still be open", { skip }, async () => {
  const hidden = await page({ status: "quarantined" });
  await db.update(sites).set({ moderationReason: "scam" }).where(eq(sites.id, hidden.id));
  const [appeal] = await db
    .insert(appeals)
    .values({ siteId: hidden.id, submittedByUserId: hidden.ownerId, message: "This is my own shop page, please look again." })
    .returning({ id: appeals.id });

  const wrong = await setStatus(hidden.id, "live", { actor: "admin", automated: false, appealId: crypto.randomUUID() });
  assert.equal(wrong.ok ? "ok" : wrong.refusal, "appeal_not_open");
  assert.equal((await drill.read(hidden.id)).status, "quarantined", "nothing written");

  const granted = await setStatus(hidden.id, "live", { actor: "admin", automated: false, note: "Legit shop.", appealId: appeal!.id });
  assert.ok(granted.ok);
  const [decided] = await db.select().from(appeals).where(eq(appeals.id, appeal!.id));
  assert.equal(decided?.status, "granted");
  assert.equal(decided?.decisionNote, "Legit shop.");
  const [action] = await actionsFor(hidden.id);
  assert.equal(action?.action, "appeal_granted");
  assert.equal(action?.appealId, appeal!.id);
  assert.equal(action?.reason, "scam", "a restore records what it was restored from");
});

test("edge case 4: restoring a version whose last scan flagged goes straight to under_review", { skip }, async () => {
  const owned = await page({});
  const flaggedVersion = crypto.randomUUID();
  const r2Key = pageObjectKey(owned.id, flaggedVersion);
  await r2Store().put(r2Key, "<!doctype html><title>old</title><p>old</p>", PAGE_CONTENT_TYPE);
  r2Keys.add(r2Key);
  await db.insert(siteVersions).values({
    id: flaggedVersion,
    siteId: owned.id,
    r2Key,
    contentHash: `e07-004-${flaggedVersion}`,
    sizeBytes: 42,
    activatedAt: new Date(Date.now() - MS_PER_DAY),
  });
  const [scan] = await db
    .insert(scans)
    .values({
      siteId: owned.id,
      versionId: flaggedVersion,
      contentHash: `e07-004-${flaggedVersion}`,
      trigger: "publish",
      status: "done",
      verdict: "flag",
      rule: "P1",
      reason: "phishing",
      policyVersion: SCAN_POLICY_VERSION,
      completedAt: new Date(),
    })
    .returning({ id: scans.id });

  assert.deepEqual(await lastVerdictFor(flaggedVersion), { verdict: "flag", reason: "phishing", scanId: scan!.id });
  assert.equal(await lastVerdictFor(crypto.randomUUID()), null);

  const restored = await restoreVersion(owned.id, flaggedVersion, owned.ownerId!);
  assert.equal(restored.unchanged, false);
  const row = await drill.read(owned.id);
  assert.equal(row.currentVersionId, flaggedVersion);
  assert.equal(row.status, "under_review");
  assert.equal(row.moderationReason, "phishing");
  const [action] = await db
    .select()
    .from(moderationActions)
    .where(and(eq(moderationActions.siteId, owned.id), eq(moderationActions.action, "flag")));
  assert.equal(action?.actor, "scanner");
  assert.equal(action?.scanId, scan!.id);
  // The hold table is untouched by a flag.
  assert.deepEqual(await db.select().from(nameHolds).where(eq(nameHolds.name, owned.slug)), []);
});
