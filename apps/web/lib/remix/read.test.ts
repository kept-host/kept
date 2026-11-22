/**
 * `remixPageData` (E10 task 007, AC12) against real `sites` rows on the dev
 * Neon branch — no mocks (project rule). Rows only, no publish: nothing reaches
 * KV or R2. Deleted in `after`. Skips when `DATABASE_URL` is absent.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";

const ownerId = crypto.randomUUID();
const siteIds: string[] = [];

async function deps() {
  const { db } = await import("../db");
  const schema = await import("../db/schema");
  const { remixPageData } = await import("./read");
  return { db, schema, remixPageData };
}

type SiteOverrides = Partial<{
  model: string | null;
  prompt: string | null;
  title: string | null;
  showMadeWith: boolean;
  showPrompt: boolean;
  allowRemix: boolean | null;
  status: "live" | "removed" | "archived" | "quarantined";
  expiresAt: Date | null;
}>;

/** One owned row; kept, `live`, with a model and a prompt unless overridden. */
async function seed(overrides: SiteOverrides = {}): Promise<string> {
  const { db, schema } = await deps();
  const id = crypto.randomUUID();
  const slug = `e10-007-${id.slice(0, 12)}`;
  await db.insert(schema.sites).values({
    id,
    slug,
    ownerId,
    publisherHash: "e10-007-drill",
    claimedAt: new Date(),
    contentHash: "e10-007",
    sizeBytes: 64,
    title: "Remix drill",
    model: "claude-opus-4",
    prompt: "Make a tiny landing page.",
    showPrompt: true,
    ...overrides,
  });
  siteIds.push(id);
  return slug;
}

before(async () => {
  if (skip) return;
  const { db, schema } = await deps();
  const email = `e10-007-${ownerId}@kept.invalid`;
  await db.insert(schema.user).values({ id: ownerId, name: "E10-007 drill", email, emailVerified: true });
  await db.insert(schema.profiles).values({ id: ownerId, email, plan: "free" });
});

after(async () => {
  if (skip) return;
  const { db, schema } = await deps();
  const { eq, inArray } = await import("drizzle-orm");
  if (siteIds.length) await db.delete(schema.sites).where(inArray(schema.sites.id, siteIds));
  await db.delete(schema.profiles).where(eq(schema.profiles.id, ownerId));
  await db.delete(schema.user).where(eq(schema.user.id, ownerId));
  await db.$client.end();
});

test("a kept live page with a model and a shown prompt", { skip }, async () => {
  const { remixPageData } = await deps();
  const { servingBaseDomain, appOrigin } = await import("../storage/env");
  const slug = await seed();
  const data = await remixPageData(slug);
  console.log(`[remix-read] ${slug} →`, data);
  assert.ok(data);
  assert.equal(data.title, "Remix drill");
  assert.equal(data.model, "claude-opus-4");
  assert.equal(data.shownPrompt, "Make a tiny landing page.");
  assert.equal(data.pageUrl, `https://${slug}.${servingBaseDomain()}`);
  assert.match(data.ogImageUrl, new RegExp(`^${appOrigin().replace(/[.]/g, "\\.")}/api/og/[0-9a-f-]{36}\\?v=`));
});

test("show_prompt off hides the prompt; show_made_with off hides the model", { skip }, async () => {
  const { remixPageData } = await deps();
  const data = await remixPageData(await seed({ showPrompt: false, showMadeWith: false, title: null }));
  assert.ok(data);
  assert.equal(data.shownPrompt, undefined);
  assert.equal(data.model, undefined);
  assert.match(data.title, /^e10-007-/, "no title → the slug");
});

test("allow_remix wins over the default rule", { skip }, async () => {
  const { remixPageData } = await deps();
  assert.equal(await remixPageData(await seed({ allowRemix: false })), null, "off → null");
  assert.ok(await remixPageData(await seed({ model: null, allowRemix: true })), "on without a model");
  assert.equal(await remixPageData(await seed({ model: null })), null, "default rule, no model → null");
});

test("a draft, a non-live page and an unknown slug are null", { skip }, async () => {
  const { remixPageData } = await deps();
  const week = new Date(Date.now() + 7 * 86_400_000);
  assert.equal(await remixPageData(await seed({ expiresAt: week, allowRemix: true })), null, "draft");
  assert.equal(await remixPageData(await seed({ status: "removed" })), null, "removed");
  assert.equal(await remixPageData(await seed({ status: "quarantined" })), null, "quarantined");
  assert.equal(await remixPageData(`e10-007-none-${crypto.randomUUID().slice(0, 8)}`), null, "unknown");
});
