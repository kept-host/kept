/**
 * The take-and-leave line, enforced. Two structural claims that a comment
 * cannot defend, asserted over the source text of every tree that ships.
 *
 * ── D2: THE TECHNIQUE CROSSED OVER, THE CHARACTER DID NOT ───────────────────
 * `packages/shared/src/mascot/` reuses bloub's engineering (fixed-sample radial
 * profiles, `superellipseProfile`, `normalize`, `blend`, `toPoints`,
 * `closedPath`) and none of its measurement. bloub describes itself as an SVG
 * recreation of another company's avatar, taken off the reference frame by
 * frame; its eye split, eye dimensions, rest gaze and shape library ARE that
 * measurement. Copying any of them would carry that company's trade dress into
 * kept's brand — the one thing a mascot exists to make recognisable.
 *
 * The PRD names this as the decision most likely to be re-litigated by whoever
 * finds the source's `profiles.ts` and notices that copying it would save an
 * afternoon. That person will not read a comment. They will run CI.
 *
 * ── D3: ONE IMPLEMENTATION, NOT TWO THAT AGREED ONCE ────────────────────────
 * D3 is trivially satisfiable in a worthless way: ship the generator, then
 * hand-tune the Worker's SVG once and never regenerate it. Task 005's pinned
 * `d` in `apps/edge/test/system-pages.test.ts` is one half of the defence.
 * This is the other: exactly one definition of the superellipse profile and of
 * `closedPath` exists, both under `packages/shared/src/mascot/`, and neither
 * app carries path-building code of its own — `apps/edge` may only call
 * `mascotSvg` through the `@kept/shared/mascot` subpath.
 *
 * ── COMMENTS ARE **NOT** STRIPPED HERE, AND THAT IS DELIBERATE ──────────────
 * `lib/routing/configured-origins.test.ts` and `lib/mascot/generator-contract.test.ts`
 * both scan `stripComments(source)`, because the files they guard explain the
 * rule by quoting the very hostnames and globals it bans. **The opposite is
 * true of this guard.** A comment reading "we deliberately did not copy
 * `EYE_SPLIT = 15.46`" is precisely the paste that must not exist: the number
 * would then be sitting in the repo, in context, for the next person to lift.
 * The attribution headers state the decision without reciting the values (see
 * `packages/shared/src/mascot/geometry.ts`), and they must keep doing so.
 * Do not "fix" the inconsistency with the routing guard — it is the point.
 *
 * ── WHY IT LIVES IN `apps/web` ─────────────────────────────────────────────
 * `apps/edge`'s vitest runs on real workerd via Miniflare and has no
 * filesystem, so a source-text guard cannot exist there. `apps/web`'s
 * `tsx --test` suite is the only Node-based home. **One home, not two** — there
 * is deliberately no shell grep in a workflow file duplicating this.
 *
 * Nothing here needs credentials or a network.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const REPO_ROOT = new URL("../../../../", import.meta.url);

/** This file, relative to the repo root — the one path excluded from the scan. */
const SELF = "apps/web/lib/mascot/take-and-leave-guards.test.ts";

/**
 * The source trees only. Everything else is excluded for a stated reason:
 *
 * · `.agent/` — the PRD, the epic and the task files QUOTE every forbidden
 *   number, because a written record of what was not taken is the whole
 *   artefact of the decision. Scanning them makes this guard fail on its own
 *   documentation.
 * · `THIRD-PARTY.md` and `LICENSE-bloub` — the MIT notice, required verbatim.
 * · `.next/`, `dist/`, `node_modules/`, `.wrangler/`, `.turbo/` — build output;
 *   nothing there is authored, and `node_modules` contains other people's code.
 * · This file — it necessarily contains every needle it looks for. Excluded by
 *   exact path, and the exclusion is asserted to match exactly one file below.
 */
const SCAN_ROOTS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/edge/src",
  "apps/edge/test",
  "packages/shared/src",
] as const;

