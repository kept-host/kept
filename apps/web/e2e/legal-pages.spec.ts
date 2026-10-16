import { ABUSE_CONTACT_EMAIL } from "@kept/shared";
import { expect, test } from "@playwright/test";

/**
 * The legal pages (E06a, PRD §6 / D8, AC18–AC19; E07 AC29). Open mode, single
 * origin locally: every page renders its file's first heading, `/impressum` is
 * a 308 to `/legal/impressum`, any other `/legal/*` 404s, and the DRAFT banner
 * shows while any `[[…]]` placeholder remains. E07: the acceptable-use page
 * exists, and the Impressum, the privacy policy and the acceptable-use page
 * all point reporters at `/report`.
 */
const PAGES = [
  { path: "/legal/impressum", heading: "Impressum" },
  { path: "/legal/privacy", heading: "Privacy policy" },
  { path: "/legal/acceptable-use", heading: "Acceptable use" },
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
      await expect(
        legal.getByRole("link", { name: "Acceptable use", exact: true })
      ).toBeVisible();
    });
  }

  test("AC29: the Impressum, privacy policy and acceptable-use page link to /report", async ({
    page,
  }) => {
    for (const { path } of PAGES) {
      await page.goto(path);
      const report = page.locator("article a[href='/report']");
      console.log(`[legal] ${path} /report links: ${await report.count()}`);
      await expect(report.first()).toBeVisible();
      await expect(page.locator("article")).toContainText(ABUSE_CONTACT_EMAIL);
    }

    await page.goto("/legal/privacy");
    const article = page.locator("article");
    await expect(
      article.getByRole("heading", { level: 2, name: /Checking pages for abuse/ })
    ).toBeVisible();
    await expect(
      article.getByRole("heading", { level: 2, name: /^\d+\. Reports$/ })
    ).toBeVisible();
    await expect(article).not.toContainText("No automated decisions");

    // The acceptable-use page is finished text (D-67): rules 1–7, no placeholder.
    await page.goto("/legal/acceptable-use");
    for (let rule = 1; rule <= 7; rule += 1) {
      await expect(
        page.getByRole("heading", { level: 3, name: new RegExp(`^Rule ${rule}:`) })
      ).toBeVisible();
    }
    expect(await page.locator("article").innerHTML()).not.toContain("[[");
  });

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
