/**
 * Handles (E10 task 008: D9, D10, AC15, AC16, Q2, Q22) against the REAL dev
 * stack — no mocks. Profiles, pages, holds and redirect rows are real Postgres
 * rows (`NamesDrill`); a handle CHANGE writes a real redirect manifest (R2
 * pointer → KV → purge), read back here from the pointer, which carries the
 * very bytes KV got (`writeRedirectManifest`'s one serialization).
 *
 * KV cost: two redirect writes and two deletes (the take-back's removal and
 * the teardown's). The Worker's 301 is the e2e's (`@edge`, after the rc deploy).
 *
 * SKIPS without dev credentials (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

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
const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip = missing.length > 0 ? `dev credentials absent (${missing.join(", ")})` : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Redirect manifests this file wrote, removed in `after`. */
const redirects = new Set<string>();
let drill: import("../testing/names-drill").NamesDrill | null = null;

async function names() {
  const { NamesDrill } = await import("../testing/names-drill");
  drill ??= new NamesDrill("e10-008-h");
  return drill;
}

after(async () => {
  if (skip) return;
  const { removeManifest } = await import("../storage/manifest");
  const { closeDb } = await import("../db");
  for (const name of redirects) await removeManifest(name);
  await drill?.cleanup();
  await closeDb();
});

async function owner(id: string) {
  const { db } = await import("../db");
  const { profiles } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(profiles).where(eq(profiles.id, id));
  return row!;
}

/** The hold on `name`: its owner, its reason, and whether it never ends. */
async function holdOn(name: string) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const [row] = await db.execute<{ user_id: string | null; reason: string; forever: boolean }>(
    sql`select user_id, reason, held_until = 'infinity'::timestamptz as forever from name_holds where name = ${name}`,
  );
  return row ?? null;
}

async function redirectRow(name: string) {
  const { db } = await import("../db");
  const { handleRedirects } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(handleRedirects).where(eq(handleRedirects.oldHandle, name));
  return row ?? null;
}

/** The redirect the edge reads for `name` — the pointer, byte-identical to KV. */
async function redirectAt(name: string) {
  const { r2Store } = await import("../storage/r2");
  const { pointerKey } = await import("../storage/manifest");
  const { kvEntrySchema, isRedirectManifest } = await import("@kept/shared");
  const body = await r2Store().get(pointerKey(name));
  if (body === null) return null;
  const entry = kvEntrySchema.parse(JSON.parse(body));
  assert.ok(isRedirectManifest(entry), `"${name}" holds a page manifest, not a redirect`);
  return entry.redirectTo;
}

async function rewindChange(profileId: string, days: number) {
  const { db } = await import("../db");
  const { profiles } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  await db
    .update(profiles)
    .set({ handleChangedAt: new Date(Date.now() - days * MS_PER_DAY) })
    .where(eq(profiles.id, profileId));
}

test("nextHandleChangeOn: HANDLE_CHANGE_DAYS later, rounded up to the next UTC midnight", async () => {
  const { nextHandleChangeOn, handleChangeBlockedUntil } = await import("./handle");
  assert.equal(nextHandleChangeOn(new Date("2026-10-29T10:15:00Z")), "2026-11-29");
  assert.equal(nextHandleChangeOn(new Date("2026-10-29T00:00:00Z")), "2026-11-28");

  const base = { id: "x", plan: "free" as const, handle: "someone" };
  assert.equal(handleChangeBlockedUntil({ ...base, handleChangedAt: null }), null, "never changed");
  assert.equal(
    handleChangeBlockedUntil({ ...base, handle: null, handleChangedAt: new Date() }),
    null,
    "no handle yet",
  );
  const changed = new Date("2026-10-29T10:15:00Z");
  assert.equal(handleChangeBlockedUntil({ ...base, handleChangedAt: changed }, new Date("2026-11-28T23:59:59Z")), "2026-11-29");
  assert.equal(handleChangeBlockedUntil({ ...base, handleChangedAt: changed }, new Date("2026-11-29T00:00:00Z")), null);
});

