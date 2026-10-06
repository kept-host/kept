/**
 * The mascot generator is PURE and PLATFORM-FREE, and it stays behind its own
 * subpath. Both properties are structural, so both are asserted rather than
 * reviewed.
 *
 * ── WHY THIS MATTERS ───────────────────────────────────────────────────────
 * `packages/shared/src/mascot/` is the one piece of behavioural code shared by
 * `apps/web` and `apps/edge`. The Worker renders a frozen frame of it inside a
 * Cloudflare isolate, where there is no `document`, no `window`, no `process`
 * and no `node:*`. A single such reference would not fail a typecheck — the
 * DOM lib is in scope in `apps/web`'s tsconfig — it would fail at runtime, on
 * the error path, which is the worst place in the product to find out.
 *
 * The subpath is the second half of it. `packages/shared` is consumed as raw
 * TypeScript with no build step and `src/index.ts` re-exports everything it
 * names, so a mascot re-export in the barrel would drag the 64-sample profile
 * and the ~470-entry blink calendar into every
 * `import { MAX_PAGE_BYTES } from "@kept/shared"` on the Worker's hot path.
 * `sideEffects: false` is a hint to a bundler, not a guarantee.
 *
 * ── WHY `apps/web` AND NOT `apps/edge` ─────────────────────────────────────
 * `apps/edge`'s vitest runs on real workerd via Miniflare and has no
 * filesystem. A source-text guard needs `node:fs`, so `apps/web`'s Node-based
 * unit suite is the only home. The precedent is
 * `lib/routing/configured-origins.test.ts`, and this file follows its shape:
 * the scan runs over `stripComments(source)`, because the mascot's headers
 * explain the platform-free contract in prose and one of them legitimately
 * says "same-document #fragment reference". Banning that text would delete the
 * documentation to satisfy the guard.
 *
 * That exclusion is what could make this vacuous, so each subject declares
 * verbatim CODE anchors that must survive the strip.
 *
 * Nothing here needs credentials or a network.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import { MASCOT_REST_T, mascotSvg } from "@kept/shared/mascot";

import { linesContaining, stripComments } from "../testing/strip-comments";

const MASCOT_DIR = new URL("../../../../packages/shared/src/mascot/", import.meta.url);
const SHARED_PKG = new URL("../../../../packages/shared/package.json", import.meta.url);
const SHARED_BARREL = new URL("../../../../packages/shared/src/index.ts", import.meta.url);
const SHARED_SRC = new URL("../../../../packages/shared/src/", import.meta.url);
const EDGE_SRC = new URL("../../../edge/src/", import.meta.url);
const EDGE_TEST = new URL("../../../edge/test/", import.meta.url);
const EDGE_PKG = new URL("../../../edge/package.json", import.meta.url);

/**
 * One verbatim code fragment per file, proving the comment strip left the logic
 * intact. If the scanner ever eats real code, this fails loudly instead of the
 * bans below going quiet.
 */
const ANCHORS: Record<string, string> = {
  "geometry.ts": "export function superellipseProfile(n: number, sx = 1, sy = 1): number[] {",
  "face.ts": "export function eyePoses(",
  "frame.ts": "export function mascotSvg(t: number, opts: MascotOptions): string {",
  "index.ts": 'export * from "./frame";',
};

/**
 * What may never appear in the CODE of the generator, and why each is fatal in
 * a Cloudflare isolate rather than merely untidy.
 */
const BANNED = [
  { literal: "document", why: "a DOM global — the Worker's isolate has no document" },
  { literal: "window", why: "a browser global — the Worker's isolate has no window" },
  {
    literal: "requestAnimationFrame",
    why: "a browser scheduler; the generator is a pure function of `t` and the rAF loop belongs to the React wrapper",
  },
  { literal: "Buffer", why: "a Node built-in that does not exist on workerd" },
  { literal: "process", why: "a Node global; nothing here may read the environment" },
  { literal: "node:", why: "a Node built-in import — `packages/shared` must stay runtime-neutral" },
] as const;

async function mascotFiles(): Promise<string[]> {
  const names = (await readdir(MASCOT_DIR)).filter((n) => n.endsWith(".ts")).sort();
  assert.ok(names.length >= 4, `expected the mascot module to have files, found ${names.join(", ")}`);
  return names;
}

