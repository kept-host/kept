import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ownedPublishResultSchema } from "@kept/shared";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { db, schema } from "../lib/db";

import { SKIP_LIVE_PUBLISH } from "./live-publish";

/**
 * The signed-in browser harness the four E06 screen specs share — task 013.
 *
 * Not a `*.spec.ts`, so Playwright never collects it as a test file.
 *
 * ── WHY THIS EXISTS RATHER THAN FOUR COPIES ──────────────────────────────────
 *
 * `dashboard`, `site-detail`, `swap-chooser` and `settings` all need the same
 * three things and nothing else: a real magic-link session inside a real browser
 * context, real owned pages published through `POST /api/sites`, and a teardown
 * that removes every row, KV key and R2 object it created. Written four times
 * that is four chances to forget the teardown, and a forgotten teardown here is
 * a real page serving on the dev track — not a stale fixture in a test database.
 *
 * ⚠️ NOTHING IS MOCKED, AND NOTHING HERE MAY START. Every page is published
 * through the same route a browser posts to: Postgres, R2, KV and a real edge
 * purge. The API specs (`owner-publish-api`, `owner-rename-api`, …) already
 * assert what that route *returns*; these fixtures exist so the screen specs can
 * assert what the SCREENS do with it.
 *
 * ── WHY `page.request` AND NOT `jarlessContext()` ────────────────────────────
 *
 * The opposite of `session-request.ts`'s reasoning, for the opposite need.
 * Those specs juggle two identities inside one test and must therefore share no
 * jar. These specs drive a browser that *is* one identity: `page.request` speaks
 * through the page's own context, so the `__Host-` cookie the magic-link verify
 * sets is the same cookie the subsequent navigation sends. A jarless context
 * here would publish pages the signed-in screen then could not see.
 *
 * `origin` is still passed by hand — `refuseUntrustedOrigin` requires it on every
 * cookie-authenticated mutation, and an `APIRequestContext` sends none. See the
 * long note in `session-request.ts`; this is the same honesty, not a loosening.
 */
config({ path: ".env.local", quiet: true });

const authMissing = ["BETTER_AUTH_SECRET"].filter((name) => !process.env[name]?.trim());

/**
 * `false` when a signed-in screen spec can really run, otherwise the reason to
 * skip. Feed it straight to `test.skip(...)`.
 *
 * CI runs fork PRs with no environment, so these skip there exactly as the rest
 * of the live family does. A skip is not a pass and is not treated as one.
 */
export const SKIP_OWNER_UI: string | false =
  SKIP_LIVE_PUBLISH ||
  (authMissing.length > 0
    ? `auth credentials absent (${authMissing.join(", ")}) — run locally with apps/web/.env.local`
    : false);

/** Everything one spec file created, so `cleanup()` can unwind all of it. */
export interface OwnerScope {
  userIds: string[];
  siteIds: string[];
  slugs: Set<string>;
}

export function newScope(): OwnerScope {
  return { userIds: [], siteIds: [], slugs: new Set() };
}

/**
 * Sign `page`'s browser context in as a brand-new account, through the REAL
 * magic-link verify endpoint.
 *
 * A fresh address every time, and never a shared fixture user: these specs fill
 * the kept cap, swap pages and delete accounts, so two tests sharing an identity
 * would race each other's quota. The `.invalid` TLD is reserved by RFC 2606 and
 * can never be delivered to.
 *
 * Pass `email` to sign ANOTHER browser context into an account this spec
 * already created — a second device, with its own session row (task 014's
 * AC43 drill). The magic link signs an existing user in by address.
 */
