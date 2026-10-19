/**
 * Appeals (E07 task 004, §6.10): `submitAppeal` and its limits, the grant and
 * reject decisions, and the two routes' answers through `./appeal-http.ts`.
 *
 * NO MOCKS. Real dev Postgres; real Resend (every owner and the admin list are
 * `delivered+…@resend.dev`, Resend's test inbox — no mail reaches a person);
 * one real `syncManifest` for the granted appeal. Every other step writes only
 * Postgres. KV: one write for the grant, one delete in `after`.
 *
 * SKIPS without the database or the dev store credentials (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  APPEAL_MESSAGE_MIN,
  APPEALS_PER_SITE_WINDOW,
  appealErrorSchema,
  appealResultSchema,
  DRAFT_GRACE_DAYS,
  generateAnonToken,
  hashToken,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { appeals, moderationActions, sites, user } from "../db/schema";
import { removeManifest } from "../storage/manifest";
import { NamesDrill } from "../testing/names-drill";
import { stillServed } from "../testing/moderation-drill";
import { clearPendingPurges } from "../testing/pending-purges";

import { appealAnonSite, appealOwnedSite } from "./appeal-http";
import { grantAppeal, rejectAppeal, submitAppeal } from "./appeals";

config({ path: ".env.local", quiet: true });

const RUN = crypto.randomUUID().slice(0, 8);
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-004-admin-${RUN}@resend.dev`;

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
const MESSAGE = "This is my own sign-in page for my own app, please take another look.";
const drill = new NamesDrill("e07-004a");
const siteIds = new Set<string>();
const slugs = new Set<string>();

after(async () => {
  if (skip) return;
  if (siteIds.size > 0) {
    // Only the granted page was ever given a manifest.
    for (const slug of await stillServed([...siteIds])) await removeManifest(slug).catch(() => undefined);
    await db.delete(moderationActions).where(inArray(moderationActions.siteId, [...siteIds]));
    await clearPendingPurges(slugs, siteIds);
  }
  await drill.cleanup();
  await closeDb();
});

async function restricted(
  status: SiteStatus,
  options: { reason?: ModerationReason; anonymous?: boolean; purgeAfter?: Date | null } = {},
) {
  const ownerId = await drill.profile();
  await db
    .update(user)
    .set({ email: `delivered+e07-004a-${RUN}-${ownerId.slice(0, 8)}@resend.dev` })
    .where(eq(user.id, ownerId));
  const site = await drill.site({ ownerId, status, kept: true });
  siteIds.add(site.id);
  slugs.add(site.slug);
  const token = generateAnonToken();
  await db
    .update(sites)
    .set({
      moderationReason: status === "live" ? null : (options.reason ?? "phishing"),
      ...(options.purgeAfter !== undefined ? { purgeAfter: options.purgeAfter } : {}),
      ...(options.anonymous ? { ownerId: null, anonTokenHash: await hashToken(token) } : {}),
    })
    .where(eq(sites.id, site.id));
  return { ...site, ownerId, token };
}

async function body(response: Response) {
  return (await response.json()) as unknown;
}

test("submit: allowed only on a restricted page; one open at a time; 3 per 30 days", { skip }, async () => {
  const live = await restricted("live");
  assert.deepEqual(await submitAppeal(live.id, MESSAGE, live.ownerId), { ok: false, refusal: "not_restricted" });

  const flagged = await restricted("under_review");
  const first = await submitAppeal(flagged.id, MESSAGE, flagged.ownerId);
  assert.ok(first.ok);
  assert.deepEqual(await submitAppeal(flagged.id, MESSAGE, flagged.ownerId), { ok: false, refusal: "appeal_open" });

  // Rejected, re-appealed, until the window's limit.
  const admin = flagged.ownerId;
  let open: string = first.appealId;
  for (let n = 2; n <= APPEALS_PER_SITE_WINDOW.limit; n++) {
    const rejected = await rejectAppeal(open, admin, "Still asks for a password that isn't yours.");
    assert.ok(rejected.ok);
    assert.equal(rejected.statement, process.env.RESEND_API_KEY ? "sent" : "failed");
    const next = await submitAppeal(flagged.id, MESSAGE, flagged.ownerId);
    assert.ok(next.ok, `appeal ${n}`);
    open = next.appealId;
  }
  assert.ok((await rejectAppeal(open, admin, "No.")).ok);
  const limited = await submitAppeal(flagged.id, MESSAGE, flagged.ownerId);
  assert.equal(limited.ok ? "ok" : limited.refusal, "rate_limited");
  assert.ok(!limited.ok && limited.refusal === "rate_limited");
  assert.ok(limited.retryAfterSeconds > (APPEALS_PER_SITE_WINDOW.days - 1) * 86_400);

  const log = await db.select().from(moderationActions).where(eq(moderationActions.siteId, flagged.id));
  assert.equal(log.filter((a) => a.action === "appeal_rejected").length, APPEALS_PER_SITE_WINDOW.limit);
});

test("two submissions at once: exactly one is recorded", { skip }, async () => {
  const hidden = await restricted("quarantined");
  const results = await Promise.all([
    submitAppeal(hidden.id, MESSAGE, hidden.ownerId),
    submitAppeal(hidden.id, MESSAGE, hidden.ownerId),
  ]);
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.refusal)).sort(), ["appeal_open", "ok"]);
  const rows = await db.select().from(appeals).where(eq(appeals.siteId, hidden.id));
  assert.equal(rows.length, 1);
});

test("a removed page is appealable until purge_after, then not found", { skip }, async () => {
  const inGrace = await restricted("removed", { purgeAfter: new Date(Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY) });
  assert.ok((await submitAppeal(inGrace.id, MESSAGE, inGrace.ownerId)).ok);
  const purged = await restricted("removed", { purgeAfter: new Date(Date.now() - MS_PER_DAY) });
  assert.deepEqual(await submitAppeal(purged.id, MESSAGE, purged.ownerId), { ok: false, refusal: "not_found" });
});

test("grant restores the page and marks the appeal; reject needs a note and only an open appeal", { skip }, async () => {
  const hidden = await restricted("quarantined", { reason: "scam" });
  const submitted = await submitAppeal(hidden.id, MESSAGE, hidden.ownerId);
  assert.ok(submitted.ok);

  assert.deepEqual(await rejectAppeal(submitted.appealId, hidden.ownerId, "   "), { ok: false, refusal: "note_required" });

  const granted = await grantAppeal(submitted.appealId, hidden.ownerId, "Looks legitimate.");
  console.log(`[appeals] grant → ${JSON.stringify(granted)}`);
  assert.ok(granted.ok);
  assert.equal((await drill.read(hidden.id)).status, "live");
  const [appeal] = await db.select().from(appeals).where(eq(appeals.id, submitted.appealId));
  assert.equal(appeal?.status, "granted");
  assert.ok(appeal?.decidedAt);

  assert.deepEqual(await rejectAppeal(submitted.appealId, hidden.ownerId, "Too late."), {
    ok: false,
    refusal: "appeal_not_open",
  });
  const again = await grantAppeal(submitted.appealId, hidden.ownerId, "Twice.");
  assert.equal(again.ok ? "ok" : again.refusal, "appeal_not_open");
});

test("studio route: 201, 400, 409s, and 'not yours' reads exactly as 'not there'", { skip }, async () => {
  const flagged = await restricted("under_review");
  const stranger = await drill.profile();

  const created = await appealOwnedSite(flagged.id, { message: MESSAGE }, flagged.ownerId);
  assert.equal(created.status, 201);
  assert.ok(appealResultSchema.safeParse(await body(created)).success);
  assert.equal(created.headers.get("cache-control"), "no-store");

  const open = await appealOwnedSite(flagged.id, { message: MESSAGE }, flagged.ownerId);
  assert.equal(open.status, 409);
  assert.equal(appealErrorSchema.parse(await body(open)).error.code, "appeal_open");

  const short = await appealOwnedSite(flagged.id, { message: "x".repeat(APPEAL_MESSAGE_MIN - 1) }, flagged.ownerId);
  assert.equal(short.status, 400);
  assert.equal(appealErrorSchema.parse(await body(short)).error.code, "invalid");

  const theirs = await appealOwnedSite(flagged.id, { message: MESSAGE }, stranger);
  const nothing = await appealOwnedSite(crypto.randomUUID(), { message: MESSAGE }, stranger);
  const malformed = await appealOwnedSite("not-a-uuid", { message: MESSAGE }, stranger);
  assert.equal(theirs.status, 404);
  const theirsText = await theirs.text();
  assert.equal(theirsText, await nothing.text());
  assert.equal(theirsText, await malformed.text());
});

test("token route: the restricted page answers; unknown, archived, expired and purged are one 404", { skip }, async () => {
  const flagged = await restricted("under_review", { anonymous: true });
  const created = await appealAnonSite(flagged.token, { message: MESSAGE });
  assert.equal(created.status, 201);
  const [row] = await db.select().from(appeals).where(eq(appeals.siteId, flagged.id));
  assert.equal(row?.submittedByUserId, null, "null = sent through the token");

  const live = await restricted("live", { anonymous: true });
  const notRestricted = await appealAnonSite(live.token, { message: MESSAGE });
  assert.equal(notRestricted.status, 409);
  assert.equal(appealErrorSchema.parse(await body(notRestricted)).error.code, "not_restricted");

  const unknown = await (await appealAnonSite(generateAnonToken(), { message: MESSAGE })).text();
  for (const [status, purgeAfter] of [
    ["archived", undefined],
    ["expired", undefined],
    ["removed", new Date(Date.now() - MS_PER_DAY)],
  ] as const) {
    const gone = await restricted(status, { anonymous: true, purgeAfter });
    const response = await appealAnonSite(gone.token, { message: MESSAGE });
    assert.equal(response.status, 404, status);
    assert.equal(await response.text(), unknown, `${status} reads exactly as an unknown token`);
  }

  const limited = await restricted("quarantined", { anonymous: true });
  await db.insert(appeals).values(
    Array.from({ length: APPEALS_PER_SITE_WINDOW.limit }, () => ({
      siteId: limited.id,
      message: MESSAGE,
      status: "rejected" as const,
      decidedAt: new Date(),
    })),
  );
  const tooMany = await appealAnonSite(limited.token, { message: MESSAGE });
  assert.equal(tooMany.status, 429);
  const parsed = appealErrorSchema.parse(await body(tooMany));
  assert.equal(parsed.error.code, "rate_limited");
  assert.equal(tooMany.headers.get("retry-after"), String(parsed.retry_after_seconds));
});
