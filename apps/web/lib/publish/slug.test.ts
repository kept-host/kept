import assert from "node:assert/strict";
import { test } from "node:test";

import { RESERVED_NAMES, slugSchema } from "@kept/shared";
import { isInappropriateName } from "@kept/shared/names";

import { SLUG_ALPHABET, SLUG_LENGTH, isReservedSlug, mintSlugCandidate } from "./slug";

const SAMPLE = 5_000;

test("every candidate satisfies slugSchema and the declared shape", () => {
  const allowed = new Set(SLUG_ALPHABET);
  for (let i = 0; i < SAMPLE; i++) {
    const slug = mintSlugCandidate();
    assert.equal(slug.length, SLUG_LENGTH);
    assert.ok(
      slugSchema.safeParse(slug).success,
      `slugSchema rejected ${slug}`,
    );
    for (const char of slug) {
      assert.ok(allowed.has(char), `${slug} used off-alphabet ${char}`);
    }
  }
});

test("reserved labels are rejected and never minted", () => {
  for (const label of RESERVED_NAMES) {
    assert.ok(isReservedSlug(label), `${label} should be reserved`);
  }
  assert.equal(isReservedSlug("k3nt5wqz"), false);
  for (let i = 0; i < SAMPLE; i++) {
    assert.equal(isReservedSlug(mintSlugCandidate()), false);
  }
});

test("`app` stays reserved even though the Worker no longer reserves the label", () => {
  // E05a: `app` left `RESERVED_LABELS` in apps/edge/src/host.ts so the Worker
  // stops 301'ing the control plane away from `app.{base}`. It must NOT leave
  // `RESERVED_NAMES` to match — keeping it is what makes an accidentally
  // re-proxied `app.` record a branded 404 instead of a user page published at
  // the control plane's own hostname.
  assert.ok(
    (RESERVED_NAMES as readonly string[]).includes("app"),
    "`app` must stay in RESERVED_NAMES: removing it lets a user page be minted at the control plane's hostname (app.kept.host)",
  );
  assert.ok(
    isReservedSlug("app"),
    "the slug guard, not just the constant, must refuse `app` — this is the check the minting path runs",
  );
});

test("a minted name never trips the inappropriate-name matcher chosen names use", () => {
  // Decision 5: the SAME matcher refuses chosen names and generated ones — on a
  // match the mint draws again. These spellings use only SLUG_ALPHABET, so a
  // random draw can produce them; the matcher must see them for the redraw to
  // mean anything.
  for (const spelled of ["x7fckq2b", "fvck2m9p", "h8fckbb9"]) {
    assert.ok(isInappropriateName(spelled), `${spelled} must be caught`);
  }
  assert.equal(isInappropriateName("k3nt5wqz"), false);
  for (let i = 0; i < SAMPLE; i++) {
    const slug = mintSlugCandidate();
    assert.equal(isInappropriateName(slug), false, slug);
  }
});

test("`site` and `settings` are reserved — E06's own two control-plane routes", () => {
  // The studio's page detail (`/site/[id]`) and `/settings`. The list carries
  // `dashboard`, `auth`, `p` and `keep` for exactly this reason; these two
  // joined it when E06 added the routes.
  for (const label of ["site", "settings"]) {
    assert.ok((RESERVED_NAMES as readonly string[]).includes(label));
    assert.ok(isReservedSlug(label), label);
  }
});

test("candidates are near-unique across a large sample", () => {
  const seen = new Set<string>();
  for (let i = 0; i < SAMPLE; i++) seen.add(mintSlugCandidate());
  // 32^8 keyspace: the birthday expectation at this sample size is ~1e-2
  // collisions, so a single duplicate is already a red flag.
  assert.equal(seen.size, SAMPLE);
});
