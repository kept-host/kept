/**
 * D1 — `limitsFor(plan)` is the one place a limit lives (AC1), asserted three ways:
 *
 *   1. its values, exactly, for every plan;
 *   2. a SOURCE guard: no `50` or `1000` — the free and Pro numbers most likely
 *      to be retyped — may appear in `apps/web` app source outside an annotated
 *      allowlist of the hits that are not limits (CSS, Tailwind, milliseconds).
 *      A new hit anywhere fails here and forces a reviewed allowlist edit;
 *   3. a second SOURCE guard (E06 task 003): `KEPT_PAGE_LIMIT` — the free
 *      number under its old name — may be used only by the surfaces that have
 *      no plan in scope. Anything that decides a cap or speaks to a signed-in
 *      account reads `limitsFor(plan)`, so a premium account is never told, or
 *      held to, the free number.
 *
 * Plus latent bug 2: `keptQuotaSchema.limit` was `z.literal(KEPT_PAGE_LIMIT)`,
 * so any limit but the free literal made every `keepResultSchema.parse` throw —
 * a 500 on every keep for the first premium account.
 *
 * Lives in `apps/web` because `packages/shared` has no test runner (precedent:
 * `lib/mascot/*.test.ts`). Real code, no mocks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  KEPT_PAGE_LIMIT,
  NAME_ABSOLUTE_MIN_LENGTH,
  NAME_MAX_LENGTH,
  PLANS,
  PLAN_LIMITS,
  SLUG_MAX_LENGTH,
  keepResultSchema,
  limitsFor,
} from "@kept/shared";

import { stripComments } from "../testing/strip-comments";

test("AC1: limitsFor returns each plan's exact limits", () => {
  assert.deepEqual(limitsFor("free"), {
    keptPages: 50,
    chosenNames: 5,
    nameMinLength: 5,
    previousVersions: 1,
  });
  assert.deepEqual(limitsFor("premium"), {
    keptPages: 1000,
    chosenNames: 50,
    nameMinLength: 4,
    previousVersions: 20,
  });
});

test("every plan has limits, and none grants a name shorter than NAME_ABSOLUTE_MIN_LENGTH", () => {
  assert.deepEqual(Object.keys(PLAN_LIMITS).sort(), [...PLANS].sort());
  for (const plan of PLANS) {
    assert.ok(
      limitsFor(plan).nameMinLength >= NAME_ABSOLUTE_MIN_LENGTH,
      `${plan}: nameMinLength ${limitsFor(plan).nameMinLength} is below the absolute floor ${NAME_ABSOLUTE_MIN_LENGTH} — nobody gets a name of 3 characters or fewer`,
    );
  }
});

test("KEPT_PAGE_LIMIT is the free plan's number, not a second source", () => {
  assert.equal(KEPT_PAGE_LIMIT, limitsFor("free").keptPages);
});

test("NAME_MAX_LENGTH is SLUG_MAX_LENGTH, not a second 63", () => {
  assert.equal(NAME_MAX_LENGTH, SLUG_MAX_LENGTH);
});

test("bug 2: a KeepResult carrying any plan's kept limit parses", () => {
  // Failing-first: under `z.literal(KEPT_PAGE_LIMIT)` both plans' limits threw.
  for (const plan of PLANS) {
    const { keptPages } = limitsFor(plan);
    const parsed = keepResultSchema.parse({
      outcome: "kept",
      siteId: "00000000-0000-4000-8000-000000000000",
      slug: "k3nt5wqz",
      quota: { limit: keptPages, used: 1, remaining: keptPages - 1 },
    });
    assert.equal(parsed.quota.limit, keptPages, `${plan}: quota.limit round-trips`);
  }
});

test("bug 2: the quota limit is still a positive integer, not any number", () => {
  for (const limit of [0, -1, 2.5]) {
    const result = keepResultSchema.safeParse({
      outcome: "kept",
      siteId: "00000000-0000-4000-8000-000000000000",
      slug: "k3nt5wqz",
      quota: { limit, used: 0, remaining: 0 },
    });
    assert.equal(result.success, false, `limit ${limit} must be refused`);
  }
});

// ─── The source guard ──────────────────────────────────────────────────────

/** `apps/web`, the directory every path below is relative to. */
const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The two numbers, as whole words — `git grep -w`'s definition of a word. */
const LIMIT_LITERAL = /(?<![A-Za-z0-9_])(?:50|1000)(?![A-Za-z0-9_])/g;

/**
 * Every app-source hit that is NOT a limit, by file, with how many occurrences
 * survive comment stripping. The count is exact on purpose: a new `50` in an
 * allowlisted file changes it, and so does removing one, so the list can never
 * carry slack a future limit could hide in.
 */
