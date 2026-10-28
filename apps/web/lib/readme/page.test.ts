/**
 * The README page (E10 D6, Q6): the document `readmeDocument` builds, and
 * `refreshReadmePage` against the real dev Neon branch and the real R2 bucket.
 *
 * NO MOCKS. The refresh drills seed one owned row each and write or delete one
 * object; no manifest is touched (the KV half rides on the caller's
 * `syncManifest` — `lib/sites/details.test.ts` covers it). The live drills SKIP
 * without dev credentials; every row and object is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";
import { config } from "dotenv";

import type { ReadmeSource } from "../db/queries/readme";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KEPT_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0 ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdObjects = new Set<string>();

const SOURCE: ReadmeSource = {
  slug: "readme-drill",
  title: 'Cats & <dogs>',
  expiresAt: null,
  model: "claude-opus-4-7",
  tool: "Claude Code",
  prompt: "Make a page about <cats>",
  readme: "## How\n\n<script>alert(1)</script>",
  sourceUrl: "https://example.com/src?a=1&b=2",
  showMadeWith: true,
  showPrompt: false,
};

test("readmeDocument: title, provenance and footer, every value escaped, no script", { skip }, async () => {
  const { readmeDocument } = await import("./page");
  const html = readmeDocument(SOURCE);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>How Cats &amp; &lt;dogs&gt; was made<\/title>/);
  assert.match(html, /<h1>How Cats &amp; &lt;dogs&gt; was made<\/h1>/);
  assert.match(html, /<span>Made with claude-opus-4-7<\/span><span>Using Claude Code<\/span>/);
  assert.match(html, /<a href="https:\/\/example\.com\/src\?a=1&amp;b=2" rel="nofollow ugc noopener">Source<\/a>/);
  assert.match(html, /<a class="back" href="\/">/, "a link back to the page");
  assert.match(html, />Made with kept<\/a>/);
  assert.match(html, /\/report\?url=https%3A%2F%2Freadme-drill\.[^"]+%2F">Report<\/a>/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/<script/i.test(html), "kept-own CSP: the page itself has no script");
  assert.ok(!html.includes("Make a page about"), "the prompt is private unless shown");
});

test("readmeDocument: the slug stands in for a missing title; switches hide model, tool and show the prompt", { skip }, async () => {
  const { readmeDocument } = await import("./page");
  const html = readmeDocument({ ...SOURCE, title: null, showMadeWith: false, showPrompt: true, sourceUrl: null });
  assert.match(html, /<h1>How readme-drill was made<\/h1>/);
  assert.ok(!html.includes("Made with claude") && !html.includes("Using Claude Code"), "\"Made with\" off hides both");
  assert.ok(!html.includes(">Source<"));
  assert.match(html, /<h2>Prompt<\/h2><pre>Make a page about &lt;cats&gt;<\/pre>/);
});

async function seed(kept: boolean, readme: string | null): Promise<string> {
  const { db } = await import("../db/index");
  const { profiles, sites, user } = await import("../db/schema");
  const owner = crypto.randomUUID();
  const email = `e10-006-${owner.slice(0, 8)}@kept-e10-006.invalid`;
  await db.insert(user).values({ id: owner, name: "E10-006 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id: owner, email, plan: "free" });
  createdUsers.add(owner);
  const id = crypto.randomUUID();
  const expiresAt = kept ? null : new Date(Date.now() + DRAFT_TTL_DAYS * MS_PER_DAY);
  await db.insert(sites).values({
    id,
    slug: `e10-006-${id.slice(0, 12)}`,
    status: "live",
    ownerId: owner,
    publisherHash: "e10-006-drill",
    claimedAt: new Date(),
    expiresAt,
    purgeAfter: expiresAt ? new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY) : null,
    contentHash: "e10-006",
    sizeBytes: 1,
    readme,
  });
  createdSites.add(id);
  return id;
}

after(async () => {
  if (skip) return;
  const { db } = await import("../db/index");
  const { profiles, sites, user } = await import("../db/schema");
  const { r2Store } = await import("../storage/r2");
  const { inArray } = await import("drizzle-orm");
  for (const key of createdObjects) await r2Store().delete(key).catch(() => undefined);
  if (createdSites.size) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdUsers]));
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await db.$client.end();
});

test("Q6: refreshReadmePage writes a kept page's README and deletes it once the README is empty", { skip }, async () => {
  const { refreshReadmePage } = await import("./page");
  const { db } = await import("../db/index");
  const { sites } = await import("../db/schema");
  const { r2Store, readmeObjectKey } = await import("../storage/r2");
  const { eq } = await import("drizzle-orm");

  const siteId = await seed(true, "Built in **one** prompt.");
  createdObjects.add(readmeObjectKey(siteId));
  await refreshReadmePage(siteId);
  const written = await r2Store().get(readmeObjectKey(siteId));
  assert.ok(written?.includes("<strong>one</strong>"), "the kept page's README page is in R2");

  await db.update(sites).set({ readme: null }).where(eq(sites.id, siteId));
  await refreshReadmePage(siteId);
  assert.equal(await r2Store().get(readmeObjectKey(siteId)), null, "no README, no object");
});

test("Q6: refreshReadmePage never writes or deletes a draft's object", { skip }, async () => {
  const { refreshReadmePage } = await import("./page");
  const { PAGE_CONTENT_TYPE, r2Store, readmeObjectKey } = await import("../storage/r2");

  const withReadme = await seed(false, "A draft's README.");
  createdObjects.add(readmeObjectKey(withReadme));
  await refreshReadmePage(withReadme);
  assert.equal(await r2Store().get(readmeObjectKey(withReadme)), null, "a draft gets no README page");

  // A demoted page's object stays until the next keep refreshes it (the Worker
  // does not serve it while the badge is a draft's).
  const demoted = await seed(false, null);
  createdObjects.add(readmeObjectKey(demoted));
  await r2Store().put(readmeObjectKey(demoted), "<p>from when it was kept</p>", PAGE_CONTENT_TYPE);
  await refreshReadmePage(demoted);
  assert.equal(await r2Store().get(readmeObjectKey(demoted)), "<p>from when it was kept</p>");
});
