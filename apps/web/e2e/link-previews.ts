import { expect, test, type APIRequestContext } from "@playwright/test";

import { keptOpen } from "../lib/launch";

/**
 * Link previews and favicons (E06a §8, AC22), over HTTP on the running server.
 * The image bytes themselves are asserted in `lib/og/brand.test.ts`; this flow
 * checks that the apex and `/founding` link them absolutely, and that every
 * image and icon is served — in closed mode too, where the dotted paths must
 * get past no gate at all.
 */
const PAGES = [
  { path: "/", image: "/og.png" },
  { path: "/founding", image: "/founding/og.png" },
] as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function fetchImage(request: APIRequestContext, path: string, type: string) {
  const res = await request.get(path, { maxRedirects: 0 });
  console.log(`[previews] GET ${path} → ${res.status()} ${res.headers()["content-type"]}`);
  expect(res.status(), path).toBe(200);
  expect(res.headers()["content-type"], path).toContain(type);
  return new Uint8Array(await res.body());
}

function pngSize(bytes: Uint8Array): [number, number] {
  expect([...bytes.subarray(0, 8)], "PNG signature").toEqual(PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

export function linkPreviewsFlow(mode: "open" | "closed"): void {
  test.describe(`link previews and favicons (${mode})`, () => {
    test.skip(
      keptOpen() !== (mode === "open"),
      mode === "open" ? "the harness is closed" : "the harness is open — run `pnpm test:e2e:closed`",
    );

    for (const { path, image } of PAGES) {
      test(`AC22: ${path} serves title, description, og:* and a 1200×630 card`, async ({
        page,
        request,
      }) => {
        await page.goto(path);
        const meta = (key: string) =>
          page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute("content");

        expect((await page.title()).length).toBeGreaterThan(0);
        expect(await meta("description")).toBeTruthy();
        expect(await meta("og:title")).toBeTruthy();
        expect(await meta("og:description")).toBe(await meta("description"));
        expect(await meta("og:image:width")).toBe("1200");
        expect(await meta("og:image:height")).toBe("630");
        expect(await meta("twitter:card")).toBe("summary_large_image");
        if (mode === "closed") expect(await meta("description")).toContain("December");

        const ogImage = new URL((await meta("og:image"))!);
        expect(ogImage.protocol, "og:image is absolute https").toBe("https:");
        expect(ogImage.pathname).toBe(image);
        expect(await meta("twitter:image")).toBe(ogImage.href);

        expect(pngSize(await fetchImage(request, image, "image/png"))).toEqual([1200, 630]);
      });
    }

    test("AC22: favicon.ico, the SVG icon and the apple-touch-icon are served and linked", async ({
      page,
      request,
    }) => {
      const ico = await fetchImage(request, "/favicon.ico", "image/x-icon");
      expect([...ico.subarray(0, 4)], "ICO header").toEqual([0, 0, 1, 0]);
      expect(pngSize(ico.subarray(22))).toEqual([32, 32]);

      const svg = new TextDecoder().decode(await fetchImage(request, "/icon.svg", "image/svg+xml"));
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

      expect(pngSize(await fetchImage(request, "/apple-touch-icon.png", "image/png"))).toEqual([
        180, 180,
      ]);

      await page.goto("/");
      await expect(page.locator('link[rel="icon"][href^="/favicon.ico"]')).toHaveCount(1);
      await expect(page.locator('link[rel="icon"][href^="/icon.svg"]')).toHaveCount(1);
      await expect(page.locator('link[rel="apple-touch-icon"][href^="/apple-touch-icon.png"]')).toHaveCount(1);
    });
  });
}
