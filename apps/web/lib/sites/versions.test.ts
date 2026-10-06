/**
 * Versions (D7) — replace no-op, pruning, restore. E06 task 007, PRD acceptance
 * criteria **25–28** (server half) and edge cases 8, 9 and 14.
 *
 * NO MOCKS: real dev Postgres, R2, KV and purge. Every page is published through
 * `publishOwnedPage` (what `POST /api/sites` runs) and changed through
 * `replaceOwnedSite` / `restoreOwnedVersion` — the exact functions the two
 * `route.ts` files delegate to. The status gate and the 404 matrix touch no
 * store and live in `owner-routes.test.ts`; the wire, the origin check and the
 * edge serving the restored bytes are `e2e/owner-replace-api.spec.ts` and
 * `e2e/owner-restore-api.spec.ts`.
 *
 * ⚠️ AC26 SAYS "ASSERT VIA R2 LIST". `R2Store` deliberately has no `list`
 * (edge-purge contract §7.5) and none is added, so a pruned version is asserted
 * gone with `r2Store().get(key) === null` (epic Risk 10; recorded for the PR).
 *
 * ⚠️ EDGE CASE 14 IS DRIVEN FOR REAL. A version row whose `r2_key` is longer
 * than R2's 1,024-byte key limit makes R2 answer the prune's DELETE with HTTP
 * 400 — a genuine store refusal, not a stubbed one.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no
 * secrets — except the source-level AC28 assertion, which needs none. Every row,
 * object and manifest created here is removed in `after`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  hashContent,
  limitsFor,
  replaceResultSchema,
  restoreResultSchema,
  studioErrorSchema,
  type Plan,
  type ReplaceResult,
  type RestoreResult,
} from "@kept/shared";
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
  "NEXT_PUBLIC_APP_URL",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const createdSites = new Set<string>();
const createdSlugs = new Set<string>();
const createdUsers = new Set<string>();

const publisher = { ip: "203.0.113.207", userAgent: "kept-e06-007-drill/1.0" };
const runId = () => `e06-007-${crypto.randomUUID().slice(0, 8)}`;
/** A document whose `<title>` is `title` and whose bytes are unique to this call. */
const pageHtml = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${runId()}</h1></body></html>\n`;

/** Dynamic imports: `lib/db` is lazy, but the stores read env the moment they are used. */
async function deps() {
  const { desc, eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { profiles, siteVersions, sites, user } = await import("../db/schema");
  const { r2Store } = await import("../storage/r2");
  const { pointerKey } = await import("../storage/manifest");
  return { desc, eq, db, profiles, siteVersions, sites, user, r2Store, pointerKey };
}

async function makeOwner(plan: Plan = "free"): Promise<string> {
  const { db, profiles, user } = await deps();
  const id = crypto.randomUUID();
  const email = `e06-007-${id.slice(0, 8)}@kept-e06-007.invalid`;
  await db.insert(user).values({ id, name: "E06-007 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan });
  createdUsers.add(id);
  return id;
}

async function setPlan(profileId: string, plan: Plan): Promise<void> {
  const { db, eq, profiles } = await deps();
  await db.update(profiles).set({ plan }).where(eq(profiles.id, profileId));
}

interface Published {
  siteId: string;
  slug: string;
  versionId: string;
  html: string;
  title: string;
}

/** A real owned page: Postgres, R2 object, pointer, KV and purge. */
async function publish(profileId: string): Promise<Published> {
  const { publishOwnedPage } = await import("./publish");
  const title = runId();
  const html = pageHtml(title);
  const { site } = await publishOwnedPage({ profileId, html, publisher });
  createdSites.add(site.id);
  createdSlugs.add(site.slug);
  const current = await row(site.id);
  assert.ok(current.currentVersionId, "a published page has a version");
  return { siteId: site.id, slug: site.slug, versionId: current.currentVersionId, html, title };
}

async function row(siteId: string) {
  const { db, eq, sites } = await deps();
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(site, `site ${siteId} vanished`);
  return site;
}

/** Every version row of a page, newest first — what Postgres actually holds. */
async function versionRows(siteId: string) {
  const { db, desc, eq, siteVersions } = await deps();
  return db
    .select({
      id: siteVersions.id,
      r2Key: siteVersions.r2Key,
      activatedAt: siteVersions.activatedAt,
    })
    .from(siteVersions)
    .where(eq(siteVersions.siteId, siteId))
    .orderBy(desc(siteVersions.activatedAt), desc(siteVersions.createdAt));
}

/** The version id the slug pointer (byte-identical to the KV manifest) names. */
async function pointerVersion(slug: string): Promise<string | null> {
  const { pointerKey, r2Store } = await deps();
  const pointer = await r2Store().get(pointerKey(slug));
  return pointer === null ? null : (JSON.parse(pointer) as { versionId: string }).versionId;
}

/** `POST /api/sites/:id/replace`'s 200 body, parsed with the wire schema. */
async function replace(siteId: string, profileId: string, html: string): Promise<ReplaceResult> {
  const { replaceOwnedSite } = await import("./owner-routes");
  const outcome = await replaceOwnedSite(siteId, { html }, profileId);
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return replaceResultSchema.parse(outcome.body);
}

/** …and a replace that must have produced a new version. */
async function replaced(siteId: string, profileId: string, html: string) {
  const result = await replace(siteId, profileId, html);
  if (result.unchanged) assert.fail("new bytes are a new version, never a no-op");
  return result;
}

/** `POST /api/sites/:id/versions/:versionId/restore`'s 200 body, parsed. */
async function restore(siteId: string, versionId: string, profileId: string): Promise<RestoreResult> {
  const { restoreOwnedVersion } = await import("./owner-routes");
  const outcome = await restoreOwnedVersion(siteId, versionId, profileId);
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return restoreResultSchema.parse(outcome.body);
}

/** Run `fn` with `console.error` captured, so a deliberate failure's log is asserted, not printed. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = realError;
  }
}

after(async () => {
  if (skip) return;
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { siteVersions, sites, user } = await import("../db/schema");
  const { removeManifest } = await import("../storage/manifest");
  const { r2Store } = await import("../storage/r2");

  for (const slug of createdSlugs) await removeManifest(slug).catch(() => undefined);
  for (const siteId of createdSites) {
    const versions = await db
      .select({ r2Key: siteVersions.r2Key })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, siteId));
    for (const version of versions) {
      await r2Store()
        .delete(version.r2Key)
        .catch(() => undefined);
    }
  }
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  // Release the pool, or `tsx --test` hangs on `idle_timeout`.
  await db.$client.end();
});

// ── AC28, structurally — no credentials needed ─────────────────────────────

test("AC28 at source level: the restore module writes no page bytes, and both verbs fire the scan hook", () => {
  /** The module's code with comments removed, so prose about what it does NOT call cannot satisfy or trip the check. */
  const code = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const restoreSource = code("./restore.ts");
  for (const forbidden of [".put(", ".putJson(", ".delete(", "writePageAndManifest", "removeManifest", "pageObjectKey"]) {
    assert.equal(
      restoreSource.includes(forbidden),
      false,
      `restore.ts must not contain \`${forbidden}\` — a restore moves a pointer and writes no page bytes`,
    );
  }
  assert.deepEqual(
    restoreSource.match(/r2Store\(\)\.\w+\(/g),
    ["r2Store().get("],
    "the one R2 call on the restore path is a read",
  );
  assert.ok(restoreSource.includes("writeManifest(site.slug"), "a restore is a replace event: the manifest moves");

  // "Fires the scan hook" (AC25) — `enqueueScan` is E07's stub with nothing to
  // observe yet, so the proof is that both paths call it with the new version.
  assert.ok(restoreSource.includes("void enqueueScan(site.id, version.id)"));
  assert.ok(code("./manage.ts").includes("void enqueueScan(site.id, versionId)"));
});