const SCAN_EXTENSIONS = [".ts", ".tsx", ".css"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".wrangler", ".turbo"]);

interface ScannedFile {
  /** Repo-root-relative, POSIX separators. */
  path: string;
  text: string;
}

async function walk(rel: string, out: ScannedFile[]): Promise<void> {
  const entries = await readdir(new URL(rel, REPO_ROOT), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(child, out);
      continue;
    }
    if (!SCAN_EXTENSIONS.includes(path.extname(entry.name))) continue;
    if (child === SELF) continue;
    out.push({ path: child, text: await readFile(new URL(child, REPO_ROOT), "utf8") });
  }
}

let cached: ScannedFile[] | undefined;

async function scan(): Promise<ScannedFile[]> {
  if (!cached) {
    const out: ScannedFile[] = [];
    for (const root of SCAN_ROOTS) await walk(root, out);
    cached = out;
  }
  return cached;
}

function fileNamed(files: readonly ScannedFile[], rel: string): ScannedFile {
  const found = files.find((f) => f.path === rel);
  assert.ok(found, `${rel} was not reached by the scan — the roots or the walk are broken.`);
  return found;
}

/** Every 1-indexed line of `text` matching `pattern`. */
function linesMatching(text: string, pattern: RegExp): number[] {
  const per = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return text
    .split("\n")
    .map((line, index) => (per.test(line) ? index + 1 : 0))
    .filter((line) => line > 0);
}

/*
 * ─── The anti-vacuousness anchor ───────────────────────────────────────────
 * A guard that scans nothing passes silently forever. Following
 * `configured-origins.test.ts`, the scan proves it reached real code before any
 * ban below is trusted: named files must be present, non-empty, and carry
 * kept's OWN face constants — the values that exist precisely because the
 * measured ones were not taken.
 */

/** Files the scan must have reached, with a verbatim fragment each must contain. */
const REACHED = [
  { path: "packages/shared/src/mascot/geometry.ts", contains: "export const MASCOT_SAMPLES = 64;" },
  { path: "packages/shared/src/mascot/face.ts", contains: "export const KEPT_EYE_SPLIT = 24;" },
  { path: "packages/shared/src/mascot/frame.ts", contains: "export function mascotSvg(" },
  { path: "apps/edge/src/system-pages.ts", contains: "const MASCOT_SAMPLES_EDGE = 32;" },
  { path: "apps/edge/test/system-pages.test.ts", contains: "const MASCOT_D_EDGE =" },
  { path: "apps/web/components/kept/mascot.tsx", contains: "mascotFrame" },
] as const;

/** kept's own face — chosen by inspection, not measured off anyone's avatar. */
const KEPT_FACE_CONSTANTS = [
  "KEPT_EYE_SPLIT",
  "KEPT_EYE_W",
  "KEPT_EYE_H",
  "KEPT_EYE_TILT",
  "KEPT_EYE_INSET",
] as const;

test("the scan reaches the real mascot sources, so the bans below are not vacuous", async () => {
  const files = await scan();

  assert.ok(
    files.length >= 40,
    `the scan found only ${files.length} files across ${SCAN_ROOTS.join(", ")}. A broken glob is ` +
      `how a source-text guard goes quietly vacuous — fix the walk, do not lower this floor.`,
  );

  for (const { path: rel, contains } of REACHED) {
    const file = fileNamed(files, rel);
    assert.ok(file.text.length > 0, `${rel} is empty — this guard would assert nothing about it.`);
    assert.ok(
      file.text.includes(contains),
      `${rel} no longer contains ${JSON.stringify(contains)}. Either the scan is reading the ` +
        `wrong file or the subject moved; either way the bans below prove less than they claim.`,
    );
  }

  const face = fileNamed(files, "packages/shared/src/mascot/face.ts");
  for (const name of KEPT_FACE_CONSTANTS) {
    assert.ok(
      face.text.includes(`export const ${name} =`),
      `packages/shared/src/mascot/face.ts no longer exports ${name}. kept's own named face ` +
        `constants are the positive half of D2 — the forbidden list below only makes sense while ` +
        `something of kept's own stands in their place.`,
    );
  }
});