test("every mascot source file declares an anchor that survives the comment strip", async () => {
  for (const name of await mascotFiles()) {
    const anchor = ANCHORS[name];
    assert.ok(
      anchor,
      `${name} has no anchor in this test. A new file under src/mascot/ must add one, or the ` +
        `bans below prove nothing about it.`,
    );
    const code = stripComments(await readFile(new URL(name, MASCOT_DIR), "utf8"));
    assert.ok(
      code.includes(anchor),
      `${name}: the comment strip removed code (${JSON.stringify(anchor)} is gone), so the bans ` +
        `below prove nothing. Fix the scanner in lib/testing/strip-comments.ts.`,
    );
  }
});

test("no DOM global and no Node API in the mascot generator's code", async () => {
  for (const name of await mascotFiles()) {
    const code = stripComments(await readFile(new URL(name, MASCOT_DIR), "utf8"));
    for (const { literal, why } of BANNED) {
      const hits = linesContaining(code, literal);
      assert.deepEqual(
        hits,
        [],
        `packages/shared/src/mascot/${name}:${hits.join(",")} — ${JSON.stringify(literal)} in ` +
          `code: ${why}. The generator is a pure function of time returning strings and numbers; ` +
          `every platform call belongs in the consumer. Naming it in a comment is fine — this ` +
          `scan already excludes comments.`,
      );
    }
  }
});

test("packages/shared gains no dependency for the mascot", async () => {
  const pkg = JSON.parse(await readFile(SHARED_PKG, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}).sort(),
    ["obscenity", "zod"],
    "packages/shared's dependencies must stay exactly { obscenity, zod }. The mascot is plain " +
      "TypeScript emitting SVG strings — no path-morph library, no colour library, nothing. " +
      "`obscenity` is the name rule's word list (E06 task 001) and is admitted only because " +
      "the next test pins it behind the ./names subpath.",
  );
  assert.equal(
    pkg.devDependencies,
    undefined,
    "packages/shared has no devDependencies and the mascot does not introduce any.",
  );
  assert.equal(
    pkg.exports?.["./mascot"],
    "./src/mascot/index.ts",
    "the ./mascot subpath must exist in packages/shared's exports map — it is what keeps the " +
      "blink calendar and the sample tables out of the Worker's hot path.",
  );
  assert.equal(
    pkg.exports?.["./names"],
    "./src/names.ts",
    "the ./names subpath must exist in packages/shared's exports map — it is the only door to " +
      "the obscenity word list.",
  );
});

/**
 * Every module specifier a source file imports, re-exports or requires.
 *
 * Scans RAW text rather than `stripComments` output: the stripper does not know
 * regex literals, and `names.ts` is exactly the kind of file that grows one.
 * The pattern only matches import-shaped text (`from "x"`, `import("x")`,
 * `import "x"`), so prose that names a module in backticks does not trip it.
 */
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g),
  ].map((m) => m[1]!);
}

async function tsFiles(dir: URL): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".ts")).sort();
}