// ── Replace ────────────────────────────────────────────────────────────────

test(
  "replace: new bytes are a new current version with the old one named for Undo; identical bytes are { unchanged: true } and write nothing (AC25, AC27)",
  { skip },
  async () => {
    const { pointerKey, r2Store } = await deps();
    const profileId = await makeOwner();
    const page = await publish(profileId);
    const before = await row(page.siteId);

    const nextTitle = runId();
    const nextHtml = pageHtml(nextTitle);
    const result = await replaced(page.siteId, profileId, nextHtml);

    assert.equal(result.siteId, page.siteId);
    assert.equal(result.slug, page.slug, "the same URL");
    assert.notEqual(result.versionId, page.versionId);
    assert.equal(result.previousVersionId, page.versionId, "what the Undo toast restores");
    assert.equal(result.pruned, false, "one previous version fits the free limit");
    assert.equal(result.title, nextTitle);
    assert.equal(result.expiresAt, null, "a kept page has no clock, before or after");

    const after1 = await row(page.siteId);
    assert.equal(after1.currentVersionId, result.versionId);
    assert.ok(after1.updatedAt > before.updatedAt, "sites.updated_at moves (the OG card's cache key)");
    assert.equal(await pointerVersion(page.slug), result.versionId, "the manifest names the new version");

    const rows = await versionRows(page.siteId);
    assert.deepEqual(
      rows.map((version) => version.id),
      [result.versionId, page.versionId],
      "current + one previous, newest first by activated_at",
    );
    assert.equal(await r2Store().get(rows[0]!.r2Key), nextHtml, "the new bytes are stored");
    assert.equal(await r2Store().get(rows[1]!.r2Key), page.html, "the previous bytes are retained");

    // ── the same bytes again: a no-op ──────────────────────────────────────
    const pointerBefore = await r2Store().get(pointerKey(page.slug));
    const again = await replace(page.siteId, profileId, nextHtml);
    assert.deepEqual(again, { unchanged: true });

    assert.deepEqual(await row(page.siteId), after1, "no column moved — not even updated_at");
    assert.deepEqual(await versionRows(page.siteId), rows, "no version row");
    // The pointer carries `updatedAt: Date.now()`, so a rewrite would change its
    // bytes even for the same version: identical bytes prove no manifest write.
    assert.equal(
      await r2Store().get(pointerKey(page.slug)),
      pointerBefore,
      "no manifest write",
    );
  },
);