test("the guard file excludes itself, and exactly one file", async () => {
  const files = await scan();
  assert.equal(
    files.filter((f) => f.path === SELF).length,
    0,
    `${SELF} is in the scan. It contains every needle by necessity and would always fail.`,
  );
  const selfText = await readFile(new URL(SELF, REPO_ROOT), "utf8");
  assert.ok(
    selfText.includes("take-and-leave"),
    `${SELF} does not resolve to this file, so the self-exclusion is silently excluding ` +
      `nothing — or worse, something else. Excluded by exact path, never by pattern.`,
  );
});

/*
 * ─── Guard 1: the not-taken constants ──────────────────────────────────────
 */

const WHY_MEASURED =
  "was measured off another company's avatar, frame by frame, and copying it carries their " +
  "trade dress into kept's brand — the one thing a mascot exists to make recognisable. " +
  "kept's own values live in packages/shared/src/mascot/face.ts and were chosen by inspection.";

const FORBIDDEN_VALUES = [
  { literal: "15.46", why: `bloub's EYE_SPLIT. It ${WHY_MEASURED}` },
  { literal: "0.186", why: `bloub's EYE_W. It ${WHY_MEASURED}` },
  { literal: "0.412", why: `bloub's EYE_H. It ${WHY_MEASURED}` },
  { literal: "28.49", why: `bloub's REST_GAZE yaw. It ${WHY_MEASURED}` },
  { literal: "28.62", why: `bloub's REST_GAZE pitch. It ${WHY_MEASURED}` },
] as const;

/**
 * The shape library kept did not take. Matched as an identifier segment, so
 * `eggProfile` / `EGG_PROFILE` / `HexagonProfile` are caught while `AlertTriangle`
 * and `legged` are not — the ban is on a profile named for one of these shapes,
 * not on the English words.
 */
const FORBIDDEN_PROFILES = ["egg", "hexagon", "triangle"] as const;

/**
 * Case-insensitivity is spelled out per character rather than using the `i`
 * flag, because `i` folds the trailing `(?![a-z0-9])` too and would let
 * `eggProfile` through on its capital `P` — which is exactly the name a second
 * profile would carry. Proven red against that string before this shipped.
 */