test("obscenity is reachable only through the ./names subpath — never the barrel, the mascot or apps/edge", async () => {
  // packages/shared: `obscenity` is imported by names.ts alone, and nothing in
  // the package imports names.ts — so neither the barrel nor ./mascot (nor any
  // future module either of them pulls in) can carry the word list.
  const sharedFiles = await tsFiles(SHARED_SRC);
  assert.ok(sharedFiles.includes("names.ts"), "packages/shared/src/names.ts is missing");
  for (const name of sharedFiles) {
    const specifiers = importSpecifiers(await readFile(new URL(name, SHARED_SRC), "utf8"));
    if (name === "names.ts") {
      assert.ok(
        specifiers.includes("obscenity"),
        "names.ts no longer imports obscenity as this scan sees it, so the bans below prove " +
          "nothing. Fix importSpecifiers, or drop obscenity from packages/shared's dependencies.",
      );
      continue;
    }
    assert.equal(
      specifiers.includes("obscenity"),
      false,
      `packages/shared/src/${name} imports obscenity. Only names.ts may: every other module is ` +
        "reachable from the barrel or ./mascot, and both are on the Worker's import graph.",
    );
    const namesImports = specifiers.filter((s) => /(?:^\.{1,2}|^@kept\/shared)\/names$/.test(s));
    assert.deepEqual(
      namesImports,
      [],
      `packages/shared/src/${name} imports the name rule (${namesImports.join(", ")}). Nothing in ` +
        "packages/shared may — it would put the obscenity word list on the Worker's import graph. " +
        "Consumers import @kept/shared/names directly.",
    );
  }

  // apps/edge: the Worker and its workerd suite never import the subpath or the
  // library. Read-only scan; AC35 keeps the edge diff empty.
  const edgeSpecifiers: string[] = [];
  for (const dir of [EDGE_SRC, EDGE_TEST]) {
    for (const name of await tsFiles(dir)) {
      const specifiers = importSpecifiers(await readFile(new URL(name, dir), "utf8"));
      edgeSpecifiers.push(...specifiers);
      for (const banned of ["obscenity", "@kept/shared/names"]) {
        assert.equal(
          specifiers.includes(banned),
          false,
          `apps/edge/${dir === EDGE_SRC ? "src" : "test"}/${name} imports ${banned}. The Worker ` +
            "has no use for a word list; the name rule runs on the control plane only.",
        );
      }
    }
  }
  assert.ok(
    edgeSpecifiers.includes("@kept/shared"),
    "the apps/edge scan found no import of @kept/shared at all, so it is not reading imports — " +
      "the ban above proves nothing. Fix importSpecifiers or the edge paths.",
  );

  const edgePkg = JSON.parse(await readFile(EDGE_PKG, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(
    "obscenity" in { ...edgePkg.dependencies, ...edgePkg.devDependencies },
    false,
    "apps/edge must not depend on obscenity directly either.",
  );
});

test("the shared barrel does not re-export the mascot", async () => {
  const barrel = await readFile(SHARED_BARREL, "utf8");
  assert.equal(
    barrel.includes("mascot"),
    false,
    "packages/shared/src/index.ts names the mascot. Adding it to the barrel undoes the reason " +
      "the ./mascot subpath exists: every `import { MAX_PAGE_BYTES } from \"@kept/shared\"` on " +
      "the Worker's hot path would then pull the 64-sample profile and the blink calendar with it.",
  );
});

test("the frozen frame is script-free, data:-free, hex-free and deterministic", () => {
  const svg = mascotSvg(MASCOT_REST_T, { maskId: "kept-mascot-test" });

  assert.equal(/<script\b/i.test(svg), false, "the mascot must never emit a <script> element");
  assert.equal(
    /\bsrc\s*=/i.test(svg),
    false,
    "a src= attribute is a network request; the mascot is inline vector and nothing else",
  );
  assert.equal(
    /\bsrcset\s*=/i.test(svg),
    false,
    "a srcset= attribute is a remote image by another name",
  );
  assert.equal(
    svg.includes("data:"),
    false,
    "removing the last data: URI from the Worker's system pages is a goal of this epic",
  );
  assert.equal(
    /#[0-9a-fA-F]{3}\b/.test(svg),
    false,
    "no hex anywhere in the mascot: the body paints currentColor and the eyes var(--bg), which " +
      "is what makes the character theme-aware. Tokens are law.",
  );

  // Every url() is a same-document #fragment — the one arm of apps/edge's
  // expectSelfContained that this epic finally exercises.
  for (const [, url] of svg.matchAll(/url\(\s*['"]?([^)'"]*)/g)) {
    assert.ok(
      (url ?? "").startsWith("#"),
      `the mascot emitted url(${url}); only same-document #fragment references are permitted`,
    );
  }

  // The mask id is threaded through, not hardcoded — two mascots in one page
  // must not clip against each other.
  assert.ok(svg.includes('id="kept-mascot-test"'), "the mask must carry the caller's id");
  assert.ok(svg.includes("url(#kept-mascot-test)"), "the eyes must clip against the caller's mask");

  // Purity, and the precondition for task 005's snapshot being stable.
  assert.equal(
    mascotSvg(MASCOT_REST_T, { maskId: "kept-mascot-test" }),
    svg,
    "mascotSvg must be a pure function of (t, opts): apps/edge freezes one frame of the same " +
      "function apps/web animates, and a snapshot pins the emitted path.",
  );
});
