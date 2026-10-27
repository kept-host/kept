/**
 * E09 task 010 — the skill source in `skill/` (Q1) cannot drift from
 * `@kept/shared`'s agent copy (AC12's drift half), `server.json` validates
 * against the MCP Registry schema vendored in `fixtures/` (AC13), and
 * `scripts/publish.sh` is clean shell that keeps the documented exit codes on
 * every path that needs no server (AC3's local half; the live publish is the
 * task's DoD and the skill repo's CI).
 *
 * No network beyond a refused connection to 127.0.0.1, no store touched; every
 * run of the script gets its own temp `$HOME`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { INLINE_BODY_MAX_BYTES, SKILL_NAME, skillMarkdown } from "@kept/shared";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { MCP_REGISTRY_NAME, MCP_REGISTRY_SCHEMA, SKILL_BUILD_BASE, skillFiles } from "./skill-files";

const run = promisify(execFile);
const SKILL_DIR = resolve(import.meta.dirname, "../../../../skill");
const PUBLISH_SH = join(SKILL_DIR, "skills", SKILL_NAME, "scripts", "publish.sh");

test("skill/skills/kept/SKILL.md is skillMarkdown(prod), and every generated file matches", () => {
  assert.equal(readFileSync(join(SKILL_DIR, "skills", SKILL_NAME, "SKILL.md"), "utf8"), skillMarkdown(SKILL_BUILD_BASE));
  const files = skillFiles(SKILL_BUILD_BASE);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(
      readFileSync(join(SKILL_DIR, path), "utf8"),
      content,
      `skill/${path} drifted — run: pnpm --filter @kept/web exec tsx scripts/build-skill.ts`,
    );
  }
  console.log(`[skill] ${Object.keys(files).length} generated files match`);
});

test("server.json validates against the MCP Registry schema", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "server.schema.json"), "utf8"));
  assert.equal(schema.$id, MCP_REGISTRY_SCHEMA, "the fixture is the schema server.json names");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const server = JSON.parse(readFileSync(join(SKILL_DIR, "server.json"), "utf8")) as {
    name: string;
    remotes: { url: string }[];
  };
  const valid = validate(server);
  console.log(`[skill] server.json: ${valid ? "valid" : JSON.stringify(validate.errors)}`);
  assert.ok(valid);
  assert.equal(server.name, MCP_REGISTRY_NAME);
  assert.equal(server.remotes[0]?.url, `${SKILL_BUILD_BASE}/mcp`);

  // The validator is live: a name without its namespace is refused.
  assert.equal(validate({ ...server, name: "kept" }), false);
});

test("publish.sh: bash -n, shellcheck, executable, and the inline cap is the shared constant", async () => {
  await run("bash", ["-n", PUBLISH_SH]);
  // Findings go to stdout, which execFile's error message leaves out — and CI's
  // shellcheck is older than a dev machine's, so name them in the failure.
  await run("shellcheck", ["--format=gcc", PUBLISH_SH]).catch((err: { stdout?: string }) => {
    assert.fail(`shellcheck:\n${err.stdout ?? String(err)}`);
  });
  assert.equal(statSync(PUBLISH_SH).mode & 0o111, 0o111, "executable");
  const source = readFileSync(PUBLISH_SH, "utf8");
  assert.match(source, new RegExp(`^INLINE_BODY_MAX_BYTES=${INLINE_BODY_MAX_BYTES}$`, "m"));
  console.log("[skill] publish.sh: bash -n and shellcheck clean");
});

/** Runs publish.sh against a refused port with a fresh `$HOME`; resolves to its exit code and output. */
async function publish(args: string[], extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kept-skill-home-"));
  try {
    const result = await run("bash", [PUBLISH_SH, ...args], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: home, KEPT_BASE_URL: "http://127.0.0.1:9", ...extraEnv },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (err: { code: number; stdout: string; stderr: string }) => ({ code: err.code, output: err.stdout + err.stderr }),
    );
    console.log(`[skill] publish.sh ${args.join(" ")} → ${result.code}: ${result.output.trim().split("\n").at(-1)}`);
    return { ...result, homeFiles: readdirSync(home) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("publish.sh exit codes without a server: 2 for the caller's mistakes, 4 for the network", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kept-skill-"));
  try {
    const page = join(scratch, "page.html");
    writeFileSync(page, "<h1>tide pools</h1>");
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const large = join(scratch, "large");
    mkdirSync(large);
    writeFileSync(join(large, "index.html"), "<h1>big</h1>");
    // Random bytes do not compress, so the zip is over the inline cap.
    writeFileSync(join(large, "blob.bin"), randomBytes(INLINE_BODY_MAX_BYTES + 65_536));

    assert.equal((await publish([])).code, 2, "no path");
    assert.equal((await publish(["--bogus", page])).code, 2, "unknown flag");
    assert.equal((await publish([join(scratch, "missing.html")])).code, 2, "missing file");
    assert.equal((await publish(["--page", "tide-pools", page])).code, 2, "--page without a key");
    assert.equal((await publish(["login", "--code", "123456"])).code, 2, "a code before an email");

    const emptySite = await publish([empty]);
    assert.equal(emptySite.code, 2);
    assert.match(emptySite.output, /missing_index/);

    const tooLarge = await publish([large]);
    assert.equal(tooLarge.code, 2, "keyless above the inline cap");
    assert.match(tooLarge.output, /site_too_large/);

    const offline = await publish(["--model", "test-model", page]);
    assert.equal(offline.code, 4, "network");
    assert.deepEqual(offline.homeFiles, [], "a failed publish writes nothing under ~");

    const key = `kpt_live_${"A".repeat(43)}`;
    const keyed = await publish([page], { KEPT_API_KEY: key });
    assert.equal(keyed.code, 4);
    assert.ok(!keyed.output.includes(key), "never prints the key");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
