/**
 * E07 AC28 — the brand and phishing rule for chosen names (§6.16), through
 * `@kept/shared/names`.
 *
 *   · the look-alike readings the spec names (`paypa1`, `paypai`, `rnicrosoft`,
 *     `pay-pal`, `micr0soft`) read `reserved` — the existing status, on both plans;
 *   · EVERY list entry has a "must refuse" and a "must accept" case beside it
 *     here, and the test fails when an entry lands without one (the way
 *     `ACCEPTED_TERMS` documents its cases);
 *   · the matcher is its own normaliser — no `obscenity` import.
 *
 * Pure, no database. Lives in `apps/web` because `packages/shared` has no test
 * runner (precedent: `lib/plans/validate-name.test.ts`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import { PLANS } from "@kept/shared";
import {
  BLOCKED_NAME_PAIRS,
  BLOCKED_NAME_TERMS,
  NAME_SECURITY_WORDS,
  isBlockedBrandName,
  validateName,
} from "@kept/shared/names";

/** Per entry: names that must read `reserved`, and names that must stay `ok`. */
const CASES: Record<string, { refuse: string[]; accept: string[] }> = {
  // ── BLOCKED_NAME_TERMS: anywhere in the name ──
  paypal: { refuse: ["paypa1", "paypai", "pay-pal", "paypal-help", "paypall-login"], accept: ["payday-plan", "pal-pay"] },
  microsoft: { refuse: ["rnicrosoft", "micr0soft", "microsoft-365"], accept: ["microscope", "soft-micro"] },
  office365: { refuse: ["office365-login", "0ffice365"], accept: ["office-hours"] },
  metamask: { refuse: ["metamask-wallet", "meta-mask"], accept: ["meta-notes"] },
  coinbase: { refuse: ["coinbase-help", "c0inbase"], accept: ["coin-collection", "base-coin"] },
  binance: { refuse: ["binance-login", "b1nance"], accept: ["binary-dance", "finance-notes"] },
  sparkasse: { refuse: ["sparkasse-online", "sparkase"], accept: ["spark-notes"] },
  docusign: { refuse: ["docusign-review", "docu-sign"], accept: ["sign-docs"] },
  netflix: { refuse: ["netflix-account", "netfl1x"], accept: ["net-fixes"] },
  instagram: { refuse: ["instagram-verify", "1nstagram"], accept: ["insta-notes", "gram-scale"] },
  whatsapp: { refuse: ["whatsapp-web", "whats-app"], accept: ["whats-up"] },
  facebook: { refuse: ["facebook-login", "faceb00k"], accept: ["face-paint", "book-face"] },
  wellsfargo: { refuse: ["wellsfargo-online", "wells-fargo"], accept: ["wells-and-springs", "fargo-trip"] },
  bankofamerica: { refuse: ["bank-of-america"], accept: ["bank-of-ideas", "america-trip"] },
  commerzbank: { refuse: ["commerzbank-login"], accept: ["commerce-bank"] },
  deutschebank: { refuse: ["deutsche-bank"], accept: ["deutsche-bahn"] },
  volksbank: { refuse: ["volksbank-online"], accept: ["volkslied", "folks-bank"] },
  barclays: { refuse: ["barclays-help"], accept: ["barclay"] },
  trustwallet: { refuse: ["trust-wallet"], accept: ["trust-fall"] },
  steamcommunity: { refuse: ["steamcommunity-gift", "steam-community"], accept: ["community-garden"] },
  // ── BLOCKED_NAME_PAIRS: a whole token, beside a security word ──
  apple: {
    refuse: ["apple-id-login", "applelogin", "secureapple", "my-apple-account", "app1e-verify"],
    accept: ["applepie", "apple-pie", "pineapple-update"],
  },
  amazon: { refuse: ["amazon-verify", "amaz0n-billing"], accept: ["amazonia", "amazonia-update", "amazon-river"] },
  chase: { refuse: ["chase-login", "chasesupport"], accept: ["chasewalks", "purchase-confirm", "purchaseupdate", "chase-the-sun"] },
  google: { refuse: ["google-login", "g00gle-verify", "gooogle-account"], accept: ["google-docs", "ski-goggles"] },
  outlook: { refuse: ["outlook-login", "0utlook-update"], accept: ["outlook-weekly", "market-outlook"] },
  icloud: { refuse: ["icloud-login", "icl0ud-unlock"], accept: ["musicloud", "icloud-photos"] },
  gmail: { refuse: ["gmail-verify"], accept: ["bigmail", "gmail-tips"] },
  yahoo: { refuse: ["yahoo-login"], accept: ["yahoos"] },
  ebay: { refuse: ["ebay-login"], accept: ["maybe-bay", "ebay-finds"] },
  dropbox: { refuse: ["dropbox-login"], accept: ["drop-box"] },
  adobe: { refuse: ["adobe-update"], accept: ["adobe-house"] },
  ledger: { refuse: ["ledger-wallet", "ledger-recovery"], accept: ["ledger-notes"] },
  kraken: { refuse: ["kraken-login"], accept: ["kraken-tales"] },
  revolut: { refuse: ["revolut-login"], accept: ["revolution-login"] },
  dhl: { refuse: ["dhl-update"], accept: ["dhl-tracking"] },
  steam: { refuse: ["steam-login"], accept: ["steam-engine"] },
};

