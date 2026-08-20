/**
 * No spec may address the harness over plain http (E05a task 007).
 *
 * ── THE FAILURE THIS EXISTS TO CATCH ───────────────────────────────────────
 * The session cookie is `__Host-kept.session_token` (see the block comment in
 * `./index.ts`, which owns the decision). A `__Host-` cookie is `Secure` by
 * browser fiat, and a browser DOES NOT STORE a `Secure` cookie delivered over
 * plain http. That is why local dev and the Playwright harness both moved to
 * https — `apps/web`'s `dev` script carries `--experimental-https`, and
 * `playwright.config.ts` pins `baseURL` and `webServer.url` to
 * `https://localhost:3000`.
 *
 * A single spec that reaches for `http://localhost:3000` — a hand-built
 * absolute URL in a `request.post(...)`, a `page.goto` copied from before the
 * cutover — gets a signed-out response on the very next request, because the
 * `Set-Cookie` was dropped silently. Nothing logs, nothing throws: it presents
 * as an auth bug, and it already cost real time once. There is no runtime
 * assertion that can catch it (the scheme is the input, not the output), so it
 * is caught here, in the source, before the run.
 *
 * ── WHY IT LIVES IN THE UNIT SUITE ─────────────────────────────────────────
 * `tsx --test` runs in CI on every push with no browser and no server. A guard
 * that only ran inside the very harness it is protecting would be unable to
 * report the misconfiguration that stopped that harness working.
 *
 * ── COMMENTS ARE EXCLUDED, ON PURPOSE ──────────────────────────────────────
 * The history is written down in exactly these files —
 * `playwright.config.ts` and `e2e/session-request.ts` both explain what
 * reverting a URL to http would do — and that prose has to be able to say
 * "http". So the scan runs over `stripComments(source)`: an http URL a spec
 * would actually REQUEST is banned; an http URL a comment merely names is not.
 * One deliberate consequence: a trailing `// …` comment on a line of code is
 * stripped with the rest, but a banned literal in one still trips nothing —
 * whereas the same literal inside a string, anywhere, always does. The scan is
 * over code, and code is what makes a request.
 *
 * No assertion here is about comment text. Nothing here needs credentials.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { linesContaining, stripComments } from "../testing/strip-comments";

/**
 * The literal itself. Port included because `playwright.config.ts` pins :3000
 * for the whole harness, so this is the exact shape a copied-forward URL takes.
 */
const BANNED = "http://localhost:3000";

/** `apps/web/e2e/` — specs and their helpers alike; a helper builds URLs too. */
const E2E_DIR = new URL("../../e2e/", import.meta.url);

/**
 * A floor, not a count: it only has to be high enough that an empty or
 * mis-resolved directory listing cannot let this pass by scanning nothing.
 */
const MIN_E2E_FILES = 10;

async function harnessSources(): Promise<{ name: string; code: string }[]> {
  const entries = await readdir(E2E_DIR, { recursive: true });
  const specs = entries.filter((entry) => entry.endsWith(".ts"));
  assert.ok(
    specs.length >= MIN_E2E_FILES,
    `only ${specs.length} .ts files found under e2e/ — the scan resolved the wrong ` +
      `directory and would assert nothing`,
  );

  const files = await Promise.all(
    specs.map(async (name) => ({
      name: `e2e/${name}`,
      code: stripComments(await readFile(new URL(name, E2E_DIR), "utf8")),
    })),
  );

  const configPath = new URL("../../playwright.config.ts", import.meta.url);
  files.push({
    name: "playwright.config.ts",
    code: stripComments(await readFile(configPath, "utf8")),
  });
  return files;
}

test("the scan reaches the config that pins the harness scheme", async () => {
  const files = await harnessSources();
  const config = files.find((file) => file.name === "playwright.config.ts");
  assert.ok(config);
  // Anchors, as in `lib/routing/configured-origins.test.ts`: if the comment
  // strip ever ate real code the ban below would go quiet, so prove the two
  // URLs the ban is about survived it.
  assert.ok(config.code.includes('baseURL: "https://localhost:3000",'));
  assert.ok(config.code.includes('url: "https://localhost:3000",'));
});

test("no spec and no harness config addresses the app over plain http", async () => {
  for (const { name, code } of await harnessSources()) {
    const hits = linesContaining(code, BANNED);
    assert.deepEqual(
      hits,
      [],
      `${name}:${hits.join(",")} — ${BANNED} in code. The session cookie is ` +
        `__Host-, therefore Secure, and a browser silently drops a Secure cookie ` +
        `delivered over http: the run would look signed out rather than fail. Use ` +
        `the https baseURL from playwright.config.ts. Naming http in a comment is ` +
        `fine; this scan already excludes comments.`,
    );
  }
});