test("checkHandle: the name rule (free ≥ 5, Pro ≥ 4, reserved) and the shared namespace (AC15)", { skip }, async () => {
  const { checkHandle } = await import("./handle");
  const d = await names();
  const freeId = await d.profile("free");
  const proId = await d.profile("premium");
  const other = await d.profile();
  const page = await d.site({ ownerId: other });

  const free = await owner(freeId);
  const pro = await owner(proId);
  assert.equal((await checkHandle("abcd", free)).status, "pro_length", "a free 4-letter handle is Pro's");
  assert.equal((await checkHandle("abc", free)).status, "too_short");
  assert.notEqual((await checkHandle("abcd", pro)).status, "pro_length", "Pro may have 4 letters");
  assert.equal((await checkHandle("admin", free)).status, "reserved");
  assert.equal((await checkHandle("Bad_Name", free)).status, "invalid");
  assert.equal((await checkHandle(page.slug, free)).status, "taken", "a handle can't take a page name");
  assert.equal((await checkHandle(d.name(), free)).status, "available");
});

test("set a first handle, change it, refuse a second change, take the old one back", { skip }, async () => {
  const { checkHandle, setHandle } = await import("./handle");
  const { isNameAvailable } = await import("../names/availability");
  const { namespaceVerdict } = await import("../names/check");
  const { db } = await import("../db");
  const { StudioRefusal } = await import("../sites/studio-refusal");
  const d = await names();
  const me = await d.profile();
  const stranger = await d.profile();
  const first = d.name();
  const second = d.name();
  const third = d.name();

  // ── A first handle: no change stamped, no hold, no redirect, nothing at the edge.
  assert.deepEqual(await setHandle(me, first), { handle: first, nextChangeOn: null });
  assert.equal((await owner(me)).handleChangedAt, null, "setting a first handle is not a change");
  assert.equal(await holdOn(first), null);
  assert.equal(await redirectAt(first), null);

  // AC15 / edge case 7: nobody else's page or handle can take it; Q22: it is
  // `held_for_you` for its owner (E12's wall row).
  assert.equal(await isNameAvailable(first, stranger), "taken");
  assert.equal(await isNameAvailable(first, null), "taken", "the generated-name mint skips it");
  assert.equal(await isNameAvailable(first, me), "held_for_you");
  const verdict = await namespaceVerdict(db, { name: first, userId: stranger, plan: "free", nameKind: "generated" });
  assert.equal(verdict.status, "taken", "a stranger's page rename to it is refused");
  assert.equal((await checkHandle(first, await owner(stranger))).status, "taken");
  assert.equal((await checkHandle(first, await owner(me))).status, "available", "its own handle is the no-op");

  // ── The first change: the old handle is held forever for me and redirects.
  redirects.add(first);
  const changed = await setHandle(me, second);
  assert.equal(changed.handle, second);
  assert.ok(changed.nextChangeOn, "a change starts the 30-day clock");
  assert.ok((await owner(me)).handleChangedAt, "handle_changed_at stamped");
  assert.deepEqual(await holdOn(first), { user_id: me, reason: "renamed", forever: true });
  assert.equal((await redirectRow(first))?.profileId, me);
  assert.equal(await redirectAt(first), second, "the old host's redirect manifest points at the new handle");
  // An old handle answers with a redirect, so no page may sit on it — its
  // owner's included — and the 'infinity' hold reads as unexpired.
  assert.equal(await isNameAvailable(first, me), "taken");
  assert.equal(await isNameAvailable(first, stranger), "taken");

  // ── AC16: a second change inside the window is refused, nothing written.
  const limited = await checkHandle(third, await owner(me));
  assert.deepEqual(limited, { status: "handle_change_limited", availableOn: changed.nextChangeOn });
  await assert.rejects(setHandle(me, third), (err: unknown) => {
    assert.ok(err instanceof StudioRefusal);
    assert.equal(err.code, "handle_change_limited");
    assert.match(err.message, /^You can change your handle again on /);
    return true;
  });
  assert.equal((await owner(me)).handle, second);

  // ── Past the window, take the old handle back: its redirect row and hold go
  // in the same transaction (it would redirect to itself), its manifest is
  // removed, and the handle just left redirects to it.
  await rewindChange(me, 31);
  assert.equal((await checkHandle(first, await owner(me))).status, "held_for_you");
  assert.equal((await checkHandle(first, await owner(stranger))).status, "taken");
  redirects.add(second);
  await setHandle(me, first);
  assert.equal((await owner(me)).handle, first);
  assert.equal(await redirectRow(first), null);
  assert.equal(await holdOn(first), null);
  assert.equal(await redirectAt(first), null, "the taken-back handle no longer redirects");
  redirects.delete(first);
  assert.equal(await redirectAt(second), first);
  assert.deepEqual(await holdOn(second), { user_id: me, reason: "renamed", forever: true });
});
