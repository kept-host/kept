/**
 * E10 task 001 — the profile, handle, referral, Details and remix-prompt
 * contract in `@kept/shared` (./profile, ./manage, ./agent-copy).
 *
 * Lives in `apps/web` because `packages/shared` has no test runner. Pure: no
 * store is touched. Real code, no mocks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HANDLE_CHANGE_DAYS,
  KEPT_PROD_ORIGIN,
  PROFILE_BIO_MAX,
  PROVENANCE_LIMITS,
  REFERRAL_CODE_LENGTH,
  REMIX_PROMPT_MAX,
  SOCIAL_HOSTS,
  handleChangeRequestSchema,
  nameCheckResultSchema,
  profileUpdateRequestSchema,
  referralCodeSchema,
  referralStatsSchema,
  remixPrompt,
  siteUpdateRequestSchema,
  socialsSchema,
} from "@kept/shared";

test("the profile constants", () => {
  assert.equal(PROFILE_BIO_MAX, 160);
  assert.equal(HANDLE_CHANGE_DAYS, 30);
  assert.equal(REFERRAL_CODE_LENGTH, 8);
  assert.deepEqual(Object.keys(SOCIAL_HOSTS), [
    "x",
    "linkedin",
    "youtube",
    "github",
    "instagram",
    "tiktok",
    "bluesky",
    "website",
  ]);
});

test("bio: trimmed, ≤ PROFILE_BIO_MAX, empty clears it", () => {
  assert.deepEqual(profileUpdateRequestSchema.parse({ bio: "  hi  " }), { bio: "hi" });
  assert.deepEqual(profileUpdateRequestSchema.parse({ bio: "   " }), { bio: null });
  assert.equal(profileUpdateRequestSchema.safeParse({ bio: "b".repeat(PROFILE_BIO_MAX) }).success, true);
  const long = profileUpdateRequestSchema.safeParse({ bio: "b".repeat(PROFILE_BIO_MAX + 1) });
  assert.equal(long.success, false);
  assert.equal(long.error?.issues[0]?.message, `Bios can be up to ${PROFILE_BIO_MAX} characters.`);
});

test("profile update: any subset, never empty; badge style is a closed enum", () => {
  assert.equal(profileUpdateRequestSchema.safeParse({}).success, false);
  assert.deepEqual(profileUpdateRequestSchema.parse({ badgeStyle: "minimal" }), { badgeStyle: "minimal" });
  assert.equal(profileUpdateRequestSchema.safeParse({ badgeStyle: "loud" }).success, false);
  assert.deepEqual(profileUpdateRequestSchema.parse({ displayName: "  Arun   K " }), { displayName: "Arun K" });
  assert.equal(profileUpdateRequestSchema.safeParse({ displayName: "  " }).success, false);
});

test("socials: https only, on the network's own hosts; website is any https URL", () => {
  const ok = {
    x: "https://x.com/arun",
    linkedin: "https://www.linkedin.com/in/arun",
    youtube: "https://youtu.be/abc",
    github: "https://github.com/arun",
    instagram: "https://instagram.com/arun",
    tiktok: "https://www.tiktok.com/@arun",
    bluesky: "https://bsky.app/profile/arun.bsky.social",
    website: "https://arun.example",
  };
  assert.deepEqual(socialsSchema.parse(ok), ok);
  assert.deepEqual(socialsSchema.parse({ x: "https://twitter.com/arun" }), { x: "https://twitter.com/arun" });

  const refused: Record<string, string>[] = [
    { x: "http://x.com/arun" }, // not https
    { github: "https://gitlab.com/arun" }, // wrong host
    { github: "https://github.com.evil.example/arun" }, // suffix trick
    { github: "https://evilgithub.com/arun" }, // no dot boundary
    { website: "javascript:alert(1)" },
    { website: "http://arun.example" },
    { website: "https://user:pass@arun.example" },
    { mastodon: "https://mastodon.social/@arun" }, // not a known network
  ];
  for (const socials of refused) {
    assert.equal(socialsSchema.safeParse(socials).success, false, JSON.stringify(socials));
  }
  const wrongHost = socialsSchema.safeParse({ github: "https://gitlab.com/arun" });
  assert.equal(wrongHost.error?.issues[0]?.message, "Use an https:// link on github.com.");
});

test("handle change request, referral code and stats shapes", () => {
  assert.deepEqual(handleChangeRequestSchema.parse({ handle: "arun" }), { handle: "arun" });
  assert.equal(handleChangeRequestSchema.safeParse({}).success, false);

  assert.equal(referralCodeSchema.safeParse("k3n8vq2p").success, true);
  assert.equal(referralCodeSchema.safeParse("0123abcd").success, true, "the hex backfill fits");
  assert.equal(referralCodeSchema.safeParse("K3N8VQ2P").success, false);
  assert.equal(referralCodeSchema.safeParse("k3n8vq2").success, false);

  const stats = {
    refCode: "arun",
    verifiedCount: 1,
    referrals: [{ createdAt: "2026-10-28T12:00:00.000Z", displayName: null }],
  };
  assert.deepEqual(referralStatsSchema.parse(stats), stats);
});

test("name check: handle_change_limited carries the date it lifts", () => {
  assert.deepEqual(nameCheckResultSchema.parse({ status: "handle_change_limited", availableOn: "2026-11-27" }), {
    status: "handle_change_limited",
    availableOn: "2026-11-27",
  });
  assert.equal(nameCheckResultSchema.safeParse({ status: "handle_change_limited" }).success, false);
});

test("Details save: provenance fields reuse E09's caps; '' clears to null; absent stays absent", () => {
  assert.deepEqual(
    siteUpdateRequestSchema.parse({
      model: " claude-opus-4-7 ",
      tool: "",
      sourceUrl: "https://github.com/arun/page",
      showPrompt: true,
      showMadeWith: false,
      allowRemix: null,
    }),
    {
      model: "claude-opus-4-7",
      tool: null,
      sourceUrl: "https://github.com/arun/page",
      showPrompt: true,
      showMadeWith: false,
      allowRemix: null,
    },
  );
  assert.deepEqual(siteUpdateRequestSchema.parse({ sourceUrl: "  " }), { sourceUrl: null });
  assert.equal(siteUpdateRequestSchema.safeParse({ sourceUrl: "ftp://x.example" }).success, false);
  assert.equal(siteUpdateRequestSchema.safeParse({ model: "m".repeat(PROVENANCE_LIMITS.model + 1) }).success, false);
  assert.equal(siteUpdateRequestSchema.safeParse({ readme: "r".repeat(PROVENANCE_LIMITS.readme) }).success, true);
  assert.equal(siteUpdateRequestSchema.safeParse({ readme: "r".repeat(PROVENANCE_LIMITS.readme + 1) }).success, false);
  assert.equal(siteUpdateRequestSchema.safeParse({}).success, false, "an empty save is a caller bug");
  assert.deepEqual(siteUpdateRequestSchema.parse({ title: "  A  title " }), { title: "A title" }, "E06 unchanged");
});

test("remix prompt: D7's text, the fixed prod link, remix_of the slug", () => {
  const plain = remixPrompt({ pageUrl: "https://recipe-notes.kept.host" });
  console.log(`[remix] ${plain}`);
  assert.equal(
    plain,
    'Make a page like https://recipe-notes.kept.host. Then publish it with kept (https://kept.host/agents) and pass remix_of: "recipe-notes".',
  );

  const shown = remixPrompt({ pageUrl: "https://recipe-notes.kept.host", shownPrompt: "A recipe card." });
  assert.ok(shown.includes("Here's the prompt that made it:\n\nA recipe card.\n\nThen publish"));

  // A dev page URL is data; the instructions still point at production.
  const dev = remixPrompt({ pageUrl: "https://recipe-notes.kept-dev.xyz", shownPrompt: "x" });
  assert.ok(dev.includes(`(${KEPT_PROD_ORIGIN}/agents)`));
  assert.equal(dev.replace("https://recipe-notes.kept-dev.xyz", "").includes("kept-dev"), false);
});

test("remix prompt: capped at REMIX_PROMPT_MAX, the shown prompt cut with … so the instructions survive", () => {
  assert.equal(REMIX_PROMPT_MAX, 4000);
  const long = remixPrompt({
    pageUrl: "https://recipe-notes.kept.host",
    shownPrompt: "p".repeat(PROVENANCE_LIMITS.prompt),
  });
  assert.equal(long.length, REMIX_PROMPT_MAX);
  assert.ok(long.includes("p…\n\nThen publish it with kept"));
  assert.ok(long.endsWith('pass remix_of: "recipe-notes".'));

  const emoji = remixPrompt({ pageUrl: "https://recipe-notes.kept.host", shownPrompt: "😀".repeat(3000) });
  assert.ok(emoji.length <= REMIX_PROMPT_MAX);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
});