export async function signInAs(
  page: Page,
  baseURL: string,
  scope: OwnerScope,
  email = `e06-013-${crypto.randomUUID().slice(0, 8)}@kept-e06-013.invalid`,
): Promise<{ userId: string; email: string }> {
  const { auth } = await import("../lib/auth");
  const ctx = await auth.$context;
  const token = crypto.randomUUID().replace(/-/g, "");

  await ctx.internalAdapter.createVerificationValue({
    identifier: token,
    value: JSON.stringify({ email, name: "E06-013 screen drill" }),
    expiresAt: new Date(Date.now() + 300_000),
  });

  // Through the page's own request context, so the `__Host-` cookie lands in the
  // jar the next `page.goto` will send from.
  const response = await page.request.get(
    `${baseURL}/api/auth/magic-link/verify?token=${token}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  if (!scope.userIds.includes(body.user.id)) scope.userIds.push(body.user.id);
  return { userId: body.user.id, email };
}

/** A minimal valid document carrying a specific `<title>`. */
export const titledHtml = (title: string, body = title): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${body}</h1></body></html>\n`;

export interface OwnedPage {
  siteId: string;
  slug: string;
  liveUrl: string;
  /** `title ?? slug` — what every surface calls this page. */
  name: string;
  title: string | null;
  /** `kept` under the cap, `owned_draft` at it. Never an error either way. */
  outcome: "kept" | "owned_draft";
  html: string;
}

/**
 * Publish one page straight into the signed-in account — `POST /api/sites`,
 * epic D1. No anon token is minted and none is available; an owned page has one
 * authority and it is the account.
 *
 * Deliberately NOT asserting which branch came back: the caller decides whether
 * it wanted `kept` or `owned_draft`, and a fixture that insisted on `kept` could
 * not be used to build the at-cap cases three of these specs are about.
 */
export async function publishOwned(
  page: Page,
  baseURL: string,
  scope: OwnerScope,
  title: string,
): Promise<OwnedPage> {
  const html = titledHtml(`${title} ${crypto.randomUUID().slice(0, 8)}`);
  const response = await page.request.post(`${baseURL}/api/sites`, {
    headers: { origin: new URL(baseURL).origin, "content-type": "text/html" },
    data: html,
  });
  // 201: the bytes carry a fresh suffix, so this is never the 200 duplicate.
  expect(response.status(), await response.text()).toBe(201);
  const { site } = ownedPublishResultSchema.parse(await response.json());

  scope.siteIds.push(site.id);
  scope.slugs.add(site.slug);

  return {
    siteId: site.id,
    slug: site.slug,
    liveUrl: site.liveUrl,
    name: site.title ?? site.slug,
    title: site.title,
    // `isDraft = expires_at != null` — the response's only signal for the cap.
    outcome: site.expiresAt === null ? "kept" : "owned_draft",
    html,
  };
}

/** A kept row `seedKept` wrote straight into Postgres. `name` is the slug: no title. */
export interface SeededPage {
  siteId: string;
  slug: string;
  name: string;
}

/**
 * `n` kept pages in ONE insert, straight into Postgres — for specs that need an
 * account AT or NEAR its kept limit, not for specs about publishing.
 *
 * ⚠️ REAL ROWS, NOT A MOCK — AND NOT A PUBLISH. The cap counts these exactly as
 * it counts a published page (`owner_id` set, no clock, `live`), and the screens
 * list them. What they do not have is bytes: no R2 object, no slug pointer, no
 * KV manifest, so nothing serves at their slug. Use them to FILL the limit and
 * publish the pages a spec actually asserts about through `publishOwned`.
 * Publishing `limitsFor(plan).keptPages` real pages per test would multiply this
 * suite's runtime by the limit and prove nothing these rows do not.
 *
 * Takes any `{ siteIds }` sink so a spec with its own teardown list can use it;
 * every id is recorded there, so `cleanup` (or that spec's own `afterAll`)
 * deletes them by id like any other row.
 */
export async function seedKept(
  scope: Pick<OwnerScope, "siteIds">,
  ownerId: string,
  n: number,
): Promise<SeededPage[]> {
  const rows = Array.from({ length: n }, () => {
    const id = crypto.randomUUID();
    return {
      id,
      slug: `e06-seed-${id.slice(0, 8)}${id.slice(9, 13)}`,
      ownerId,
      publisherHash: "e06-e2e-seed",
      claimedAt: new Date(),
      contentHash: "e06-e2e-seed",
      sizeBytes: 128,
    };
  });
  if (rows.length === 0) return [];
  await db.insert(schema.sites).values(rows);
  scope.siteIds.push(...rows.map((row) => row.id));
  return rows.map(({ id, slug }) => ({ siteId: id, slug, name: slug }));
}

/** The row as Postgres holds it right now. The authority every assertion re-reads. */
export async function readSite(id: string) {
  const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
  expect(row, `site ${id} vanished`).toBeDefined();
  return row!;
}

/**
 * One day of visits for a page, dated yesterday (UTC) — the shape the visits
 * sync writes. A real `page_views_daily` row; it cascades with its site.
 */
export async function seedVisits(siteId: string, views: number): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.insert(schema.pageViewsDaily).values({ siteId, day: yesterday, views });
}

/**
 * Wait until the Pages home is interactive. Opening the publish sheet is proof:
 * it only opens because the hydrated `onClick` ran, so every listener the screen
 * attaches — including the window's drop target — is attached too.
 */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publish-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publish-sheet")).toBeHidden();
}

