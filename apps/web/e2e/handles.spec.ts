import {
  handleChangeResultSchema,
  isRedirectManifest,
  kvEntrySchema,
  MANIFEST_KV_CACHE_TTL_SECONDS,
  nameCheckResultSchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey, removeManifest } from "../lib/storage/manifest";
import { r2Store } from "../lib/storage/r2";
import { clearPendingPurges } from "../lib/testing/pending-purges";

import { servingDomain } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, seedOwned, signInAs, SKIP_OWNER_UI, type OwnedPage } from "./owner-fixtures";

/**
 * Handles over the wire — E10 task 008 (AC15, AC16, D9, D10, PRD §5.5).
 *
 * NO MOCKS. Two real magic-link accounts: A sets a handle through the real
 * Settings → Profile field, then changes it through `PUT /api/profile/handle`;
 * B owns ONE seeded kept page (rows and bytes, no manifest — every refusal
 * here is decided before a store call) and tries to rename it onto A's handle.
 * A owns no page, so its badge re-sync queues nothing.
 *
 * The `@edge` test needs E10's Worker (task 004) on dev — the old host's 301 —
 * so until the rc tag deploys the branch (Q25) the pre-gate run is
 * `--grep-invert @edge`. It polls past the second purge.
 *
 * KV BUDGET (≤ 6): one redirect write (the change) and one delete in teardown.
 */
const EDGE_WAIT_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 15) * 1000;
const POLL_MS = 3_000;

const scope = newScope();
const handleName = () => `e10-008-${crypto.randomUUID().slice(0, 8)}`;
const first = handleName();
const second = handleName();
const third = handleName();

