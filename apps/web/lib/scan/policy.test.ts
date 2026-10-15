/**
 * `decide` — PRD §6.4 rules P1–P4 and the clean hard cases (E07 AC6).
 *
 * NO MOCKS. Facts come from running the real extractor over the fixture pages
 * in `fixtures/`; classifier answers come from `fixtures/answers.json`, typed
 * exactly like the Decisions API output (`choice` + `probabilities`, `noul`)
 * and validated through `classifierAnswersSchema` before use. Until task 006
 * saves real Jev answers they are built to that documented schema; 006 swaps in
 * the saved answers and re-runs this file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCAN_THRESHOLDS } from "@kept/shared";

import { extract } from "./extract";
import { decide } from "./policy";
import { classifierAnswersSchema, type ClassifierAnswers, type PageFacts } from "./types";

const ADDRESS = "fixture123.kept.invalid";

const savedAnswers: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"),
);

function answers(name: string): ClassifierAnswers {
  const raw = savedAnswers[name];
  assert.ok(raw, `fixtures/answers.json has no "${name}"`);
  return classifierAnswersSchema.parse(raw);
}

function facts(fixture: string): PageFacts {
  const html = readFileSync(new URL(`./fixtures/${fixture}.html`, import.meta.url), "utf8");
  return extract(html, ADDRESS).facts;
}

test("every saved answer parses as the Decisions API's typed output", () => {
  for (const [name, raw] of Object.entries(savedAnswers)) {
    const parsed = classifierAnswersSchema.safeParse(raw);
    assert.ok(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`);
  }
  assert.equal(classifierAnswersSchema.safeParse({ harm: { type: "choice", choice: "evil" } }).success, false);
});

test("P1: a confident harmful pick flags with the Appendix A reason", () => {
  const page = facts("destinations-form-action");
  const cases = [
    ["credential-phishing", "phishing"],
    ["payment-harvest", "payment_fraud"],
    ["wallet-drainer", "crypto_scam"],
    ["malware-download", "malware"],
    ["scam", "scam"],
  ] as const;
  for (const [name, reason] of cases) {
    assert.deepEqual(decide(page, answers(name)), { verdict: "flag", reason, rule: "P1", priority: false }, name);
  }
});

test("P1: below the harm threshold is not P1 (and falls through to P3/P4)", () => {
  const unsure = answers("credential-phishing-unsure"); // 0.72 < 0.8, impersonates 0.41 < 0.6
  assert.deepEqual(decide(facts("destinations-form-action"), unsure), { verdict: "clean" });
  assert.deepEqual(decide(facts("destinations-form-action"), unsure, { ...SCAN_THRESHOLDS, harm: 0.7 }), {
    verdict: "flag",
    reason: "phishing",
    rule: "P1",
    priority: false,
  });
});

test("P2: sexual content involving minors flags as child_sexual_abuse with priority, at its own lower threshold", () => {
  const page = facts("redirect-meta");
  assert.deepEqual(decide(page, answers("sexual-content-minors")), {
    verdict: "flag",
    reason: "child_sexual_abuse",
    rule: "P2",
    priority: true,
  });
  assert.deepEqual(decide(page, answers("sexual-content-minors-low")), { verdict: "clean" }); // 0.46 < 0.5
});

test("P3: secrets leave the page and the page impersonates → phishing", () => {
  const leaking = facts("destinations-script-fetch");
  assert.equal(leaking.secretsLeavePage, true);
  assert.deepEqual(decide(leaking, answers("impersonating-harvester")), {
    verdict: "flag",
    reason: "phishing",
    rule: "P3",
    priority: false,
  });
  assert.deepEqual(decide(leaking, answers("impersonating-harvester"), { ...SCAN_THRESHOLDS, impersonates: 0.8 }), {
    verdict: "clean",
  });
  // The same answers on a page whose secrets stay put: no P3.
  const staying = facts("secret-field-markup");
  assert.equal(staying.secretsLeavePage, false);
  assert.deepEqual(decide(staying, answers("impersonating-harvester")), { verdict: "clean" });
});

test("P4: obfuscated + a secret field flags suspicious_code — with no classifier at all", () => {
  const hidden = facts("obfuscated-eval-base64");
  assert.equal(hidden.obfuscated && hidden.secretField, true);
  const expected = { verdict: "flag", reason: "suspicious_code", rule: "P4", priority: false };
  assert.deepEqual(decide(hidden, null), expected);
  assert.deepEqual(decide(facts("obfuscated-hex-escapes"), null), expected);
  // Obfuscated but asking for nothing (packer, fromCharCode): clean.
  assert.deepEqual(decide(facts("obfuscated-packer"), null), { verdict: "clean" });
  assert.deepEqual(decide(facts("obfuscated-fromcharcode"), null), { verdict: "clean" });
  // With answers too, P4 still fires when nothing else does…
  assert.deepEqual(decide(hidden, answers("clean-supabase-login")), expected);
  // …and a classifier flag wins the reason.
  assert.equal(decide(hidden, answers("credential-phishing")).verdict, "flag");
  assert.deepEqual(decide(hidden, answers("credential-phishing")), {
    verdict: "flag",
    reason: "phishing",
    rule: "P1",
    priority: false,
  });
});

test("with answers = null only P4 can fire", () => {
  for (const fixture of ["destinations-form-action", "destinations-jsx", "downloads-markup", "redirect-script"]) {
    assert.deepEqual(decide(facts(fixture), null), { verdict: "clean" }, fixture);
  }
});

test("clean hard cases stay clean", () => {
  // Own-app login: its password really leaves for Supabase, but it impersonates nobody.
  const supabase = facts("clean-supabase-login");
  assert.equal(supabase.secretsLeavePage, true);
  assert.deepEqual(decide(supabase, answers("clean-supabase-login")), { verdict: "clean" });

  // A "Netflix clone" that sends nothing anywhere: impersonates, but no secret leaves.
  const clone = facts("clean-netflix-clone");
  assert.equal(clone.secretField, true);
  assert.equal(clone.secretsLeavePage, false);
  assert.deepEqual(decide(clone, answers("clean-netflix-clone")), { verdict: "clean" });

  // Large base64 images (data: URIs) beside atob and a password field: not obfuscated.
  const images = facts("clean-base64-image");
  assert.equal(images.obfuscated, false);
  assert.deepEqual(decide(images, answers("clean-base64-image")), { verdict: "clean" });
  assert.deepEqual(decide(images, null), { verdict: "clean" });

  // Minified build output with a login form: not obfuscated.
  const minified = facts("clean-minified");
  assert.equal(minified.obfuscated, false);
  assert.deepEqual(decide(minified, answers("clean-minified")), { verdict: "clean" });
  assert.deepEqual(decide(minified, null), { verdict: "clean" });
});

test("decide is pure: same inputs, same verdict, inputs untouched", () => {
  const page = facts("destinations-script-fetch");
  const given = answers("impersonating-harvester");
  const before = JSON.stringify([page, given]);
  const first = decide(page, given);
  assert.deepEqual(decide(page, given), first);
  assert.equal(JSON.stringify([page, given]), before);
});

test("the default thresholds are SCAN_THRESHOLDS, and policy.ts holds no threshold literal", () => {
  const page = facts("destinations-form-action");
  const given = answers("credential-phishing");
  assert.deepEqual(decide(page, given), decide(page, given, SCAN_THRESHOLDS));
  const code = readFileSync(new URL("./policy.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\b0?\.\d+\b/.test(code), false, "no numeric threshold literal in policy.ts");
});