/** A file to drop. Its type is the browser's to infer from `name`, as from a desktop. */
export interface DroppedFile {
  name: string;
  body: string;
}

/** A file the browser is holding over the screen — see `hold`. */
export interface HeldFile {
  /** Let go: the browser drops it where it is held. */
  drop: () => Promise<void>;
  /** Carry it away: the drag ends with no drop. */
  cancel: () => Promise<void>;
}

/**
 * Hold a real file over the middle of `target`, as a drag from the desktop
 * does — through Chromium's own input pipeline (`Input.dispatchDragEvent`), so
 * the browser hit-tests the point and dispatches `dragenter` / `dragover`
 * itself.
 *
 * ── WHY NOT `target.dispatchEvent("drop")` ───────────────────────────────────
 * That is how this helper used to drop, and it hid a real bug (E06 task 015,
 * post-test fix). An event the BROWSER dispatches runs a microtask checkpoint
 * after every listener, so React renders between its own root listener and a
 * listener on `window`; an event a SCRIPT dispatches runs every listener in one
 * go. A card that re-rendered on drop therefore looked correct here and, in a
 * real browser, the window's listener published a second page.
 *
 * CDP drops files by path, so the file is written under this test's output
 * directory first — and left there, because the page reads its bytes after
 * the drop.
 */
export async function hold(page: Page, target: Locator, file: DroppedFile): Promise<HeldFile> {
  const path = test.info().outputPath(`drop-${crypto.randomUUID()}`, file.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.body);

  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, "the drop target is on screen").not.toBeNull();
  const at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

  const cdp = await page.context().newCDPSession(page);
  const send = (type: "dragEnter" | "dragOver" | "drop" | "dragCancel") =>
    cdp.send("Input.dispatchDragEvent", {
      type,
      ...at,
      // `Copy`: what a file dragged in from the desktop offers.
      data: { items: [], files: [path], dragOperationsMask: 1 },
    });
  const release = (type: "drop" | "dragCancel") => async () => {
    await send(type);
    await cdp.detach();
  };

  await send("dragEnter");
  await send("dragOver");
  return { drop: release("drop"), cancel: release("dragCancel") };
}

/** A real drop: the file is held over `target`, then let go. */
export async function drop(page: Page, target: Locator, file: DroppedFile): Promise<void> {
  await (await hold(page, target, file)).drop();
}

/**
 * Unwind everything the spec created: the edge first, then the bytes, then the
 * rows.
 *
 * Edge first for `deletePage`'s reason — the dangerous half-state is a deleted
 * row whose page keeps serving. Best-effort throughout: a teardown that threw
 * would mask the assertion that already passed above it, and would leave the
 * REST of the fixtures behind as well.
 */
export async function cleanup(scope: OwnerScope): Promise<void> {
  const { removeManifest } = await import("../lib/storage/manifest");
  const { pageObjectKey, r2Store } = await import("../lib/storage/r2");

  for (const slug of scope.slugs) {
    await removeManifest(slug).catch(() => undefined);
  }

  for (const id of scope.siteIds) {
    const versions = await db
      .select({ id: schema.siteVersions.id })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, id));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(id, version.id))
        .catch(() => undefined);
    }
  }

  // By id, never by owner: a spec that deleted its own account leaves rows whose
  // `owner_id` the FK has already nulled, and an owner-scoped delete would walk
  // straight past exactly the rows it most needs to collect.
  if (scope.siteIds.length) {
    // A rename's history and any hold a rename or delete left carry the site id
    // with no FK, so they outlive the row unless they are collected here.
    await db.delete(schema.nameEvents).where(inArray(schema.nameEvents.siteId, scope.siteIds));
    await db.delete(schema.nameHolds).where(inArray(schema.nameHolds.siteId, scope.siteIds));
    await db.delete(schema.sites).where(inArray(schema.sites.id, scope.siteIds));
  }
  if (scope.userIds.length) {
    await db.delete(schema.user).where(inArray(schema.user.id, scope.userIds));
  }
}
