/**
 * D11 and §5.9 over the FOUR paths that write bytes — E06 task 005, PRD
 * acceptance criterion **30** (the integration half; `page-title.test.ts` holds
 * the extractor's unit cases).
 *
 *   keyless publish   `publishPage`        (`POST /api/publish`)
 *   anonymous replace `replacePage`        (`POST /api/anon/:token/replace`)
 *   studio publish    `publishOwnedPage`   (`POST /api/sites`)
 *   studio replace    `replaceSite`        (`POST /api/sites/:id/replace`)
 *
 * On each one: the title comes from the bytes' `<title>` (tags stripped,
 * entities decoded), a replace REFRESHES an `html` title and NEVER overwrites an
 * `owner` one, and the version row records the door it came through. The two
 * keyless paths also pin their wire bodies to the exact keys they had before —
 * agents parse them, so this task may change what they WRITE, never what they
 * SAY.
 *
 * NO MOCKS: real dev Postgres, R2, KV and purge. The owner title is set by a
 * direct row update — the PATCH that sets it is task 012's.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no
 * secrets. Every row, object and manifest created here is removed in `after`.
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

const publisher = { ip: "203.0.113.205", userAgent: "kept-e06-005-drill/1.0" };
const runId = () => `e06-005-${crypto.randomUUID().slice(0, 8)}`;
const pageHtml = (title: string, body = runId()) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${body}</h1></body></html>\n`;

/** Dynamic imports: `lib/db` is lazy, but the stores read env the moment they are used. */
async function deps() {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { profiles, siteVersions, sites, user } = await import("../db/schema");
  return { eq, db, profiles, siteVersions, sites, user };
}

async function row(siteId: string) {
  const { eq, db, sites } = await deps();
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(site, `site ${siteId} vanished`);
  return site;
}

/** The door each version of a page came through, oldest first. */
async function channels(siteId: string): Promise<string[]> {
  const { eq, db, siteVersions } = await deps();
  const versions = await db
    .select({ publishedVia: siteVersions.publishedVia, createdAt: siteVersions.createdAt })
    .from(siteVersions)
    .where(eq(siteVersions.siteId, siteId));
  return versions
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((version) => version.publishedVia);
}

/** What task 012's PATCH will do: the owner names the page. */
async function setOwnerTitle(siteId: string, title: string): Promise<void> {
  const { eq, db, sites } = await deps();
  await db.update(sites).set({ title, titleSource: "owner" }).where(eq(sites.id, siteId));
}

after(async () => {
  if (skip) return;
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { siteVersions, sites, user } = await import("../db/schema");
  const { removeManifest } = await import("../storage/manifest");
  const { pageObjectKey, r2Store } = await import("../storage/r2");

  for (const slug of createdSlugs) await removeManifest(slug).catch(() => undefined);
  for (const siteId of createdSites) {
    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, siteId));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(siteId, version.id))
        .catch(() => undefined);
    }
  }
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  // Release the pool, or `tsx --test` hangs on `idle_timeout`.
  await db.$client.end();
});

