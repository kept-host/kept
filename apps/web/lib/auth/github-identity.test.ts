/**
 * D2's refusal, at the point where it is decided — E05 task 003.
 *
 * `selectGithubIdentity` is the whole of GitHub's half of decision D2: it takes
 * what GitHub returned and answers the only question account linking asks —
 * *which address, and did GitHub say it was verified?* Every property asserted
 * below is a security property, not a formatting preference.
 *
 * NO MOCKS (project rule) and none needed: this is a pure function over the two
 * GitHub API shapes. The values below are transcribed from real
 * `GET /user` / `GET /user/emails` responses. The live end of the same policy —
 * a real GitHub round trip against a registered OAuth app — is task 012's, and
 * `linking-refusal.test.ts` next door proves the database consequence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubNoreplyEmail,
  selectGithubIdentity,
  type GithubEmail,
  type GithubProfileLike,
} from "./github-identity";

const attacker: GithubProfileLike = {
  id: 90210,
  login: "not-alice",
  name: "Not Alice",
  // The PUBLIC PROFILE email — a display field the account holder types in.
  // This is the account-takeover vector D2 exists to close.
  email: "alice@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/90210?v=4",
};

const alice: GithubProfileLike = {
  id: 4242,
  login: "alice",
  name: "Alice",
  email: "alice@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/4242?v=4",
};

test("an unverified profile email is never the linking key", () => {
  // GitHub knows about the address and says plainly: not verified.
  const emails: GithubEmail[] = [
    { email: "alice@example.com", primary: true, verified: false },
  ];

  const identity = selectGithubIdentity(attacker, emails);

  assert.equal(identity.emailVerified, false, "an unverified address cannot authorise a link");
  assert.notEqual(
    identity.email,
    "alice@example.com",
    "the victim's address must not become the linking key",
  );
  assert.equal(identity.email, "90210+not-alice@users.noreply.github.com");
});

test("no verified address at all still yields a usable, distinct identity", () => {
  // Not an error and not a dead end: a noreply address unique to this GitHub
  // account, so Better Auth creates its OWN user row rather than refusing.
  for (const emails of [null, undefined, [] as GithubEmail[]]) {
    const identity = selectGithubIdentity(attacker, emails);
    assert.equal(identity.emailVerified, false);
    assert.equal(identity.email, githubNoreplyEmail(attacker));
  }
});

test("two GitHub accounts claiming one address get two different identities", () => {
  const claim: GithubEmail[] = [
    { email: "alice@example.com", primary: true, verified: false },
  ];

  const one = selectGithubIdentity(attacker, claim);
  const two = selectGithubIdentity({ ...attacker, id: 90211, login: "also-not-alice" }, claim);

  assert.notEqual(one.email, two.email, "the noreply form is per-account, so it cannot collide");
});

test("the verified primary address wins", () => {
  const emails: GithubEmail[] = [
    { email: "old@example.com", primary: false, verified: true },
    { email: "alice@example.com", primary: true, verified: true },
  ];

  assert.deepEqual(selectGithubIdentity(alice, emails), {
    email: "alice@example.com",
    emailVerified: true,
  });
});

test("an unverified primary does not shadow a verified secondary", () => {
  const emails: GithubEmail[] = [
    { email: "typo@example.com", primary: true, verified: false },
    { email: "alice@example.com", primary: false, verified: true },
  ];

  assert.deepEqual(selectGithubIdentity(alice, emails), {
    email: "alice@example.com",
    emailVerified: true,
  });
});

test("a profile with no email at all is not a special case", () => {
  const emails: GithubEmail[] = [
    { email: "alice@example.com", primary: true, verified: true },
  ];

  assert.deepEqual(selectGithubIdentity({ ...alice, email: null }, emails), {
    email: "alice@example.com",
    emailVerified: true,
  });
});
