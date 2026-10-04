/**
 * The pure name rule — `validateName` and the inappropriate-word matcher behind
 * it (`@kept/shared/names`) — for BOTH plans.
 *
 *   · AC16 (pure half): each pure status for a representative input.
 *   · AC22: every reserved name reads `reserved` at every length, which is the
 *     precedence deviation from PRD §5.4's table (see `validateName`'s note).
 *   · Arun's decision 5: the word filter catches hyphenated, concatenated and
 *     leetspeak forms and leaves ordinary words alone — against the real
 *     `obscenity` dataset, no mocks.
 *
 * Lives in `apps/web` because `packages/shared` has no test runner (precedent:
 * `lib/mascot/*.test.ts`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  NAME_ABSOLUTE_MIN_LENGTH,
  NAME_CHECK_STATUSES,
  NAME_MAX_LENGTH,
  PLANS,
  RESERVED_NAMES,
  STUDIO_ERROR_CODES,
  limitsFor,
} from "@kept/shared";
import { isInappropriateName, validateName, type NameValidation } from "@kept/shared/names";

test("AC16: invalid — the shape is slugSchema's, on every plan", () => {
  for (const plan of PLANS) {
    for (const bad of [
      "",
      "Has-Capitals",
      "under_scores",
      "-leading",
      "trailing-",
      "double--hyphen",
      "spaces here",
      "dots.in.it",
      "a".repeat(NAME_MAX_LENGTH + 1),
    ]) {
      assert.equal(validateName(bad, plan), "invalid", `${plan}: ${JSON.stringify(bad)}`);
    }
  }
});

test("AC16: too_short — 1, 2 and 3 characters are refused on every plan", () => {
  for (const plan of PLANS) {
    for (const short of ["q", "qz", "qz7"]) {
      assert.ok(short.length < NAME_ABSOLUTE_MIN_LENGTH);
      assert.equal(validateName(short, plan), "too_short", `${plan}: ${short}`);
    }
  }
});

test("AC16: pro_length — exactly 4 characters on free; the same name is ok on premium", () => {
  assert.equal(limitsFor("free").nameMinLength, NAME_ABSOLUTE_MIN_LENGTH + 1);
  for (const four of ["abcd", "q2z7", "my-x"]) {
    assert.equal(four.length, NAME_ABSOLUTE_MIN_LENGTH);
    assert.equal(validateName(four, "free"), "pro_length", `free: ${four}`);
    assert.equal(validateName(four, "premium"), "ok", `premium: ${four}`);
  }
});

test("AC16: ok — from the plan's minimum up to NAME_MAX_LENGTH", () => {
  for (const plan of PLANS) {
    for (const good of ["my-notes", "hello", "2026-review", "a".repeat(NAME_MAX_LENGTH)]) {
      assert.equal(validateName(good, plan), "ok", `${plan}: ${good}`);
    }
  }
});

test("RESERVED_NAMES is the pre-E06 reserved slugs ∪ PRD §5.4's list, and nothing more", () => {
  // The control plane's reserved slugs before E06 (`apps/web/lib/publish/slug.ts`).
  const preE06 = [
    "www", "app", "api", "assets", "p", "keep", "stats", "promise", "dashboard",
    "auth", "health", "site", "settings",
  ];
  // PRD §5.4, verbatim. Open question 2's default: the union, nothing added.
  const prd = [
    "www", "api", "app", "assets", "mcp", "admin", "root", "mail", "smtp", "status",
    "docs", "blog", "help", "support", "explore", "founding", "wall", "legal", "abuse",
    "report", "stats", "promise", "faq", "about", "pricing", "login", "signin", "signup",
    "auth", "account", "settings", "dashboard", "kept", "keep", "draft", "static", "cdn",
    "img", "media", "dev", "staging", "test",
  ];
  assert.equal(new Set(RESERVED_NAMES).size, RESERVED_NAMES.length, "no duplicates");
  assert.deepEqual([...RESERVED_NAMES].sort(), [...new Set([...preE06, ...prd])].sort());
});

test("AC22: every reserved name reads `reserved` on every plan, at every length", () => {
  for (const plan of PLANS) {
    for (const name of RESERVED_NAMES) {
      assert.equal(validateName(name, plan), "reserved", `${plan}: ${name}`);
    }
  }
  // The cases that pin the precedence deviation. Under PRD §5.4's literal
  // table order these would read `too_short` (3 letters, or `p`) and — on
  // free — `pro_length`, an upsell to a name Pro could never grant.
  for (const plan of PLANS) {
    for (const short of ["app", "www", "cdn", "img", "dev", "p"]) {
      assert.equal(validateName(short, plan), "reserved", `${plan}: ${short}`);
    }
  }
  for (const four of ["docs", "help", "wall", "kept", "keep"]) {
    assert.equal(validateName(four, "free"), "reserved", `free: ${four}`);
  }
});

test("decision 5: the word filter rejects hyphenated, concatenated and leetspeak forms", () => {
  for (const name of ["fuck", "my-fuck-page", "fuckpage", "fvck", "sh1t"]) {
    assert.equal(isInappropriateName(name), true, `isInappropriateName(${name})`);
    // On every plan, and BEFORE the length rule: a 4-letter word on free must
    // not read `pro_length` — that would be an upsell to it.
    for (const plan of PLANS) {
      assert.equal(validateName(name, plan), "inappropriate", `${plan}: ${name}`);
    }
  }
});

test("decision 5: the word filter accepts ordinary words that merely contain one", () => {
  for (const name of ["classic", "bass", "assassin", "scunthorpe", "therapist", "cockpit-sim"]) {
    assert.equal(isInappropriateName(name), false, `isInappropriateName(${name})`);
  }
  for (const plan of PLANS) {
    for (const name of ["classic", "assassin", "scunthorpe", "therapist", "cockpit-sim"]) {
      assert.equal(validateName(name, plan), "ok", `${plan}: ${name}`);
    }
  }
  // `bass` is four letters: it reads as a length question, never a word one.
  assert.equal(validateName("bass", "free"), "pro_length");
  assert.equal(validateName("bass", "premium"), "ok");
});

test("policy pins: the outcomes the old substring list gave, under the new filter", () => {
  // The hand-rolled substring list `checkChosenSlug` applied refused
  // `my-ass-page` AND `classic` (it contains `ass`). Decision 5 replaced it
  // with `obscenity` for chosen names: the first is still refused, the second
  // is not. Any further policy change — E07 owns moderation — is an edit to
  // these expectations, never a surprise.
  assert.equal(validateName("my-ass-page", "free"), "inappropriate");
  assert.equal(validateName("classic", "free"), "ok");
});

test("⚠️ the E07 deferral, asserted so it is a decision and not a surprise", () => {
  // Impersonation, typosquatting and homoglyph tricks are NOT covered by this
  // rule and are explicitly E07's. If a future change starts refusing these,
  // this expectation is where that policy's arrival is recorded — not a bug to
  // fix by loosening it back.
  for (const plan of PLANS) {
    for (const unpoliced of ["paypal-verify", "signin-microsoft", "paypa1-secure", "g00gle-docs"]) {
      assert.equal(validateName(unpoliced, plan), "ok", `${plan}: ${unpoliced}`);
    }
  }
});

test("every refusal validateName gives is a name check status and a `name_*` studio error code", () => {
  const refusals: Exclude<NameValidation, "ok">[] = [
    "invalid",
    "too_short",
    "pro_length",
    "reserved",
    "inappropriate",
  ];
  for (const status of refusals) {
    assert.ok((NAME_CHECK_STATUSES as readonly string[]).includes(status), status);
    assert.ok(
      (STUDIO_ERROR_CODES as readonly string[]).includes(`name_${status}`),
      `name_${status} must be a STUDIO_ERROR_CODES member`,
    );
  }
});

test("the word list stays out of every module apps/edge imports", () => {
  // `apps/edge` imports the `@kept/shared` barrel; `obscenity` may be reached
  // only through the `@kept/shared/names` subpath. Asserted over source here;
  // the bundle itself was proven with a wrangler dry-run in E06 task 001.
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const grep = (pattern: string, ...paths: string[]): string[] => {
    try {
      return execFileSync("git", ["grep", "--untracked", "-lE", pattern, "--", ...paths], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      if ((error as { status?: number }).status === 1) return [];
      throw error;
    }
  };
  assert.deepEqual(grep(`from "obscenity"`, "packages/shared/src"), ["packages/shared/src/names.ts"]);
  assert.deepEqual(grep(`from "\\./names"`, "packages/shared/src"), []);
  assert.deepEqual(grep(`@kept/shared/names|obscenity`, "apps/edge/src"), []);
});
