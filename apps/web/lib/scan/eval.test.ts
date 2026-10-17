/**
 * The eval's pure half (E07 AC13): the inert-set guard and the replay path.
 *
 * NO MOCKS. Facts come from the real extractor over `fixtures/*.html`; the
 * judgments file is hand-made from `fixtures/answers.json` (typed exactly like
 * the Decisions API's answers) in the shape `eval-scanner.ts` saves, so replay,
 * tally, sweep and table run end to end without a classifier call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCAN_THRESHOLDS } from "@kept/shared";

import { liveHosts, replay, resultsTable, staleJudgments, summarize, sweep, type EvalPage, type JudgmentsFile } from "./eval";
import { extract } from "./extract";
import { classifierAnswersSchema } from "./types";

const answers: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"),
);

/** [fixture page, saved answers (or a failed call), set]. */
const CASES = [
  ["clean-supabase-login", "clean-supabase-login", "clean"],
  ["clean-netflix-clone", "clean-netflix-clone", "clean"],
  ["clean-minified", "clean-minified", "clean"],
  ["clean-base64-image", null, "clean"],
  ["destinations-form-action", "credential-phishing", "harmful"],
  ["destinations-script-fetch", "impersonating-harvester", "harmful"],
  ["destinations-jsx", "credential-phishing-unsure", "harmful"],
  ["downloads-markup", "malware-download", "harmful"],
  ["obfuscated-eval-base64", "clean-supabase-login", "harmful"],
] as const;

function evalPage(fixture: string, set: EvalPage["set"]): EvalPage {
  const html = readFileSync(new URL(`./fixtures/${fixture}.html`, import.meta.url), "utf8");
  return { id: `${set}/${fixture}.html`, set, sha256: `sha-${fixture}`, facts: extract(html, "fixture123.kept.invalid").facts };
}

const pages = CASES.map(([fixture, , set]) => evalPage(fixture, set));
const judgments: JudgmentsFile = {
  model: "typesafe/jev-1.13",
  savedAt: "2026-10-15T00:00:00.000Z",
  judgments: Object.fromEntries(
    CASES.map(([fixture, saved, set]) => [
      `${set}/${fixture}.html`,
      saved
        ? {
            sha256: `sha-${fixture}`,
            result: { answers: classifierAnswersSchema.parse(answers[saved]), cost: 0.0001, model: "typesafe/jev-1.13-20260917" },
          }
        : { sha256: `sha-${fixture}`, error: "timeout" },
    ]),
  ),
};

test("guard: every host a page names must be .invalid — in markup, script and text alike", () => {
  const html = `
    <form action="https://collect.example-bank.invalid/post"></form>
    <script src="//cdn.tailwindcss.invalid/x.js"></script>
    <script>fetch("https://api.telegram.org/bot1/sendMessage"); new WebSocket("wss://sock.example.org/feed")</script>
    <p>Visit HTTPS://Real-Bank.com/login today</p>
    <a href="/relative">relative</a> <a href="mailto:a@b.invalid">mail</a>`;
  assert.deepEqual(liveHosts(html).sort(), ["api.telegram.org", "real-bank.com", "sock.example.org"]);
  assert.deepEqual(liveHosts(`<a href="https://a.b.invalid/x">x</a><img src="data:image/png;base64,AAAA">`), []);
});

test("replay runs every saved judgment through decide; a failed call replays as answers = null", () => {
  const rows = replay(pages, judgments, SCAN_THRESHOLDS);
  const verdict = (id: string) => rows.find((row) => row.page.id === id)?.decision;
  assert.deepEqual(verdict("clean/clean-supabase-login.html"), { verdict: "clean" });
  assert.deepEqual(verdict("clean/clean-base64-image.html"), { verdict: "clean" });
  assert.deepEqual(verdict("harmful/destinations-form-action.html"), { verdict: "flag", reason: "phishing", rule: "P1", priority: false });
  assert.deepEqual(verdict("harmful/destinations-script-fetch.html"), { verdict: "flag", reason: "phishing", rule: "P3", priority: false });
  assert.deepEqual(verdict("harmful/destinations-jsx.html"), { verdict: "clean" }); // 0.72 < harm 0.75
  assert.deepEqual(verdict("harmful/obfuscated-eval-base64.html"), {
    verdict: "flag",
    reason: "suspicious_code",
    rule: "P4",
    priority: false,
  });
});

test("summary: per-set counts, per-rule counts, errors, cost, and the D5 gate", () => {
  const summary = summarize(replay(pages, judgments, SCAN_THRESHOLDS));
  assert.deepEqual(summary.clean, { total: 4, flagged: 0 });
  assert.deepEqual(summary.harmful, { total: 5, flagged: 4 });
  assert.deepEqual(summary.byRule, { P1: 2, P3: 1, P4: 1 });
  assert.equal(summary.errors, 1);
  assert.ok(Math.abs(summary.cost - 0.0008) < 1e-12);
  assert.equal(summary.gate, false, "an unjudged page fails the gate even at 80%");

  const judged = { ...judgments, judgments: { ...judgments.judgments } };
  delete judged.judgments["clean/clean-base64-image.html"];
  const judgedPages = pages.filter((page) => page.id !== "clean/clean-base64-image.html");
  assert.equal(summarize(replay(judgedPages, judged, SCAN_THRESHOLDS)).gate, true); // 4/5 = 80%, 0 clean
});

test("stale judgments: a page with changed bytes or no judgment is refused", () => {
  assert.deepEqual(staleJudgments(pages, judgments), []);
  const changed = pages.map((page, i) => (i === 0 ? { ...page, sha256: "different" } : page));
  assert.deepEqual(staleJudgments([...changed, evalPage("redirect-meta", "harmful")], judgments), [
    "clean/clean-supabase-login.html",
    "harmful/redirect-meta.html",
  ]);
});

test("sweep: the gate-passing thresholds that flag the most harmful pages", () => {
  const judgedPages = pages.filter((page) => page.id !== "clean/clean-base64-image.html");
  const best = sweep(judgedPages, judgments, SCAN_THRESHOLDS);
  assert.ok(best);
  // harm ≤ 0.7 also flags destinations-jsx (0.72): 5/5, while the Netflix clone (impersonates 0.83, nothing leaves) stays clean.
  assert.equal(best.summary.harmful.flagged, 5);
  assert.equal(best.summary.clean.flagged, 0);
  assert.equal(best.thresholds.harm, 0.7);
  assert.equal(best.thresholds.minors, SCAN_THRESHOLDS.minors);
});

test("the results table lists every page and the totals", () => {
  const rows = replay(pages, judgments, SCAN_THRESHOLDS);
  const table = resultsTable(rows, summarize(rows));
  for (const page of pages) assert.ok(table.includes(page.id.slice(page.set.length + 1)), page.id);
  assert.match(table, /\| harmful \| destinations-jsx\.html \| flag \| clean \|  \|  \| credential_phishing 0\.72 · imp 0\.41 \| \*\*yes\*\* \|/);
  assert.match(table, /error: timeout/);
  assert.match(table, /Clean flagged: \*\*0 \/ 4\*\*/);
  assert.match(table, /Harmful flagged: \*\*4 \/ 5 \(80%\)\*\*/);
  assert.match(table, /Gate \(D5\): \*\*FAIL\*\*/);
});