function identifierSegment(word: string): RegExp {
  const chars = [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
  return new RegExp(`(?<![A-Za-z0-9])${chars}(?![a-z0-9])`);
}

test("no measured constant from the reference avatar appears in the source", async () => {
  for (const file of await scan()) {
    for (const { literal, why } of FORBIDDEN_VALUES) {
      const hits = linesMatching(file.text, new RegExp(literal.replace(".", "\\.")));
      assert.deepEqual(
        hits,
        [],
        `${file.path}:${hits.join(",")} — ${JSON.stringify(literal)} is in the repo. ${why} ` +
          `This guard does NOT exclude comments: a comment quoting the value puts the value in ` +
          `the repo, which is the thing being prevented. State the decision without reciting it.`,
      );
    }
  }
});

test("no egg, hexagon or triangle profile is defined anywhere", async () => {
  for (const file of await scan()) {
    for (const shape of FORBIDDEN_PROFILES) {
      const pattern = identifierSegment(shape);
      const hits = linesMatching(file.text, pattern);
      assert.deepEqual(
        hits,
        [],
        `${file.path}:${hits.join(",")} — a ${shape} profile has appeared. bloub's profiles.ts ` +
          `shape library ${WHY_MEASURED} kept ships ONE shape, generated from an equation in ` +
          `packages/shared/src/mascot/geometry.ts. A second shape is the shape library coming ` +
          `back one profile at a time.`,
      );
    }
  }
});

/*
 * ─── Guard 2: exactly one implementation ───────────────────────────────────
 */

/**
 * Occurrences that QUOTE the one definition rather than being a second one.
 * Narrowed to the exact literal — never to a whole file, and never widened to
 * make an inconvenient hit go green. Each is asserted to still be present, so a
 * stale exclusion is a failure rather than a silent hole.
 */
const QUOTATIONS = [
  // lib/mascot/generator-contract.test.ts pins this signature as its
  // comment-strip anchor. A quoted signature inside a string is documentation
  // of the definition, not a rival definition.
  '"geometry.ts": "export function superellipseProfile(n: number, sx = 1, sy = 1): number[] {",',
] as const;

const IMPLEMENTATIONS = [
  {
    stem: "superellipse",
    home: "packages/shared/src/mascot/geometry.ts",
    definition: /(?:function|class|const|let|var)\s+[A-Za-z0-9_$]*superellipse[A-Za-z0-9_$]*/i,
    consequence:
      "the superellipse profile is the silhouette itself; a second one is two mascots that " +
      "happen to agree today",
  },
  {
    stem: "closedPath",
    home: "packages/shared/src/mascot/geometry.ts",
    definition: /(?:function|class|const|let|var)\s+[A-Za-z0-9_$]*closedPath[A-Za-z0-9_$]*/i,
    consequence:
      "closedPath is the Catmull-Rom that turns points into `d`; a second one is how the " +
      "Worker's outline silently stops tracking the generator",
  },
] as const;

/** The scan with every narrowly-listed quotation removed. */
async function scanWithoutQuotations(): Promise<ScannedFile[]> {
  const files = await scan();
  const joined = files.map((f) => f.text).join("\n");
  for (const quotation of QUOTATIONS) {
    assert.ok(
      joined.includes(quotation),
      `a QUOTATIONS entry is stale — ${JSON.stringify(quotation.slice(0, 48))}… is no longer in ` +
        `the source. Delete the entry; leaving it is a hole in the single-implementation guard.`,
    );
  }
  return files.map((f) => ({
    path: f.path,
    text: QUOTATIONS.reduce((text, q) => text.split(q).join(""), f.text),
  }));
}

test("exactly one superellipse and one closedPath definition exist, both in the shared module", async () => {
  const files = await scanWithoutQuotations();

  for (const { stem, home, definition, consequence } of IMPLEMENTATIONS) {
    const definers = files
      .map((f) => ({ path: f.path, lines: linesMatching(f.text, definition) }))
      .filter((f) => f.lines.length > 0);

    assert.deepEqual(
      definers.map((f) => `${f.path}:${f.lines.join(",")}`),
      [`${home}:${linesMatching(fileNamed(files, home).text, definition).join(",")}`],
      `${stem} is defined in more than one place (or in the wrong one): ` +
        `${definers.map((f) => f.path).join(", ")}. There is exactly ONE implementation of the ` +
        `mascot geometry, in ${home}; ${consequence}. apps/edge and apps/web may only import it.`,
    );

    const total = definers[0]?.lines.length ?? 0;
    assert.equal(
      total,
      1,
      `${home} carries ${total} ${stem} definitions. One implementation means one definition — ` +
        `${consequence}.`,
    );
  }
});

test("no path-building code lives outside the shared mascot module", async () => {
  const files = await scanWithoutQuotations();
  const MASCOT_MODULE = "packages/shared/src/mascot/";

  for (const { stem, consequence } of IMPLEMENTATIONS) {
    for (const file of files) {
      if (file.path.startsWith(MASCOT_MODULE)) continue;
      const hits = linesMatching(file.text, new RegExp(stem, "i"));
      assert.deepEqual(
        hits,
        [],
        `${file.path}:${hits.join(",")} names ${stem}. Only ${MASCOT_MODULE} builds paths — the ` +
          `consumers call mascotSvg/mascotFrame and nothing else, because ${consequence}.`,
      );
    }
  }
});

/*
 * ─── Guard 3: the two sample counts, both measured, both pinned ────────────
 *
 * Task 005 measured the emitted `d` at 64, 32 and 16 samples and rendered all
 * three at the Worker's real ~170px box and overlaid at 600px: 32 is coincident
 * with 64 there and 2,376 bytes cheaper, 16 separates visibly at the corners.
 * So the counts DIFFER between the two consumers, and both must stay pinned —
 * an unpinned count is a silent visual change on the error pages.
 */

const SAMPLE_COUNTS = [
  {
    path: "packages/shared/src/mascot/geometry.ts",
    pin: "export const MASCOT_SAMPLES = 64;",
    why: "the generator's default, and the count apps/web animates at 600px",
  },
  {
    path: "apps/edge/src/system-pages.ts",
    pin: "const MASCOT_SAMPLES_EDGE = 32;",
    why: "the Worker's measured count — indistinguishable from 64 at the ~170px system-page box",
  },
] as const;

test("both sample counts are pinned where they are used", async () => {
  const files = await scan();
  for (const { path: rel, pin, why } of SAMPLE_COUNTS) {
    assert.ok(
      fileNamed(files, rel).text.includes(pin),
      `${rel} no longer pins ${JSON.stringify(pin)} — ${why}. The counts were chosen by rendering ` +
        `and comparing, not by reasoning; changing one without re-rendering makes the decision by ` +
        `accident. See task 005's measurement table.`,
    );
  }
});

test("both emitted outlines are pinned in the Worker's suite", async () => {
  const suite = fileNamed(await scan(), "apps/edge/test/system-pages.test.ts");
  for (const pin of ["const MASCOT_D_EDGE =", "const MASCOT_D_WEB ="]) {
    assert.ok(
      suite.text.includes(pin),
      `apps/edge/test/system-pages.test.ts no longer declares ${JSON.stringify(pin)}. The counts ` +
        `differ between the two consumers, so BOTH emitted paths are pinned there — it is the ` +
        `only suite in the repo that fails when the shared generator moves.`,
    );
  }
});

/*
 * ─── Guard 4: the import boundary ──────────────────────────────────────────
 */

test("apps/edge takes the mascot from the subpath, never the barrel and never apps/web", async () => {
  const edge = (await scan()).filter((f) => f.path.startsWith("apps/edge/"));

  const subpathUsers = edge.filter((f) => f.text.includes('from "@kept/shared/mascot"'));
  assert.ok(
    subpathUsers.length > 0,
    `no file under apps/edge imports "@kept/shared/mascot". Either the Worker stopped using the ` +
      `shared generator — which is exactly what this guard exists to catch — or the scan is ` +
      `reading the wrong tree.`,
  );

  const MASCOT_SYMBOLS = /\b(mascotSvg|mascotFrame|MASCOT_REST_T|MASCOT_SAMPLES)\b/;

  for (const file of edge) {
    for (const [, bindings] of file.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@kept\/shared"/g)) {
      assert.equal(
        MASCOT_SYMBOLS.test(bindings ?? ""),
        false,
        `${file.path} imports a mascot symbol from the "@kept/shared" barrel. Use the ` +
          `"@kept/shared/mascot" subpath: the barrel re-exports everything it names, so a mascot ` +
          `import there drags the 64-sample profile and the blink calendar onto the Worker's hot ` +
          `path, where every \`import { MAX_PAGE_BYTES }\` would pay for them.`,
      );
    }

    // Both shapes a cross-app import can take: the package name, and the
    // relative climb out of apps/edge into apps/web (there is no path alias
    // between the two, so `../../web/…` is what it would actually look like).
    const crossApp = linesMatching(
      file.text,
      /from\s*"(?:@kept\/web\b[^"]*|[^"]*\bapps\/web\/[^"]*|(?:\.\.\/)+web\/[^"]*)"/,
    );
    assert.deepEqual(
      crossApp,
      [],
      `${file.path}:${crossApp.join(",")} imports from apps/web. The serve path is 100% ` +
        `Cloudflare and never depends on the control plane; apps/edge may import ` +
        `packages/shared and nothing else. This epic added the first behavioural code shared ` +
        `between the two apps and must not become the precedent that loosens that rule.`,
    );
  }
});