test("AC28: the spec's look-alikes read `reserved` on every plan", () => {
  for (const plan of PLANS) {
    for (const name of ["paypa1", "paypai", "rnicrosoft", "pay-pal", "micr0soft"]) {
      assert.equal(validateName(name, plan), "reserved", `${plan}: ${name}`);
    }
  }
});

test("AC28: every list entry has a must-refuse and a must-accept case", () => {
  const entries = [...BLOCKED_NAME_TERMS, ...BLOCKED_NAME_PAIRS];
  assert.equal(new Set(entries).size, entries.length, "an entry is in both lists");
  assert.deepEqual(Object.keys(CASES).sort(), [...entries].sort());
  for (const [entry, { refuse, accept }] of Object.entries(CASES)) {
    assert.ok(refuse.length > 0 && accept.length > 0, entry);
  }
});

test("AC28: each entry's must-refuse names read `reserved`, its must-accept names `ok`", () => {
  for (const [entry, { refuse, accept }] of Object.entries(CASES)) {
    for (const name of refuse) {
      assert.ok(isBlockedBrandName(name), `${entry}: ${name} should be refused`);
      assert.equal(validateName(name, "premium"), "reserved", `${entry}: ${name}`);
    }
    for (const name of accept) {
      assert.equal(isBlockedBrandName(name), false, `${entry}: ${name} should be accepted`);
      assert.equal(validateName(name, "premium"), "ok", `${entry}: ${name}`);
    }
  }
});

test("AC28: a pair brand is refused beside every security word, glued or hyphenated", () => {
  for (const word of NAME_SECURITY_WORDS) {
    for (const name of [`apple-${word}`, `${word}-apple`, `apple${word}`, `${word}apple`]) {
      assert.equal(validateName(name, "premium"), "reserved", name);
    }
  }
});

test("AC28: each look-alike mapping is a variant beside the original", () => {
  const byMapping: [string, string][] = [
    ["strip -", "pay-pal"],
    ["collapse repeats", "paaypall"],
    ["0→o 3→e 4→a 5→s 7→t 8→b", "p4yp4l"],
    ["1→i", "1nstagram"],
    ["1→l", "paypa1"],
    ["rn→m", "rnicrosoft"],
    ["vv→w", "vvhatsapp"],
    ["cl→d", "clocusign"],
    ["cl→d, pair", "aclobe-update"],
  ];
  for (const [mapping, name] of byMapping) {
    assert.equal(validateName(name, "premium"), "reserved", `${mapping}: ${name}`);
  }
  // Each mapping ADDS a reading: a genuine `1`, `rn` or `cl` is still itself.
  assert.ok(isBlockedBrandName("icloud-login"), "cl read as cl");
  assert.ok(isBlockedBrandName("kraken-login"), "rn-free name read as itself");
  for (const name of ["cl1ent-portal", "corner-shop", "classic-loader", "quiet-river-42"]) {
    assert.equal(validateName(name, "free"), "ok", name);
  }
});

test("AC28: the matcher brings its own normaliser — no `obscenity` import", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(
    require.resolve("@kept/shared/names").replace(/names\.ts$/, "brand-terms.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']obscenity["']/);
});
