/**
 * The routing and auth layers derive their origins from CONFIGURATION — never
 * from a baked-in hostname, never from an `NODE_ENV` fork.
 *
 * ── WHY A SOURCE-TEXT GUARD AND NOT A BEHAVIOURAL ONE ──────────────────────
 * E02 locked this: one build artefact, promoted from dev to prod unchanged, so
 * the only thing that may differ between tracks is the environment it is handed.
 * E05a task 004 restates it for the split rule specifically. Every behavioural
 * test in this directory necessarily pins ONE configuration and asserts what the
 * code does with it — which is exactly the shape a hardcoded fallback survives:
 * `decideHostAction` could carry `?? "app.kept.host"` and every case in
 * `host-split.test.ts` would still pass, because those cases always supply an
 * `appUrl`. The same is true of a `NODE_ENV === "production"` branch: the suite
 * runs on one value of it. So the property has to be asserted over the source.
 *
 * Both bugs this epic actually shipped were this failure in spirit — the
 * `https://localhost:8080` redirect (`lib/auth/callback-origin.test.ts`) and the
 * `nextUrl.host` read (the block comment in `middleware.ts`) — an origin taken
 * from the process's own surroundings instead of from what was configured.
 *
 * ── COMMENTS ARE EXCLUDED, ON PURPOSE ──────────────────────────────────────
 * All three subject files explain the rule by quoting the exact hostnames it is
 * about (`app.kept.host` → `kept.host`, `nextUrl.host === "localhost:3000"`,
 * `Domain=kept-dev.xyz`). Those comments are the documentation of this very
 * decision and banning their text would delete the reasoning to satisfy the
 * guard. So the scan runs over `stripComments(source)`.
 *
 * That exclusion is what could make this vacuous, so it is checked from both
 * ends: `stripComments` has its own honesty test below, and every subject
 * declares code ANCHORS that must survive the strip — if the scanner ever eats
 * real code (see its header: it does not know regex literals), the anchor
 * assertion fails loudly rather than the ban going quiet.
 *
 * No assertion here is about comment text. Nothing here needs credentials.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { linesContaining, stripComments } from "../testing/strip-comments";

/**
 * Everything that decides, per request, which origin the control plane answers
 * on or trusts. `anchors` are verbatim CODE fragments — their survival proves
 * the comment strip left the file's logic intact.
 */
const SUBJECTS = [
  {
    path: "../../middleware.ts",
    anchors: [
      "export function middleware(request: NextRequest)",
      "appUrl: process.env.NEXT_PUBLIC_APP_URL,",
      'const forwarded = request.headers.get("x-forwarded-host");',
    ],
  },
  {
    path: "./host-split.ts",
    anchors: [
      "export function decideHostAction({",
      'const APP_HOST_LABEL = "app.";',
      "if (host.toLowerCase() === appOrigin.host.toLowerCase()) {",
    ],
  },
  {
    path: "../auth/index.ts",
    anchors: [
      "const { secret, baseUrl } = authConfig();",
      "baseURL: baseUrl,",
      "trustedOrigins: [baseUrl],",
    ],
  },
] as const;

/**
 * What may never appear in the CODE of those files, and why each one is fatal
 * rather than untidy.
 */
const BANNED = [
  {
    literal: "kept.host",
    why: "the prod serving domain, baked in — it would follow the build artefact into dev",
  },
  {
    literal: "kept-dev.xyz",
    why: "the dev domain, baked in — the same artefact is promoted to prod unchanged",
  },
  {
    literal: "localhost",
    why: "the process's own listen address, which is not the origin the visitor asked for",
  },
  {
    literal: "NODE_ENV",
    why: "an environment fork — one artefact, one code path, differing only by configuration",
  },
] as const;

async function readSubject(path: string): Promise<{ raw: string; code: string }> {
  const raw = await readFile(new URL(path, import.meta.url), "utf8");
  assert.ok(raw.length > 0, `${path} is empty — this guard would assert nothing`);
  return { raw, code: stripComments(raw) };
}

test("the comment scanner drops comments and keeps code — including the awkward shapes", () => {
  // A `//` inside a string is not a comment. Without this, banning `localhost`
  // could not tell `"https://localhost"` from a note about it.
  assert.equal(stripComments('const a = "https://x"; // localhost\n'), 'const a = "https://x"; \n');
  assert.equal(stripComments("/* localhost */ const b = 1;"), " const b = 1;");
  assert.equal(stripComments("const c = `a // b`;"), "const c = `a // b`;");
  assert.equal(stripComments('const d = "he said \\" // no";'), 'const d = "he said \\" // no";');
  // Newlines survive a block comment, so reported line numbers are real.
  assert.equal(stripComments("a\n/* x\ny */\nb"), "a\n\n\nb");
});

test("the comment strip leaves every subject's logic intact", async () => {
  for (const { path, anchors } of SUBJECTS) {
    const { code } = await readSubject(path);
    for (const anchor of anchors) {
      assert.ok(
        code.includes(anchor),
        `${path}: the comment strip removed code (${JSON.stringify(anchor)} is gone), so the ` +
          `bans below prove nothing. Fix the scanner in lib/testing/strip-comments.ts.`,
      );
    }
  }
});

test("no hostname literal and no NODE_ENV fork in the routing or auth source", async () => {
  for (const { path } of SUBJECTS) {
    const { code } = await readSubject(path);
    for (const { literal, why } of BANNED) {
      const hits = linesContaining(code, literal);
      assert.deepEqual(
        hits,
        [],
        `${path}:${hits.join(",")} — ${JSON.stringify(literal)} in code: ${why}. ` +
          `Origins come from NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL via lib/storage/env.ts. ` +
          `Naming it in a comment is fine; this scan already excludes comments.`,
      );
    }
  }
});
