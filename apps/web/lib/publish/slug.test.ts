import assert from "node:assert/strict";
import { test } from "node:test";

import { slugSchema } from "@kept/shared";

import {
  RESERVED_SLUGS,
  SLUG_ALPHABET,
  SLUG_LENGTH,
  containsProfanity,
  isReservedSlug,
  mintSlugCandidate,
} from "./slug";

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
  for (const label of RESERVED_SLUGS) {
    assert.ok(isReservedSlug(label), `${label} should be reserved`);
  }
  assert.equal(isReservedSlug("k3nt5wqz"), false);
  for (let i = 0; i < SAMPLE; i++) {
    assert.equal(isReservedSlug(mintSlugCandidate()), false);
  }
});

test("profane substrings are rejected and never minted", () => {
  assert.ok(containsProfanity("x7assq2b"));
  assert.ok(containsProfanity("fckz3m9p"));
  assert.ok(containsProfanity("2b3xxxkq"));
  assert.equal(containsProfanity("k3nt5wqz"), false);
  for (let i = 0; i < SAMPLE; i++) {
    assert.equal(containsProfanity(mintSlugCandidate()), false);
  }
});

test("candidates are near-unique across a large sample", () => {
  const seen = new Set<string>();
  for (let i = 0; i < SAMPLE; i++) seen.add(mintSlugCandidate());
  // 32^8 keyspace: the birthday expectation at this sample size is ~1e-2
  // collisions, so a single duplicate is already a red flag.
  assert.equal(seen.size, SAMPLE);
});
