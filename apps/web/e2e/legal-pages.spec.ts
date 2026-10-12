import { expect, test } from "@playwright/test";

/**
 * The legal pages (E06a, PRD §6 / D8, AC18–AC19). Open mode, single origin
 * locally: both pages render their file's first heading, `/impressum` is a 308
 * to `/legal/impressum`, any other `/legal/*` 404s, and the DRAFT banner shows
 * while the delivered `[[…]]` placeholders remain.
 */
const PAGES = [
  { path: "/legal/impressum", heading: "Impressum" },
  { path: "/legal/privacy", heading: "Privacy policy" },
] as const;

test.describe("legal pages", () => {
  for (const { path, heading } of PAGES) {
    test(`${path} renders its text, the DRAFT banner and the legal links`, async ({
      page,
    }) => {
      const res = await page.goto(path);
      console.log(`[legal] GET ${path} → ${res?.status()}`);
      expect(res?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: heading })
      ).toBeVisible();
      const html = await page.content();
      if (html.includes("[[")) {
        await expect(
          page.getByRole("status").filter({ hasText: "DRAFT" })
        ).toBeVisible();
      }
      const legal = page.getByRole("navigation", { name: "Legal" });
      await expect(
        legal.getByRole("link", { name: "Impressum", exact: true })
      ).toBeVisible();
      await expect(
        legal.getByRole("link", { name: "Privacy", exact: true })
      ).toBeVisible();
    });
  }

  test("/impressum is a 308 to /legal/impressum", async ({ request }) => {
    const res = await request.get("/impressum", { maxRedirects: 0 });
    console.log(
      `[legal] GET /impressum → ${res.status()} ${res.headers()["location"]}`
    );
    expect(res.status()).toBe(308);
    expect(
      new URL(res.headers()["location"] ?? "", "https://localhost:3000")
        .pathname
    ).toBe("/legal/impressum");
  });

  test("an unknown /legal/* doc is a 404", async ({ request }) => {
    const res = await request.get("/legal/terms", { maxRedirects: 0 });
    console.log(`[legal] GET /legal/terms → ${res.status()}`);
    expect(res.status()).toBe(404);
  });
});
