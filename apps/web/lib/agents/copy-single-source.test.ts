/**
 * E09 task 004 — `@kept/shared`'s agent copy is the single source (AC12, D12),
 * there is no copy for the chat app D11 rules out (AC14), and the generated
 * `/install.sh` is valid POSIX sh that installs into a fake `$HOME` and changes
 * nothing else (AC4's local half).
 *
 * The installer downloads from a real local HTTP server serving the real
 * `SKILL.md` and the real `skill/skills/kept/scripts/publish.sh` (task 010).
 * No network beyond 127.0.0.1, no store touched.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  DRAFT_TTL_DAYS,
  MCP_TOOL_DESCRIPTIONS,
  SKILL_INSTALL_COMMAND,
  agentPrompt,
  agentSetups,
  installScript,
  limitsFor,
  llmsTxt,
  skillMarkdown,
  skillsIndex,
} from "@kept/shared";

const run = promisify(execFile);
const BASE = "https://kept.host";
const REPO = resolve(import.meta.dirname, "../../../..");
const COPY_MODULE = "packages/shared/src/agent-copy.ts";

/** Every .ts/.tsx under apps/ and packages/, tracked or new (not ignored). */
function sourceFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"],
    { cwd: REPO, encoding: "utf8" },
  );
  return out.split("\n").filter((f) => /\.tsx?$/.test(f));
}

/** The first sentence of a description — enough to recognise a copy of it. */
function firstSentence(text: string): string {
  return text.split(". ")[0]!;
}

test("the prompt and the MCP tool descriptions live only in agent-copy.ts", () => {
  const needles = [
    // The prompt's first and last sentences, read from the module, not retyped.
    firstSentence(agentPrompt(BASE)),
    agentPrompt(BASE).split(". ").at(-1)!,
    ...Object.values(MCP_TOOL_DESCRIPTIONS).flatMap((set) => Object.values(set).map(firstSentence)),
  ];
  const files = sourceFiles();
  assert.ok(files.includes(COPY_MODULE), "agent-copy.ts is listed");
  const offenders: string[] = [];
  for (const file of files) {
    if (file === COPY_MODULE) continue;
    const text = readFileSync(join(REPO, file), "utf8");
    for (const needle of needles) if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
  }
  console.log(`[copy] scanned ${files.length} files for ${needles.length} strings`);
  assert.deepEqual(offenders, []);
});

test("the only mention of that chat app is agent-copy.ts's D11 comment", () => {
  const name = "chat" + "gpt";
  const hits: string[] = [];
  for (const file of execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"],
    { cwd: REPO, encoding: "utf8" },
  ).split("\n")) {
    if (!file) continue;
    const lines = readFileSync(join(REPO, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(name)) hits.push(`${file}:${i + 1}`);
    });
  }
  console.log(`[copy] mentions: ${hits.join(", ")}`);
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.startsWith(`${COPY_MODULE}:`));
  const line = readFileSync(join(REPO, COPY_MODULE), "utf8").split("\n")[Number(hits[0]!.split(":")[1]) - 1]!;
  assert.match(line, /^\/\//, "it is a comment");
});

test("the copy quotes limits from constants, never literals", () => {
  const source = readFileSync(join(REPO, COPY_MODULE), "utf8");
  const free = limitsFor("free");
  assert.doesNotMatch(source, new RegExp(`\\b(${DRAFT_TTL_DAYS}|${free.keptPages})\\b`));
  const skill = skillMarkdown(BASE);
  assert.ok(skill.startsWith("---\nname: kept\n"));
  assert.ok(skill.includes(`${DRAFT_TTL_DAYS} days`));
  assert.ok(skill.includes(`keeps ${free.keptPages} pages`));
  assert.ok(skill.includes("both links"));
  assert.ok(skill.includes("--replace <manage_token>"));
  const words = skill.split(/\s+/).length;
  console.log(`[copy] SKILL.md: ${words} words`);
  assert.ok(words > 250 && words < 550, `~400 words, got ${words}`);
});

test("every URL is built from the base, and the tabs are in order", () => {
  assert.ok(agentPrompt(BASE).includes(`${BASE}/api/publish`));
  assert.ok(agentPrompt(BASE).includes(SKILL_INSTALL_COMMAND));
  const dev = "https://kept-dev.xyz";
  for (const text of [agentPrompt(dev), skillMarkdown(dev), llmsTxt(dev), installScript(dev)]) {
    assert.ok(!text.includes("kept.host/"), "no prod origin in dev copy");
  }
  assert.equal(skillsIndex(dev).skills[0]!.url, `${dev}/skill.md`);
  assert.deepEqual(
    agentSetups(BASE).map((s) => s.name),
    ["Codex", "Claude Code", "Cursor", "Any agent", "HTTP API", "Claude chat"],
  );
});

/** Every path under `dir`, relative to it, sorted. */
function tree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    out.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

test("install.sh: sh -n, shellcheck, installs into a fake ~/.claude and nothing else", async () => {
  const skill = skillMarkdown(BASE);
  const publish = readFileSync(join(REPO, "skill/skills/kept/scripts/publish.sh"), "utf8");
  const server = createServer((req, res) => {
    const body = req.url === "/SKILL.md" ? skill : req.url === "/scripts/publish.sh" ? publish : null;
    res.writeHead(body === null ? 404 : 200).end(body ?? "");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const scratch = mkdtempSync(join(tmpdir(), "kept-install-"));
  try {
    const { port } = server.address() as AddressInfo;
    const script = join(scratch, "install.sh");
    writeFileSync(script, installScript(BASE, `http://127.0.0.1:${port}`));

    await run("sh", ["-n", script]);
    await run("shellcheck", ["-s", "sh", script]);
    console.log("[install] sh -n and shellcheck clean");

    // A home with Claude Code only.
    const home = join(scratch, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    const before = tree(home);
    const { stdout } = await run("sh", [script], { env: { NODE_ENV: "test", HOME: home, PATH: process.env.PATH ?? "" } });
    console.log(`[install] ${stdout.trim()}`);
    assert.match(stdout, /installed the skill for Claude Code/);
    const added = tree(home).filter((p) => !before.includes(p));
    assert.deepEqual(added, [
      ".claude/skills",
      ".claude/skills/kept",
      ".claude/skills/kept/SKILL.md",
      ".claude/skills/kept/scripts",
      ".claude/skills/kept/scripts/publish.sh",
    ]);
    assert.equal(readFileSync(join(home, ".claude/skills/kept/SKILL.md"), "utf8"), skill);
    assert.equal(statSync(join(home, ".claude/skills/kept/scripts/publish.sh")).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), "{}");

    // No agent at all: prints the npx command, exits 0, touches nothing.
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const none = await run("sh", [script], { env: { NODE_ENV: "test", HOME: empty, PATH: process.env.PATH ?? "" } });
    assert.ok(none.stdout.includes(SKILL_INSTALL_COMMAND));
    assert.deepEqual(tree(empty), []);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