const NOT_A_LIMIT: Record<string, { occurrences: number; reason: string }> = {
  "app/auth/sign-in-form.tsx": {
    occurrences: 1,
    reason: "1000 ms: the magic-link resend cooldown ticks once a second",
  },
  "components/kept/KeptLanding.tsx": {
    occurrences: 28,
    reason: "CSS: `50%` radii, centring and gradient stops; `zIndex: 50`",
  },
  "components/kept/draft-chip.tsx": {
    occurrences: 1,
    reason: "1000 ms per second, inside MS_PER_HOUR",
  },
  "components/kept/drop-target.tsx": {
    occurrences: 2,
    reason: "Tailwind `z-50` / `opacity-50`",
  },
  "components/kept/kept-engine.ts": {
    occurrences: 7,
    reason: "canvas geometry (`W / 2 - 50`), ms ↔ s conversions, CSS `50%`",
  },
  "components/kept/mascot.tsx": {
    occurrences: 2,
    reason: "ms → s conversion on the rAF clock",
  },
  "components/kept/site-card.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/button.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/dialog.tsx": { occurrences: 2, reason: "Tailwind `z-50`" },
  "components/ui/dropdown-menu.tsx": {
    occurrences: 4,
    reason: "Tailwind `z-50` / `opacity-50`",
  },
  "components/ui/input.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/popover.tsx": { occurrences: 1, reason: "Tailwind `z-50`" },
  "components/ui/switch.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/tabs.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/textarea.tsx": { occurrences: 1, reason: "Tailwind `opacity-50`" },
  "components/ui/tooltip.tsx": { occurrences: 1, reason: "Tailwind `z-50`" },
  "lib/db/queries/reminders.ts": {
    occurrences: 1,
    reason: "1000 ms per second, in a days → ms horizon",
  },
  "lib/email/draft-reminder.ts": { occurrences: 1, reason: "1000 ms per second, inside MS_PER_DAY" },
  "lib/publish/pipeline.ts": { occurrences: 1, reason: "1000 ms per second, inside MS_PER_DAY" },
  "lib/sites/display.ts": { occurrences: 1, reason: "1000 ms per second, inside MS_PER_HOUR" },
  "lib/storage/manifest.ts": { occurrences: 1, reason: "s → ms for the KV re-purge delay" },
  "lib/testing/names-drill.ts": { occurrences: 1, reason: "1000 ms per second, inside MS_PER_DAY" },
  "scripts/smoke-release.ts": { occurrences: 1, reason: "ms → s for a log line" },
};

/**
 * App-source files with a whole-word `50` or `1000` anywhere — comments
 * included; the comment filter is the next step. `--untracked` so a file that
 * is new and not yet committed is scanned too; ignored paths (`.next/`,
 * `node_modules/`) stay out because git's standard excludes still apply.
 */
function candidateFiles(): string[] {
  try {
    return execFileSync(
      "git",
      ["grep", "--untracked", "-lwE", "50|1000", "--", "*.ts", "*.tsx", ":!*.test.ts", ":!e2e"],
      { cwd: WEB_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches — an empty result, not a failure.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

test("AC1 guard: no `50` or `1000` in apps/web source outside the annotated allowlist", () => {
  const found: Record<string, number> = {};
  for (const file of candidateFiles()) {
    const code = stripComments(readFileSync(join(WEB_ROOT, file), "utf8"));
    const occurrences = code.match(LIMIT_LITERAL)?.length ?? 0;
    if (occurrences > 0) found[file] = occurrences;
  }

  const expected = Object.fromEntries(
    Object.entries(NOT_A_LIMIT).map(([file, { occurrences }]) => [file, occurrences]),
  );
  assert.deepEqual(
    found,
    expected,
    "A `50` or `1000` appeared, moved or disappeared in apps/web source. If it is a plan " +
      "limit, read it from `limitsFor(plan)` (@kept/shared) instead. If it is not a limit, " +
      "update NOT_A_LIMIT with the new count and a reason.",
  );
});

test("the guard can see: it finds the allowlisted files at all", () => {
  // A guard that silently scans nothing passes forever. `git` missing, a wrong
  // cwd or a pathspec typo would all look like a clean tree.
  const files = candidateFiles();
  assert.ok(files.includes("components/ui/dialog.tsx"), `scanned: ${files.join(", ")}`);
});

// ─── The KEPT_PAGE_LIMIT guard ─────────────────────────────────────────────

/**
 * The ONLY app files that may use `KEPT_PAGE_LIMIT`, each with the reason it has
 * no plan to ask `limitsFor` about. Every one of them is stating the FREE offer
 * to somebody who has no account — which is the one thing the alias means.
 *
 * Deliberately absent, so they fail here if they regress: `lib/sites/keep.ts`
 * and `lib/sites/publish.ts` (they DECIDE the cap — under `lockOwner`, from the
 * owner's plan), and every signed-in surface that prints it — `/auth/callback/done`,
 * the swap chooser, `kept-quota`, `plan-panel` — which all read a `KeptQuota` or
 * `limitsFor(plan)`.
 */
const KEPT_PAGE_LIMIT_ALLOWED: Record<string, string> = {
  "app/keep/[anonToken]/page.tsx":
    "the keep screen a stranger sees BEFORE signing in: no account, so no plan",
  "components/kept/KeptLanding.tsx": "the landing states the free offer to visitors with no account",
  "lib/email/draft-reminder.ts":
    "the reminder goes to an anonymous publisher: the draft has no owner, so no plan",
};

/** App-source files that USE the name — comments stripped, so prose may still cite it. */
function keptPageLimitUsers(): string[] {
  let files: string[];
  try {
    files = execFileSync(
      "git",
      [
        "grep",
        "--untracked",
        "-lw",
        "KEPT_PAGE_LIMIT",
        "--",
        "*.ts",
        "*.tsx",
        ":!*.test.ts",
        ":!e2e",
      ],
      { cwd: WEB_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  return files
    .filter((file) =>
      /(?<![A-Za-z0-9_])KEPT_PAGE_LIMIT(?![A-Za-z0-9_])/.test(
        stripComments(readFileSync(join(WEB_ROOT, file), "utf8")),
      ),
    )
    .sort();
}

test("AC1 guard: only surfaces with no plan in scope use KEPT_PAGE_LIMIT", () => {
  assert.deepEqual(
    keptPageLimitUsers(),
    Object.keys(KEPT_PAGE_LIMIT_ALLOWED).sort(),
    "A file started or stopped using KEPT_PAGE_LIMIT. If it decides a cap or speaks to a " +
      "signed-in account, read `limitsFor(plan).keptPages` (or the `KeptQuota` the server " +
      "computed) instead. If it genuinely has no plan in scope, add it to " +
      "KEPT_PAGE_LIMIT_ALLOWED with the reason.",
  );
});