test(
  "prune on free: a third replace leaves exactly current + 1; each pruned object is gone (get → null) before its row, and another page's versions are untouched (AC26)",
  { skip },
  async () => {
    const { r2Store } = await deps();
    const { listVersions } = await import("../db/queries/versions");
    const profileId = await makeOwner("free");
    const page = await publish(profileId);
    // A second page of the same owner with two versions of its own — the prune
    // of `page` is scoped by `site_id` and must not see these.
    const neighbour = await publish(profileId);
    await replaced(neighbour.siteId, profileId, pageHtml(runId()));
    const neighbourRows = await versionRows(neighbour.siteId);
    assert.equal(neighbourRows.length, 2);

    const first = await replaced(page.siteId, profileId, pageHtml(runId()));
    assert.equal(first.pruned, false);
    const originalKey = (await versionRows(page.siteId)).find((v) => v.id === page.versionId)!.r2Key;

    const second = await replaced(page.siteId, profileId, pageHtml(runId()));
    assert.equal(second.pruned, true, "the original version fell off the free limit");
    assert.equal(await r2Store().get(originalKey), null, "its object is gone");

    const secondRows = await versionRows(page.siteId);
    const firstKey = secondRows.find((v) => v.id === first.versionId)!.r2Key;
    const third = await replaced(page.siteId, profileId, pageHtml(runId()));
    assert.equal(third.pruned, true);
    assert.equal(third.previousVersionId, second.versionId);

    const rows = await versionRows(page.siteId);
    assert.deepEqual(
      rows.map((version) => version.id),
      [third.versionId, second.versionId],
      "exactly 2 rows: the current version and one previous",
    );
    assert.equal(await r2Store().get(firstKey), null, "every pruned object is gone");
    for (const version of rows) {
      assert.notEqual(await r2Store().get(version.r2Key), null, `kept version ${version.id} still has its bytes`);
    }
    assert.equal(await pointerVersion(page.slug), third.versionId, "the served version is the newest");

    // The read model task 012 renders: newest first, the current one flagged.
    const listed = await listVersions(page.siteId, profileId);
    assert.deepEqual(
      listed.map(({ id, isCurrent, publishedVia }) => ({ id, isCurrent, publishedVia })),
      [
        { id: third.versionId, isCurrent: true, publishedVia: "studio" },
        { id: second.versionId, isCurrent: false, publishedVia: "studio" },
      ],
    );
    assert.ok(listed.every((version) => version.sizeBytes > 0 && version.activatedAt instanceof Date));
    assert.deepEqual(await listVersions(page.siteId, await makeOwner()), [], "owner-scoped: another account lists nothing");

    // Another page's versions were never candidates.
    assert.deepEqual(await versionRows(neighbour.siteId), neighbourRows);
    for (const version of neighbourRows) {
      assert.notEqual(await r2Store().get(version.r2Key), null);
    }
  },
);