test.describe("handles", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT * 2 });

  let a: APIRequestContext;
  let b: APIRequestContext;
  let aContext: BrowserContext;
  let bContext: BrowserContext;
  let aId: string;
  let bPage: OwnedPage;
  let origin: { origin: string };

  test.beforeAll(async ({ browser, baseURL }) => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
    origin = { origin: new URL(baseURL!).origin };
    aContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    bContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    const aTab = await aContext.newPage();
    const bTab = await bContext.newPage();
    aId = (await signInAs(aTab, baseURL!, scope)).userId;
    const { userId: bId } = await signInAs(bTab, baseURL!, scope);
    bPage = await seedOwned(scope, bId, "E10 handles namespace");
    a = aContext.request;
    b = bContext.request;
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    const names = [first, second, third];
    // Only `first` ever got a redirect manifest; the others never reached KV.
    await removeManifest(first);
    await db.delete(schema.nameHolds).where(inArray(schema.nameHolds.name, names));
    await db.delete(schema.handleRedirects).where(inArray(schema.handleRedirects.oldHandle, names));
    await clearPendingPurges(names);
    await aContext?.close();
    await bContext?.close();
    await cleanup(scope);
    await closeDb();
  });

  const check = async (ctx: APIRequestContext, name: string) => {
    const response = await ctx.get(`/api/names/check?${new URLSearchParams({ name, handle: "1" })}`);
    expect(response.status(), await response.text()).toBe(200);
    return nameCheckResultSchema.parse(await response.json());
  };

  const put = (ctx: APIRequestContext, handle: string) =>
    ctx.put("/api/profile/handle", { headers: origin, data: { handle } });

  test("set a first handle through Settings → Profile's live check", async () => {
    const tab = await aContext.newPage();
    await tab.goto("/settings");
    await tab.waitForLoadState("networkidle");
    await tab.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Profile" }).click();
    await expect(tab.getByTestId("handle-section")).toBeVisible();

    // A free 4-letter handle is Pro's — the field says so before any save.
    await tab.getByTestId("handle-input").fill("abcd");
    await expect(tab.getByTestId("handle-status")).toHaveAttribute("data-reason", "pro_length");
    await expect(tab.getByTestId("handle-save")).toBeDisabled();

    await tab.getByTestId("handle-input").fill(first);
    await expect(tab.getByTestId("handle-status")).toContainText(`${first}.${servingDomain()} is free`);
    await tab.getByTestId("handle-save").click();
    await expect(tab.getByTestId("handle-current")).toContainText(`${first}.${servingDomain()}`);
    await tab.close();

    const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, aId));
    expect(row?.handle).toBe(first);
    expect(row?.handleChangedAt, "a first handle is not a change").toBeNull();
  });

  test("AC15: a handle and a page name share one namespace — B's rename onto it is taken", async () => {
    const checked = await b.get(`/api/names/check?${new URLSearchParams({ name: first, siteId: bPage.siteId })}`);
    expect(nameCheckResultSchema.parse(await checked.json())).toEqual({ status: "taken" });

    const renamed = await b.patch(`/api/sites/${bPage.siteId}/name`, { headers: origin, data: { name: first } });
    expect(renamed.status(), await renamed.text()).toBe(409);
    expect(studioErrorSchema.parse(await renamed.json()).error.code).toBe("name_taken");
    expect(await check(b, first)).toEqual({ status: "taken" });

    // …and the reverse: A's handle can't take B's page name.
    expect(await check(a, bPage.slug)).toEqual({ status: "taken" });
  });

  test("a free 4-letter handle is refused by the save too", async () => {
    expect(await check(a, "abcd")).toEqual({ status: "pro_length" });
    const response = await put(a, "abcd");
    expect(response.status(), await response.text()).toBe(400);
    expect(studioErrorSchema.parse(await response.json()).error.code).toBe("name_pro_length");
  });

  test("AC16: a change holds the old handle forever and writes its redirect; a second change is limited", async () => {
    const response = await put(a, second);
    expect(response.status(), await response.text()).toBe(200);
    const changed = handleChangeResultSchema.parse(await response.json());
    expect(changed.handle).toBe(second);
    expect(changed.nextChangeOn).not.toBeNull();

    const [hold] = await db.execute<{ user_id: string | null; reason: string; forever: boolean }>(
      sql`select user_id, reason, held_until = 'infinity'::timestamptz as forever from name_holds where name = ${first}`,
    );
    expect({ ...hold }).toEqual({ user_id: aId, reason: "renamed", forever: true });
    const [redirect] = await db
      .select()
      .from(schema.handleRedirects)
      .where(eq(schema.handleRedirects.oldHandle, first));
    expect(redirect?.profileId).toBe(aId);

    // The redirect record the Worker reads — the pointer, byte-identical to KV.
    const body = await r2Store().get(pointerKey(first));
    const entry = kvEntrySchema.parse(JSON.parse(body!));
    expect(isRedirectManifest(entry) && entry.redirectTo).toBe(second);

    // The old handle is nobody's to take now, its owner's page included.
    expect(await check(b, first)).toEqual({ status: "taken" });

    expect(await check(a, third)).toEqual({ status: "handle_change_limited", availableOn: changed.nextChangeOn });
    const again = await put(a, third);
    expect(again.status(), await again.text()).toBe(429);
    const refusal = studioErrorSchema.parse(await again.json()).error;
    expect(refusal.code).toBe("handle_change_limited");
    expect(refusal.message).toMatch(/^You can change your handle again on /);
    const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, aId));
    expect(row?.handle).toBe(second);
  });

  test("@edge the old host 301s to the same path on the new host", async () => {
    const from = `https://${first}.${servingDomain()}/deep/path.html?x=1`;
    const to = `https://${second}.${servingDomain()}/deep/path.html?x=1`;
    const deadline = Date.now() + EDGE_WAIT_MS;
    let status = 0;
    let location: string | null = null;
    for (;;) {
      const res = await fetch(from, { redirect: "manual" });
      await res.body?.cancel();
      status = res.status;
      location = res.headers.get("location");
      if ((status === 301 && location === to) || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    expect({ status, location }).toEqual({ status: 301, location: to });
  });
});
