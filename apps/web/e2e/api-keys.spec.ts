import { createHash } from "node:crypto";

import {
  API_KEY_LIMIT_MESSAGE,
  API_KEYS_PER_ACCOUNT,
  apiKeyPattern,
  apiKeySummarySchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { keyCallerFrom } from "../lib/agents/keys";
import { insertApiKey } from "../lib/db/queries/api-keys";
import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * Settings → Agents and API keys, in a real browser against the REAL dev
 * stack — E09 task 006 (D6, PRD §8).
 *
 * Create → copy once → listed → revoke, and the empty and limit states. The
 * revoked key's refusal is read through `keyCallerFrom` (the one bearer
 * resolver every keyed route calls) until `/api/v1` exists (task 008).
 *
 * 0 publishes, 0 KV writes: keys are Postgres rows only.
 *
 * ⚠️ NO KEY IS PRINTED. Every comparison against a raw key is a boolean with a
 * message that does not carry it, so a failure cannot write one to the
 * console or a report. Traces of this spec are never committed.
 *
 * SKIPS without dev credentials.
 */
const scope = newScope();

const sameOrigin = (baseURL: string) => ({ origin: new URL(baseURL).origin });

async function openAgentsSection(page: Page) {
  await page.goto("/settings");
  await waitForTokensApplied(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents and API keys" })
    .click();
}

function bearer(key: string): Request {
  return new Request("https://localhost:3000/api/v1/pages", {
    headers: { authorization: `Bearer ${key}` },
  });
}

test.describe("Settings → Agents and API keys", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("agent cards, then create → the key shown once with Copy → listed → revoked and refused on reuse", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL!).origin,
    });
    await openAgentsSection(page);

    // The four cards, Claude chat as a smaller fifth, no ChatGPT (D11).
    for (const id of ["codex", "claude-code", "cursor", "any", "claude-chat"]) {
      await expect(page.getByTestId(`agent-card-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("agents-panel")).not.toContainText(/chatgpt/i);
    await page.getByTestId("agent-card-codex").getByRole("button", { name: /^Copy/ }).click();
    await expect(page.getByTestId("agent-card-codex").getByRole("button", { name: /Copied/ })).toBeVisible();

    // Empty state, with the PRD sentence.
    await expect(page.getByTestId("api-keys-empty")).toHaveText(
      "No keys yet. Keys let your agents publish straight into your account.",
    );
    await expect(page.getByTestId("api-keys-count")).toHaveText(`0 of ${API_KEYS_PER_ACCOUNT}`);

    // Create.
    await expect(page.getByTestId("api-key-create")).toBeDisabled();
    await page.getByLabel("Key name").fill("E09-006 laptop");
    await page.getByTestId("api-key-create").click();

    const dialog = page.getByTestId("api-key-created");
    await expect(dialog).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(dialog).toContainText("You won’t see this again.");
    const shown = (await dialog.locator("pre").innerText()).trim();
    expect(apiKeyPattern.test(shown), "the dialog shows a well-formed key").toBe(true);

    await dialog.getByRole("button", { name: /^Copy/ }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard === shown, "Copy puts exactly the shown key on the clipboard").toBe(true);

    // Stored as its digest only.
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId));
    expect(row, "one key row").toBeTruthy();
    expect(row!.hash === createHash("sha256").update(shown).digest("hex"), "hash is SHA-256").toBe(true);
    expect(Object.values(row!).some((value) => value === shown), "no column holds the key").toBe(false);
    expect(await keyCallerFrom(bearer(shown)), "the new key resolves").not.toBeNull();

    // Done: the key leaves the page and never comes back.
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    expect((await page.content()).includes(shown), "the key is gone from the DOM").toBe(false);

    await page.reload();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Agents and API keys" })
      .click();
    const rows = page.getByTestId("api-key-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("E09-006 laptop");
    await expect(rows.first()).toContainText(`${row!.prefix}…`);
    // `keyCallerFrom` above stamped today's use.
    await expect(rows.first()).not.toContainText("Never");
    await expect(page.getByTestId("api-keys-count")).toHaveText(`1 of ${API_KEYS_PER_ACCOUNT}`);
    expect((await page.content()).includes(shown), "a reload never shows the key").toBe(false);

    // GET /api/keys: summaries only.
    const listed = await page.request.get(`${baseURL}/api/keys`);
    expect(listed.status()).toBe(200);
    const listedBody = (await listed.json()) as { keys: unknown[] };
    expect(listedBody.keys).toHaveLength(1);
    expect(Object.keys(apiKeySummarySchema.strict().parse(listedBody.keys[0])).sort()).toEqual(
      ["created_at", "id", "last_used_on", "name", "prefix"].sort(),
    );

    // Revoke, behind its confirm.
    await rows.first().getByRole("button", { name: /^Revoke/ }).click();
    const confirm = page.getByTestId("api-key-revoke-dialog");
    await expect(confirm).toContainText("Revoke E09-006 laptop?");
    await confirm.getByTestId("api-key-revoke-confirm").click();
    await expect(confirm).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId("api-keys-empty")).toBeVisible();

    const [revoked] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, row!.id));
    expect(revoked!.revokedAt, "revoked_at is stamped").not.toBeNull();
    expect(await keyCallerFrom(bearer(shown)), "a revoked key is refused on its next use").toBeNull();
  });

  test(`limit: at ${API_KEYS_PER_ACCOUNT} keys the form gives way to the PRD sentence, and POST answers key_limit_reached`, async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);

    // A malformed name is the generic request refusal.
    const unnamed = await page.request.post(`${baseURL}/api/keys`, {
      headers: sameOrigin(baseURL!),
      data: { name: "   " },
    });
    expect(unnamed.status()).toBe(400);
    expect(studioErrorSchema.parse(await unnamed.json()).error.code).toBe("invalid_request");

    // Fill the account straight through the query: the rows are what count.
    for (let i = 0; i < API_KEYS_PER_ACCOUNT; i++) {
      const filled = await insertApiKey(userId, {
        name: `E09-006 limit ${i}`,
        prefix: "kpt_live_e2e0",
        hash: `e09-006-${crypto.randomUUID()}`,
      });
      expect(filled, `key ${i}`).not.toBeNull();
    }

    await openAgentsSection(page);
    await expect(page.getByTestId("api-key-row")).toHaveCount(API_KEYS_PER_ACCOUNT);
    await expect(page.getByTestId("api-keys-limit")).toHaveText(API_KEY_LIMIT_MESSAGE);
    await expect(page.getByTestId("api-keys-limit")).toHaveText(
      `You have ${API_KEYS_PER_ACCOUNT} keys. Revoke one to create another.`,
    );
    await expect(page.getByTestId("api-key-create")).toHaveCount(0);

    const over = await page.request.post(`${baseURL}/api/keys`, {
      headers: sameOrigin(baseURL!),
      data: { name: "one too many" },
    });
    expect(over.status()).toBe(409);
    const refusal = studioErrorSchema.parse(await over.json()).error;
    expect(refusal).toEqual({ code: "key_limit_reached", message: API_KEY_LIMIT_MESSAGE });
  });
});