test(
  "a plan change prunes nothing by itself; the next replace prunes down to the plan's limit (edge case 8)",
  { skip },
  async () => {
    const { r2Store } = await deps();
    const profileId = await makeOwner("premium");
    const page = await publish(profileId);
    await replaced(page.siteId, profileId, pageHtml(runId()));
    const onPremium = await replaced(page.siteId, profileId, pageHtml(runId()));
    assert.equal(onPremium.pruned, false, "premium keeps 20 previous versions");
    const premiumRows = await versionRows(page.siteId);
    assert.equal(premiumRows.length, 3);

    await setPlan(profileId, "free");
    assert.deepEqual(await versionRows(page.siteId), premiumRows, "no retroactive pruning");

    const onFree = await replaced(page.siteId, profileId, pageHtml(runId()));
    assert.equal(onFree.pruned, true);
    const rows = await versionRows(page.siteId);
    assert.equal(rows.length, 1 + limitsFor("free").previousVersions);
    assert.deepEqual(
      rows.map((version) => version.id),
      [onFree.versionId, onPremium.versionId],
    );
    for (const dropped of premiumRows.slice(1)) {
      assert.equal(await r2Store().get(dropped.r2Key), null, `${dropped.id} was pruned, object first`);
    }
  },
);

test(
  "a failed R2 delete keeps its row and logs, the replace still succeeds and serves, and the next replace retries it (edge case 14)",
  { skip },
  async () => {
    const { db, siteVersions } = await deps();
    const profileId = await makeOwner("free");
    const page = await publish(profileId);

    // A version R2 will refuse to delete: its key is past R2's 1,024-byte limit,
    // so the DELETE is a real HTTP 400. Activated long ago, so it is the oldest.
    const unprunable = { id: crypto.randomUUID(), r2Key: `sites/${page.siteId}/${"x".repeat(1100)}/index.html` };
    await db.insert(siteVersions).values({
      id: unprunable.id,
      siteId: page.siteId,
      r2Key: unprunable.r2Key,
      contentHash: "e06-007-unprunable",
      sizeBytes: 1,
      createdAt: new Date(Date.now() - 86_400_000),
      activatedAt: new Date(Date.now() - 86_400_000),
    });

    const nextHtml = pageHtml(runId());
    const { value: result, logged } = await capturingErrors(() =>
      replaced(page.siteId, profileId, nextHtml),
    );
    assert.equal(result.pruned, false, "nothing was actually dropped");
    assert.ok(
      logged.some((line) => line.includes("prune: R2 delete failed") && line.includes(unprunable.r2Key)),
      "the failure is logged with the key",
    );
    const rows = await versionRows(page.siteId);
    assert.deepEqual(
      rows.map((version) => version.id),
      [result.versionId, page.versionId, unprunable.id],
      "the row whose delete failed is kept",
    );
    assert.equal((await row(page.siteId)).currentVersionId, result.versionId, "the served version is unaffected");
    assert.equal(await pointerVersion(page.slug), result.versionId);

    // The next replace retries it — and still prunes what it can.
    const { value: next, logged: loggedAgain } = await capturingErrors(() =>
      replaced(page.siteId, profileId, pageHtml(runId())),
    );
    assert.ok(loggedAgain.some((line) => line.includes(unprunable.r2Key)), "retried");
    assert.equal(next.pruned, true, "the prunable one still went");
    assert.deepEqual(
      (await versionRows(page.siteId)).map((version) => version.id),
      [next.versionId, result.versionId, unprunable.id],
    );
  },
);

// ── Restore ────────────────────────────────────────────────────────────────

