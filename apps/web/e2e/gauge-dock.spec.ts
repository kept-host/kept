import { test, expect, type Page } from "@playwright/test";

import { deleteDrafts, SKIP_LIVE_PUBLISH, trackDrafts } from "./live-publish";

/**
 * The open-books gauge's "next free slot" dot, and the traveling drop tile that
 * docks onto it.
 *
 * The tile used to aim at the big open-books number — a one-glyph span at the
 * left column's left edge — so it parked against the viewport's left edge for
 * the whole approach, then parked as a 72–104px square that overshot the grid
 * gap and sat on top of the dot field. It now docks as a ~40px accent disc
 * centred on the pulsing next-slot dot, and expands into the real drop panel on
 * hover *or* keyboard focus.
 *
 * Unlike the other landing specs this one does assert scroll-driven poses, so
 * every pose read goes through `expect.poll` — the engine lerps toward its
 * target at ~0.14/frame and needs a moment to settle.
 */

/** Accessible name of the slot control at the zero baseline. */
const SLOT_LABEL = "Drop an HTML file to keep your first page";

/** One frame-accurate read of everything the dock choreography drives. */
async function dockState(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector("#gauge-dots")!;
    const kids = [...grid.children];
    const slot = document.querySelector("#gauge-next-slot") as HTMLElement;
    const sb = slot.getBoundingClientRect();
    // The traveling tile is the one fixed, z-40 element on the page.
    const tile = [...document.querySelectorAll("div")].find((d) => {
      const s = getComputedStyle(d);
      return s.position === "fixed" && s.zIndex === "40";
    })!;
    const tb = tile.getBoundingClientRect();
    // The drop panel that the dock expands into — the same one #why opens.
    const panel = [...document.querySelectorAll("div")].find((d) =>
      d.textContent?.trim().startsWith("A LINK THAT LASTS"),
    );
    return {
      slotIndex: kids.indexOf(slot),
      slotOpacity: slot.style.opacity,
      slotCentre: [sb.left + sb.width / 2, sb.top + sb.height / 2],
      tile: [tb.left, tb.top, tb.width, tb.height],
      tileRadius: getComputedStyle(tile.firstElementChild!).borderRadius,
      panelOpacity: panel ? Number(getComputedStyle(panel).opacity) : null,
      firstDotBg: getComputedStyle(kids[0]!).backgroundColor,
      // Dots sit at opacity 0 until the field's scroll reveal fires.
      plainDotOpacity: getComputedStyle(kids[5]!).opacity,
    };
  });
}

/** Park the gauge's dot field at `frac` of the viewport height and let it settle. */
async function parkGauge(page: Page, frac: number) {
  await page.evaluate(
    (f) =>
      new Promise<void>((res) => {
        const root = document.querySelector("#kept-root")!;
        const wrap = document.querySelector("#gauge-dots")!.parentElement!;
        let n = 0;
        const step = () => {
          const d = wrap.getBoundingClientRect().top - f * window.innerHeight;
          if (Math.abs(d) < 1.5 || n++ > 400) return res();
          root.scrollTop += d;
          requestAnimationFrame(step);
        };
        step();
      }),
    frac,
  );
}

