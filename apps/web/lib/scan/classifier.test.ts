/**
 * The classifier client (E07 D1, PRD §6.3/§6.5).
 *
 * NO MOCKS. The request is built by the real `decisionsRequest` over a real
 * extraction; responses are `fixtures/decisions-response.json`, the envelope
 * exactly as OpenRouter's Decisions API reference documents it (`answers` with
 * `confidence` on the choice, `id`, `model`, `provider`, `usage.cost`). The one
 * network test calls the real API and skips, saying why, when
 * `OPENROUTER_API_KEY` is absent. The key is never printed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { config } from "dotenv";

import {
  ClassifierError,
  decisionsHttpError,
  decisionsRequest,
  defaultClassifier,
  JEV_MODEL,
  parseDecisionsResponse,
  scannerEnabled,
  SCAN_QUESTIONS,
} from "./classifier";
import { extract } from "./extract";
import { HARM_CHOICES } from "./types";

config({ path: ".env.local", quiet: true });

const skipLive = defaultClassifier() ? false : "OPENROUTER_API_KEY absent — the live Decisions API call needs a real key";

const documented: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/decisions-response.json", import.meta.url), "utf8"),
);

function page(fixture: string) {
  const html = readFileSync(new URL(`./fixtures/${fixture}.html`, import.meta.url), "utf8");
  return extract(html, "fixture123.kept.invalid");
}

test("the model is pinned to Jev 1.13, never the latest alias", () => {
  assert.equal(JEV_MODEL, "typesafe/jev-1.13");
  assert.equal(decisionsRequest(JEV_MODEL, page("clean-supabase-login")).model, "typesafe/jev-1.13");
});

test("the request asks the three §6.3 questions, harm options in order with their descriptions", () => {
  const body = decisionsRequest(JEV_MODEL, page("clean-supabase-login"));
  assert.deepEqual(Object.keys(body.questions), ["harm", "impersonates", "asks_for_secrets"]);
  assert.equal(body.questions.harm.type, "choice");
  assert.deepEqual(Object.keys(body.questions.harm.criteria), [...HARM_CHOICES]);
  for (const choice of HARM_CHOICES) assert.ok(body.questions.harm.criteria[choice].length > 20, choice);
  assert.equal(body.questions.impersonates.type, "noul");
  assert.equal(body.questions.asks_for_secrets.type, "noul");
  assert.equal(SCAN_QUESTIONS.harm.criteria.none.includes("collects nothing and sends nothing anywhere"), true);
});

test("state is the extraction only — facts and text, nothing else", () => {
  const extraction = page("destinations-script-fetch");
  const body = decisionsRequest(JEV_MODEL, extraction);
  assert.deepEqual(Object.keys(body.state), ["facts", "text"]);
  assert.equal(body.state.facts, extraction.facts);
  assert.equal(body.state.text, extraction.text);
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(JSON.stringify(body.state)), false, "no email address in state");
});

test("a documented 200 parses into typed answers, cost and the answering model", () => {
  const result = parseDecisionsResponse(documented);
  assert.equal(result.answers.harm.choice, "none");
  assert.equal(result.answers.impersonates.noul, 0.05);
  assert.equal(result.answers.asks_for_secrets.noul, 0.96);
  assert.equal(result.cost, 0.000019992);
  assert.equal(result.model, "typesafe/jev-1.13-20260917");
});

test("a 200 that is not the three typed answers is a malformed error, never a guess", () => {
  const answers = documented.answers as Record<string, Record<string, unknown>>;
  const broken = [
    { ...documented, usage: undefined },
    { ...documented, answers: { ...answers, harm: { ...answers.harm, choice: "phishing" } } },
    { ...documented, answers: { ...answers, impersonates: { type: "noul", noul: 1.4 } } },
    { ...documented, answers: { harm: answers.harm, impersonates: answers.impersonates } },
    null,
  ];
  for (const body of broken) {
    assert.throws(
      () => parseDecisionsResponse(body),
      (err: unknown) => err instanceof ClassifierError && err.kind === "malformed",
    );
  }
});

test("non-2xx statuses map to typed errors carrying the upstream message", () => {
  const body = (code: number, message: string) => ({ error: { code, message } });
  const credit = decisionsHttpError(402, body(402, "Insufficient credits. Add more using https://openrouter.ai/credits"));
  assert.equal(credit.kind, "credit_limit");
  assert.match(credit.message, /^Decisions API returned 402: Insufficient credits/);
  for (const status of [500, 502, 503, 524, 529]) {
    assert.equal(decisionsHttpError(status, body(status, "Provider returned error")).kind, "unavailable", String(status));
  }
  for (const status of [400, 401, 403, 404, 413, 429]) {
    assert.equal(decisionsHttpError(status, body(status, "x")).kind, "rejected", String(status));
  }
  assert.equal(decisionsHttpError(502, "<html>bad gateway</html>").message, "Decisions API returned 502");
});

test("D17: no OPENROUTER_API_KEY (or a blank one) → scanner off, no classifier", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(scannerEnabled(), false);
    assert.equal(defaultClassifier(), null);
    process.env.OPENROUTER_API_KEY = "   ";
    assert.equal(scannerEnabled(), false);
    assert.equal(defaultClassifier(), null);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder-not-a-key";
    assert.equal(scannerEnabled(), true);
    assert.equal(defaultClassifier()?.model, JEV_MODEL);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

test("live: Jev answers a real extraction with typed answers and a cost", { skip: skipLive }, async () => {
  const classifier = defaultClassifier();
  assert.ok(classifier);
  const result = await classifier.classify(page("clean-supabase-login"));
  assert.ok(HARM_CHOICES.includes(result.answers.harm.choice));
  assert.ok(result.cost >= 0);
  assert.match(result.model, /^typesafe\/jev-1\.13/);
});
