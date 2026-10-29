/**
 * `PATCH /api/profile`'s lib half (E10 task 009: D12, Q4, Q19, AC19) against
 * the REAL dev Neon branch — no mocks. Profiles and pages are real rows
 * (`NamesDrill`); the badge-style fan-out is asserted by the `pending_purges`
 * rows it queues, never at the edge, so this file writes NO KV.
 *
 * SKIPS without `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { PROFILE_BIO_MAX } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";

let drill: import("../testing/names-drill").NamesDrill | null = null;

async function names() {
  const { NamesDrill } = await import("../testing/names-drill");
  drill ??= new NamesDrill("e10-009-p");
  return drill;
}

after(async () => {
  if (skip) return;
  const { closeDb } = await import("../db");
  await drill?.cleanup();
  await closeDb();
});

/** Every queued re-sync naming one of `siteIds`. */
async function queuedSyncs(siteIds: string[]) {
  const { db } = await import("../db");
  const { pendingPurges } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  return db.select().from(pendingPurges).where(inArray(pendingPurges.siteId, siteIds));
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  const { StudioRefusal } = await import("../sites/studio-refusal");
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof StudioRefusal, `expected a studio refusal, got ${String(err)}`);
    return { code: err.code, message: err.message };
  }
  assert.fail("expected the update to be refused");
}

test("validation: bio over 160, an http:// social, an unknown host, an unknown network — refused, nothing written", { skip }, async () => {
  const { updateProfile } = await import("./profile");
  const d = await names();
  const owner = { id: await d.profile(), plan: "free" as const };

  const long = await refusal(() => updateProfile(owner, { bio: "x".repeat(PROFILE_BIO_MAX + 1) }));
  assert.deepEqual(long, { code: "invalid_request", message: `Bios can be up to ${PROFILE_BIO_MAX} characters.` });

  const http = await refusal(() => updateProfile(owner, { socials: { github: "http://github.com/lena" } }));
  assert.equal(http.code, "invalid_request");
  assert.match(http.message, /https:\/\/ link on github\.com/);

  const host = await refusal(() => updateProfile(owner, { socials: { x: "https://evil.example/lena" } }));
  assert.match(host.message, /x\.com or twitter\.com/);

  assert.equal((await refusal(() => updateProfile(owner, { socials: { myspace: "https://myspace.com/x" } }))).code, "invalid_request");
  assert.equal((await refusal(() => updateProfile(owner, {}))).code, "invalid_request", "an empty body is a caller bug");

  const { db } = await import("../db");
  const { profiles } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(profiles).where(eq(profiles.id, owner.id));
  assert.equal(row!.bio, null);
  assert.equal(row!.socials, null);
});

test("name, bio and socials save (display name on Better Auth's user row) and queue no re-sync", { skip }, async () => {
  const { updateProfile } = await import("./profile");
  const d = await names();
  const owner = { id: await d.profile(), plan: "free" as const };
  const page = await d.site({ ownerId: owner.id });

  const saved = await updateProfile(owner, {
    displayName: "  Lena   Park ",
    bio: "I make small pages.",
    socials: { github: "https://github.com/lena", website: "https://lena.example" },
  });
  assert.deepEqual(saved, {
    displayName: "Lena Park",
    bio: "I make small pages.",
    socials: { github: "https://github.com/lena", website: "https://lena.example" },
    badgeStyle: "standard",
  });

  const { db } = await import("../db");
  const { user } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, owner.id));
  assert.equal(u!.name, "Lena Park");

  // `bio: ""` clears it; the socials object replaces the stored one.
  const cleared = await updateProfile(owner, { bio: "", socials: {} });
  assert.equal(cleared.bio, null);
  assert.deepEqual(cleared.socials, {});

  assert.deepEqual(await queuedSyncs([page.id]), [], "nothing the edge shows changed: no KV owed");
});

test("Q19: minimal is Pro — refused on Free; on Pro a style CHANGE queues every kept page, and only a change", { skip }, async () => {
  const { updateProfile, MINIMAL_BADGE_PRO_MESSAGE } = await import("./profile");
  const d = await names();

  const free = { id: await d.profile("free"), plan: "free" as const };
  assert.deepEqual(await refusal(() => updateProfile(free, { badgeStyle: "minimal" })), {
    code: "invalid_request",
    message: MINIMAL_BADGE_PRO_MESSAGE,
  });
  assert.equal((await updateProfile(free, { badgeStyle: "standard" })).badgeStyle, "standard", "standard is anyone's");

  const pro = { id: await d.profile("premium"), plan: "premium" as const };
  const kept = await d.sites(2, { ownerId: pro.id });
  const draft = await d.site({ ownerId: pro.id, kept: false });
  const archived = await d.site({ ownerId: pro.id, status: "archived" });

  assert.equal((await updateProfile(pro, { badgeStyle: "minimal" })).badgeStyle, "minimal");
  const queued = await queuedSyncs([...kept.map((p) => p.id), draft.id, archived.id]);
  assert.deepEqual(
    queued.map((row) => row.siteId).sort(),
    kept.map((p) => p.id).sort(),
    "one re-sync per kept page the edge serves; drafts and archived pages are not",
  );
  for (const row of queued) {
    assert.deepEqual(row.urls, []);
    assert.ok(row.dueAt.getTime() <= Date.now(), "due now");
  }

  // Saving the same style again is not a change: nothing more is queued.
  const { clearPendingPurges } = await import("../testing/pending-purges");
  await clearPendingPurges([], kept.map((p) => p.id));
  await updateProfile(pro, { badgeStyle: "minimal", bio: "Pro." });
  assert.deepEqual(await queuedSyncs(kept.map((p) => p.id)), []);
});