test.describe("gauge next-slot dock", () => {
  test("the next free slot is a real control, visibly not a kept-page dot", async ({
    page,
  }) => {
    await page.goto("/");

    const slot = page.getByRole("button", { name: SLOT_LABEL });
    await expect(slot).toHaveCount(1);
    await expect(slot).toHaveId("gauge-next-slot");

    const state = await dockState(page);
    // At the zero baseline the first unfilled slot is index 0. Solid accent
    // dots occupy 0..keptCount-1, so with nothing kept the slot leads the grid.
    expect(state.slotIndex).toBe(0);

    // It must never be mistaken for a kept page: kept/unlit dots are solid
    // fills with no border and carry `data-on` when they ripple; the slot is a
    // hollow accent ring that never carries `data-on`.
    const shape = await page.evaluate(() => {
      const grid = document.querySelector("#gauge-dots")!;
      const slotEl = document.querySelector("#gauge-next-slot")!;
      const plain = grid.children[5]!;
      return {
        slotBorderWidth: getComputedStyle(slotEl).borderTopWidth,
        slotHasDataOn: slotEl.hasAttribute("data-on"),
        plainBorderWidth: getComputedStyle(plain).borderTopWidth,
        litDots: grid.querySelectorAll('[data-on="1"]').length,
      };
    });
    expect(parseFloat(shape.slotBorderWidth)).toBeGreaterThan(0);
    expect(shape.slotHasDataOn).toBe(false);
    expect(parseFloat(shape.plainBorderWidth)).toBe(0);
    // Nothing is kept yet, so nothing ripples — the panel's "every dot is a
    // page kept online right now" stays literally true.
    expect(shape.litDots).toBe(0);
  });

  test("the tile docks beside the slot dot instead of the left edge", async ({
    page,
  }) => {
    await page.goto("/");
    await parkGauge(page, 0.3);

    // The tile lerps toward its target ~0.14/frame; wait for it to settle level
    // with the dot before reading the pose.
    await expect
      .poll(
        async () => {
          const p = await dockState(page);
          return Math.round(
            Math.abs(p.tile[1]! + p.tile[3]! / 2 - p.slotCentre[1]!),
          );
        },
        { timeout: 15_000 },
      )
      .toBeLessThanOrEqual(1);

    const s = await dockState(page);
    const [left, , w, h] = s.tile as [number, number, number, number];

    // A small rounded box, not the old 72–104px square and not a disc — it sits
    // next to the dot field, so it must not read as another dot.
    expect(s.tileRadius).not.toBe("50%");
    expect(w).toBeGreaterThan(30);
    expect(w).toBeLessThan(48);
    expect(Math.abs(w - h)).toBeLessThan(1);

    // It lands to the LEFT of the pulsing dot and clear of it — the box points
    // at the dot, so covering the dot would hide the thing being pointed at.
    expect(left + w).toBeLessThanOrEqual(s.slotCentre[0]!);

    // And the dot stays visible the whole time.
    expect(s.slotOpacity).toBe("1");

    // The old bug parked the tile at x ≈ 130–180 (transit()'s left clamp) and
    // dragged it across the left column. Nothing may sit left of the dot field.
    const dotsLeft = await page.evaluate(
      () => document.querySelector("#gauge-dots")!.getBoundingClientRect().left,
    );
    // The old bug parked it at x ≈ 130–180 via transit()'s left clamp. It may
    // now sit just left of the field (the gap + its own width) but no further:
    // anything beyond that is drifting back toward the left column.
    expect(left).toBeGreaterThan(dotsLeft - (w + 24));
  });

  test("the dock never crosses the left column's text at any scroll position", async ({
    page,
  }) => {
    await page.goto("/");

    // Sweep the whole window in which the gauge choreography owns the tile.
    for (let f = 0.95; f >= -0.25; f -= 0.1) {
      await parkGauge(page, +f.toFixed(2));
      await page.waitForTimeout(900);
      const hits = await page.evaluate(() => {
        const tile = [...document.querySelectorAll("div")].find((d) => {
          const s = getComputedStyle(d);
          return s.position === "fixed" && s.zIndex === "40";
        })!;
        const tb = tile.getBoundingClientRect();
        // Every rendered text run in the gauge card's left column.
        const col = document.querySelector("#gauge-grid")!.children[0]!;
        const walk = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
        const boxes: DOMRect[] = [];
        let n: Node | null;
        while ((n = walk.nextNode())) {
          if (!n.nodeValue?.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          for (const r of rg.getClientRects())
            if (r.width > 1 && r.height > 1) boxes.push(r);
        }
        return boxes.filter(
          (r) =>
            tb.left < r.right - 1 &&
            tb.right > r.left + 1 &&
            tb.top < r.bottom - 1 &&
            tb.bottom > r.top + 1,
        ).length;
      });
      expect(hits, `tile overlaps left-column text at frac ${f.toFixed(2)}`).toBe(
        0,
      );
    }
  });

  test("hovering the dock expands it into the drop panel", async ({ page }) => {
    await page.goto("/");
    await parkGauge(page, 0.3);
    // Settle: the docked box is ~40px wide, well short of the 300px panel.
    await expect
      .poll(async () => Math.round((await dockState(page)).tile[2]!), {
        timeout: 15_000,
      })
      .toBeLessThan(48);

    const [cx, cy] = (await dockState(page)).slotCentre;
    await page.mouse.move(cx!, cy!);

    await expect
      .poll(async () => (await dockState(page)).panelOpacity, {
        timeout: 10_000,
      })
      .toBe(1);
    const s = await dockState(page);
    expect(s.tile[2]).toBeGreaterThan(250);
    // Expanded it is the full drop panel, which carries the card radius —
    // neither the dock's rounded box nor #why's disc.
    expect(s.tileRadius).toBe("14px");
  });

  test("leaving the gauge goes straight to the link icon, never back through the drop box", async ({
    page,
  }) => {
    await page.goto("/");
    await parkGauge(page, 0.3);
    await expect
      .poll(async () => Math.round((await dockState(page)).tile[2]!), {
        timeout: 15_000,
      })
      .toBeLessThan(48);

    // Scroll out of the gauge and into #why. The exit used to blend through
    // transit(), which re-inflated the tile to a 128px card — so the sequence
    // read upload box → drop box → link icon. It must now go straight from one
    // small form to the other, so the width never balloons on the way.
    const widths: number[] = [];
    for (let f = 0.0; f >= -0.6; f -= 0.05) {
      await parkGauge(page, +f.toFixed(2));
      await page.waitForTimeout(260);
      const w = (await dockState(page)).tile[2]!;
      // Ignore the hover panel if the pointer happens to sit near the dock.
      if ((await dockState(page)).panelOpacity !== 1) widths.push(w);
    }
    const peak = Math.max(...widths);
    expect(
      peak,
      `tile inflated to ${Math.round(peak)}px between the dock and the link icon`,
    ).toBeLessThan(72);
  });

  test("keyboard focus reaches the slot and opens the same panel", async ({
    page,
  }) => {
    // Arm the file-chooser interception up front. Playwright turns CDP's
    // `Page.setInterceptFileChooser` on lazily and fire-and-forget, the moment
    // the first `filechooser` listener is attached — so attaching it inline
    // right before the key press races the key event itself. When it loses,
    // the chooser opens un-intercepted and no event *ever* arrives (~30% of
    // runs measured; a second press always succeeded, proving the app fired
    // the input click both times). Attaching here means every round-trip
    // below has long since flushed it.
    const choosers: unknown[] = [];
    page.on("filechooser", (c) => choosers.push(c));

    await page.goto("/");

    // The slot follows the left column's last control in DOM order, so it is a
    // single Tab away — it is genuinely in the tab order, not aria-hidden with
    // pointer-events off the way the #why chain link is.
    await page.getByRole("link", { name: /See the math/ }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: SLOT_LABEL })).toBeFocused();

    // Focus alone opens the panel — no pointer involved.
    await expect
      .poll(async () => (await dockState(page)).panelOpacity, {
        timeout: 10_000,
      })
      .toBe(1);
    expect((await dockState(page)).tile[2]).toBeGreaterThan(250);

    // …and the dot stays visible under it, so its focus ring is not occluded.
    expect((await dockState(page)).slotOpacity).toBe("1");

    // Enter activates the file browse, so a keyboard user can actually publish.
    // Re-assert focus first: the reads above are lag-insensitive (the engine
    // lerps at ~0.14/frame, so they keep passing for ~1s after any change), and
    // pressing Enter at nothing is indistinguishable from a broken handler.
    await expect(page.getByRole("button", { name: SLOT_LABEL })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => choosers.length, { timeout: 10_000 }).toBe(1);
  });

  /**
   * A mint is a REAL publish since E04 task 007 replaced the simulated one, so
   * this test needs the dev stores and skips without them. The gate and the
   * teardown are shared with `publish-flow.spec.ts`; the draft it creates is
   * deleted through the anonymous manage API at the end.
   */
  test("a mint fills the slot and moves the pulse to the next one, without touching the baseline", async ({
    page,
    request,
  }) => {
    test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
    const drafts = trackDrafts(page);
    await page.goto("/");
    // Bring the field into view first: the number counts up on reveal, so a
    // mint before that has nothing to add to yet.
    await parkGauge(page, 0.3);
    await expect
      .poll(async () => (await dockState(page)).plainDotOpacity, {
        timeout: 15_000,
      })
      .toBe("1");
    expect((await dockState(page)).slotIndex).toBe(0);

    await page.setInputFiles('input[type="file"]', {
      name: "hello.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><title>hi</title><h1>hello</h1>"),
    });

    // The mint lands: index 0 becomes a real kept-page dot and the pulse steps
    // on to index 1, signalling "ready for the next upload".
    await expect
      .poll(async () => (await dockState(page)).slotIndex, { timeout: 10_000 })
      .toBe(1);
    expect((await dockState(page)).firstDotBg).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page.locator("#gauge-card span").first()).toHaveText("1");

    // The nav noun agrees with the count. Zero is plural, exactly one is not —
    // the count only became reachable when the slot dock landed, so "1 PAGES
    // KEPT" was live until the label was taught to agree.
    await expect
      .poll(async () =>
        (
          await page.locator("header").first().innerText()
        ).replace(/\s+/g, " "),
      )
      .toContain("1 PAGE KEPT");

    // Session-local only. `landing-stats` is untouched, so a reload is back at
    // the honest global baseline — the figure is never fabricated forward.
    await page.reload();
    await expect(page.locator("#gauge-card span").first()).toHaveText("0");
    expect((await dockState(page)).slotIndex).toBe(0);
    expect(
      (await page.locator("header").first().innerText()).replace(/\s+/g, " "),
    ).toContain("0 PAGES KEPT");

    await deleteDrafts(request, drafts);
  });
});