test(
  "restore = Undo: current and previous swap, both stay listed, no page object is written, the title follows the bytes unless the owner set it (AC25, AC28)",
  { skip },
  async () => {
    const { db, eq, r2Store, sites } = await deps();
    const profileId = await makeOwner();
    const page = await publish(profileId);
    const nextTitle = runId();
    const nextHtml = pageHtml(nextTitle);
    const replacement = await replaced(page.siteId, profileId, nextHtml);

    const rowsBefore = await versionRows(page.siteId);
    const keysBefore = rowsBefore.map((version) => version.r2Key).sort();
    const beforeRestore = await row(page.siteId);

    // ── Undo: restore the version that was current before the replace ──────
    const undo = await restore(page.siteId, replacement.previousVersionId!, profileId);
    if (undo.unchanged) assert.fail("restoring a previous version moves the page");
    assert.equal(undo.versionId, page.versionId);
    assert.equal(undo.previousVersionId, replacement.versionId, "undo-the-undo is one more restore");
    assert.equal(undo.slug, page.slug);
    assert.equal(undo.title, page.title, "the restored bytes' title, not the replaced page's");
    assert.equal(undo.expiresAt, null);

    const restored = await row(page.siteId);
    assert.equal(restored.currentVersionId, page.versionId);
    assert.equal(restored.title, page.title);
    // Copied from the version row, never re-hashed — and what the replace no-op
    // compares against next time.
    assert.equal(restored.contentHash, await hashContent(page.html), "content_hash moved with the pointer");
    assert.equal(restored.sizeBytes, Buffer.byteLength(page.html, "utf8"));
    assert.ok(restored.updatedAt > beforeRestore.updatedAt, "sites.updated_at moves (the OG card's cache key)");
    assert.equal(await pointerVersion(page.slug), page.versionId, "the manifest names the restored version");

    const rowsAfter = await versionRows(page.siteId);
    assert.deepEqual(
      rowsAfter.map((version) => version.id),
      [page.versionId, replacement.versionId],
      "both remain listed, the restored one now newest by activated_at",
    );
    assert.ok(rowsAfter[0]!.activatedAt > rowsAfter[1]!.activatedAt);
    assert.deepEqual(rowsAfter.map((version) => version.r2Key).sort(), keysBefore, "no object key added or removed");
    assert.equal(await r2Store().get(rowsAfter.find((v) => v.id === page.versionId)!.r2Key), page.html);
    assert.equal(await r2Store().get(rowsAfter.find((v) => v.id === replacement.versionId)!.r2Key), nextHtml);

    // ── restoring the current version is a no-op ────────────────────────────
    const noop = await restore(page.siteId, page.versionId, profileId);
    assert.deepEqual(noop, { unchanged: true });
    assert.deepEqual(await row(page.siteId), restored, "nothing moved, not even updated_at");

    // ── an owner title survives a restore ───────────────────────────────────
    await db.update(sites).set({ title: "Owner's own name", titleSource: "owner" }).where(eq(sites.id, page.siteId));
    const back = await restore(page.siteId, replacement.versionId, profileId);
    if (back.unchanged) assert.fail("expected a move");
    assert.equal(back.title, "Owner's own name");
    assert.equal((await row(page.siteId)).title, "Owner's own name");
    assert.equal(await pointerVersion(page.slug), replacement.versionId);
    // A restore never prunes: the count is unchanged.
    assert.equal((await versionRows(page.siteId)).length, 2);
  },
);

test(
  "restore refuses a version whose bytes are gone (version_not_found) and moves nothing",
  { skip },
  async () => {
    const { db, siteVersions } = await deps();
    const { restoreOwnedVersion } = await import("./owner-routes");
    const profileId = await makeOwner();
    const page = await publish(profileId);

    // What a prune leaves if its row delete never landed: a row, no object.
    const orphan = crypto.randomUUID();
    await db.insert(siteVersions).values({
      id: orphan,
      siteId: page.siteId,
      r2Key: `sites/${page.siteId}/${orphan}/index.html`,
      contentHash: "e06-007-orphan",
      sizeBytes: 1,
    });
    const before = await row(page.siteId);

    const { value: outcome } = await capturingErrors(() =>
      restoreOwnedVersion(page.siteId, orphan, profileId),
    );
    assert.equal(outcome.status, 404);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "version_not_found");
    assert.deepEqual(await row(page.siteId), before);
    assert.equal(await pointerVersion(page.slug), page.versionId, "still serving what it was");
  },
);
