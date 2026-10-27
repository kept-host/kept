import { SKILL_INSTALL_COMMAND, agentPrompt, agentSetups } from "@kept/shared";
import { expect, test } from "@playwright/test";

/**
 * `/agents` and the four discovery files (E09 task 004). Read-only: no
 * publish, no KV write. The copy comes from `@kept/shared` (D12), so the spec
 * compares against the same functions rather than retyping a sentence.
 *
 * Locally `NEXT_PUBLIC_APP_URL` has no apex, so the base the server builds its
 * URLs from is the page's own origin.
 */
const DISCOVERY = [
  { path: "/skill.md", type: "text/markdown", starts: "---\nname: kept\n" },
  { path: "/llms.txt", type: "text/plain", starts: "# kept\n" },
  { path: "/.well-known/skills/index.json", type: "application/json", starts: '{"skills":[' },
  { path: "/install.sh", type: "text/x-shellscript", starts: "#!/bin/sh\n" },
] as const;

test.describe("/agents", () => {
  test("tabs, code blocks and a copy that puts the exact prompt on the clipboard", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const res = await page.goto("/agents");
    console.log(`[agents] GET /agents → ${res?.status()}`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("kept for agents · kept");
    await expect(page.getByRole("heading", { level: 1, name: "Let your agent publish." })).toBeVisible();

    const base = new URL(page.url()).origin;
    const setups = agentSetups(base);

    // The tabs, in order, Claude chat last.
    await expect(page.getByRole("tab")).toHaveText(setups.map((s) => s.name));

    // Every tab shows its install step and a Copy button per code block.
    for (const setup of setups) {
      await page.getByRole("tab", { name: setup.name }).click();
      const panel = page.getByRole("tabpanel");
      await expect(panel).toBeVisible();
      if (setup.install.code) await expect(panel.getByText(setup.install.code, { exact: true })).toBeVisible();
      const codes = [setup.install, setup.mcp, setup.account].filter((s) => s.code !== null).length + 1;
      await expect(panel.getByRole("button", { name: /^Copy / })).toHaveCount(codes);
      console.log(`[agents] tab ${setup.name}: ${codes} code blocks`);
    }

    // Code blocks are JetBrains Mono (the font-mono token).
    const family = await page.locator("pre").first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain("JetBrains Mono");

    // The prompt copy: copied state, live region, real clipboard read.
    await page.getByRole("button", { name: "Copy the prompt" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(page.getByText("Copied to the clipboard.")).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(agentPrompt(base));
    await expect(page.getByRole("button", { name: "Copy the prompt" })).toBeVisible({ timeout: 5_000 });

    // A tab's install command copies too.
    await page.getByRole("tab", { name: "Codex" }).click();
    await page.getByRole("button", { name: "Copy Codex: Install" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SKILL_INSTALL_COMMAND);

    // D11 / AC14: no copy for that chat app anywhere on the page, every tab included.
    for (const setup of setups) await page.getByRole("tab", { name: setup.name }).click();
    expect((await page.content()).toLowerCase()).not.toContain("chat" + "gpt");
  });

  for (const file of DISCOVERY) {
    test(`${file.path} serves with its content type and a five-minute cache`, async ({ request }) => {
      const res = await request.get(file.path, { maxRedirects: 0 });
      const type = res.headers()["content-type"] ?? "";
      console.log(`[agents] GET ${file.path} → ${res.status()} ${type}`);
      expect(res.status()).toBe(200);
      expect(type.startsWith(file.type)).toBe(true);
      expect(res.headers()["cache-control"]).toBe("public, max-age=300");
      const body = await res.text();
      expect(body.startsWith(file.starts)).toBe(true);
      expect(body.toLowerCase()).not.toContain("chat" + "gpt");
    });
  }
});