test(
  "the keyless pair: the title is the bytes', an owner title survives a replace, the door is recorded, and the wire bodies are unchanged",
  { skip },
  async () => {
    const { eq, db, sites } = await deps();
    const { publishPage } = await import("./pipeline");
    const { replacePage } = await import("./anon-manage");

    // ── POST /api/publish, keyless: `api` ─────────────────────────────────────
    const first = `${runId()} &amp; <b>friends</b>`;
    const published = await publishPage({ html: pageHtml(first) }, publisher);
    assert.equal(published.ok, true, published.ok ? "" : JSON.stringify(published.body));
    if (!published.ok) return;
    createdSlugs.add(published.body.slug);

    // THE WIRE BODY IS EXACTLY THE SEVEN KEYS IT ALWAYS HAD — nothing about the
    // title or the channel leaks into what agents parse.
    assert.deepEqual(Object.keys(published.body).sort(), [
      "anonToken",
      "claim_url",
      "deduped",
      "expires_at",
      "expires_in",
      "live_url",
      "slug",
    ]);
    assert.equal(published.status, 201);

    const [anon] = await db.select().from(sites).where(eq(sites.slug, published.body.slug));
    assert.ok(anon);
    createdSites.add(anon.id);
    assert.equal(anon.title, `${first.split(" ")[0]} & friends`, "decoded, tags stripped");
    assert.equal(anon.titleSource, "html");
    assert.deepEqual(await channels(anon.id), ["api"]);

    // ── POST /api/publish from the landing (carries a Turnstile token): `web` ──
    const fromWeb = await publishPage(
      { html: pageHtml(runId()), turnstileToken: "e06-005-drill" },
      publisher,
    );
    assert.equal(fromWeb.ok, true, fromWeb.ok ? "" : JSON.stringify(fromWeb.body));
    if (!fromWeb.ok) return;
    createdSlugs.add(fromWeb.body.slug);
    const [web] = await db.select().from(sites).where(eq(sites.slug, fromWeb.body.slug));
    assert.ok(web);
    createdSites.add(web.id);
    assert.deepEqual(await channels(web.id), ["web"]);

    // ── Anonymous replace from the manage screen: `web`, and an html title refreshes
    const second = runId();
    const replaced = await replacePage(published.body.anonToken, { html: pageHtml(second) }, "web");
    assert.equal(replaced.ok, true, replaced.ok ? "" : JSON.stringify(replaced.body));
    if (!replaced.ok) return;
    assert.deepEqual(Object.keys(replaced.body).sort(), [
      "expires_at",
      "expires_in",
      "live_url",
      "slug",
    ]);
    assert.equal((await row(anon.id)).title, second);
    assert.deepEqual(await channels(anon.id), ["api", "web"]);

    // ── An owner title is NEVER overwritten by a replace (D11) ───────────────
    await setOwnerTitle(anon.id, "Named by its owner");
    const again = await replacePage(published.body.anonToken, { html: pageHtml(runId()) }, "api");
    assert.equal(again.ok, true, again.ok ? "" : JSON.stringify(again.body));
    const afterOwner = await row(anon.id);
    assert.equal(afterOwner.title, "Named by its owner");
    assert.equal(afterOwner.titleSource, "owner");
    assert.deepEqual(await channels(anon.id), ["api", "web", "api"]);
  },
);

test(
  "the studio pair: the title is the bytes', an owner title survives a replace, and both record `studio`",
  { skip },
  async () => {
    const { db, profiles, user } = await deps();
    const { publishOwnedPage } = await import("../sites/publish");
    const { replaceSite } = await import("../sites/manage");

    const profileId = crypto.randomUUID();
    const email = `e06-005-${profileId.slice(0, 8)}@kept-e06-005.invalid`;
    await db.insert(user).values({ id: profileId, name: "E06-005 drill", email, emailVerified: true });
    await db.insert(profiles).values({ id: profileId, email, plan: "free" });
    createdUsers.add(profileId);

    // ── POST /api/sites ──────────────────────────────────────────────────────
    const first = runId();
    const { site } = await publishOwnedPage({
      profileId,
      html: pageHtml(`<em>${first}</em>\n\t  draft`),
      publisher,
    });
    createdSites.add(site.id);
    createdSlugs.add(site.slug);
    assert.equal(site.title, `${first} draft`, "tags stripped, whitespace collapsed");
    assert.equal((await row(site.id)).title, `${first} draft`);
    assert.deepEqual(await channels(site.id), ["studio"]);

    // ── Studio replace: an html title refreshes ──────────────────────────────
    const second = runId();
    const replaced = await replaceSite(site.id, profileId, pageHtml(second));
    if (replaced.unchanged) assert.fail("new bytes are a new version, never a no-op");
    assert.equal(replaced.title, second);
    assert.equal((await row(site.id)).title, second);
    assert.deepEqual(await channels(site.id), ["studio", "studio"]);

    // ── …and an owner title does not, and the response says what the row holds
    await setOwnerTitle(site.id, "Owner's own name");
    const kept = await replaceSite(site.id, profileId, pageHtml(runId()));
    if (kept.unchanged) assert.fail("new bytes are a new version, never a no-op");
    assert.equal(kept.title, "Owner's own name", "the response reports the stored title");
    const afterOwner = await row(site.id);
    assert.equal(afterOwner.title, "Owner's own name");
    assert.equal(afterOwner.titleSource, "owner");
    // Free keeps the current version plus one previous (D7): the third studio
    // version pruned the first, and every survivor still records its door.
    assert.deepEqual(await channels(site.id), ["studio", "studio"]);
  },
);
