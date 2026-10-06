import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, publishOwned, readSite, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * `cleanup()` in `owner-fixtures.ts` removes every page its accounts own — not
 * only the pages a spec registered.
 *
 * The leak this guards: a UI publish is only registered once the test reads its
 * row back, so a run that failed before that left the page unregistered;
 * `cleanup()` then deleted the user, the FK nulled `owner_id`, and a live,
 * ownerless, permanent page went on serving on the dev edge — the exact shape
 * the account-deletion invariant forbids across the whole `sites` table.
 *
 * NO MOCKS: a real magic-link session, a real `POST /api/sites`, and the real
 * R2 objects and rows read back. SKIPS without dev credentials.
 */
const scope = newScope();

test.describe("e2e cleanup", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  // A second pass when the test already cleaned up; the only pass when it
  // failed before it could.
  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("a page the account published but the spec never registered is gone after cleanup", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    // Registered with a throwaway scope, so the one handed to `cleanup` never
    // hears of it — a UI publish whose test never reached its registration.
    const unregistered = await publishOwned(page, baseURL!, newScope(), "E06 unregistered");
    expect(scope.siteIds).not.toContain(unregistered.siteId);

    const row = await readSite(unregistered.siteId);
    expect(row.ownerId).toBe(userId);
    const objectKey = pageObjectKey(row.id, row.currentVersionId!);
    expect(await r2Store().get(objectKey)).toBe(unregistered.html);
    expect(await r2Store().get(pointerKey(unregistered.slug))).not.toBeNull();

    await cleanup(scope);

    expect(
      await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.id, row.id)),
      "the row is gone, not left live with its owner nulled",
    ).toEqual([]);
    // The pointer is written and deleted in the same call as the KV key
    // (`lib/storage/kv` may not be imported here — lint), so its absence is the
    // manifest's absence: the edge has nothing to serve.
    expect(await r2Store().get(pointerKey(unregistered.slug))).toBeNull();
    expect(await r2Store().get(objectKey)).toBeNull();
    expect(
      await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)),
    ).toEqual([]);
  });
});
