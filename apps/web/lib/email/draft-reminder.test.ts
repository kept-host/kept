/**
 * The draft-reminder sweep — E05 task 011's drills.
 *
 * NO MOCKS (project rule). Every assertion below runs against the real dev Neon
 * branch: real rows in `sites`, the real partial index, the real conditional
 * update. Nothing is stubbed and no fake mailer exists.
 *
 * WHAT IS DELIBERATELY NOT EXERCISED HERE: the send itself. `RESEND_API_KEY` is
 * unprovisioned and the project rule forbids substituting a mock for it, so the
 * transport is the ONE step no test below crosses. Everything up to it — the
 * due-draft predicate, the ordering, the cap, the claim/release idempotency,
 * the unsubscribe write, the composed copy — is real, which is why the module
 * is factored with `buildDraftReminderEmail` (pure) separate from
 * `runDraftReminderSweep` (does the I/O). When the credential lands, task 012
 * exercises the last step.
 *
 * THE DRILLS SKIP without `DATABASE_URL`: CI runs `pnpm test` on fork PRs with
 * no cloud secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * EVERY DB IMPORT IS DYNAMIC AND INSIDE A TEST, because `config()` below must
 * run before any module reads the environment and ESM hoists static imports
 * above it.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Every row this file creates, torn down in `after`. */
const createdSiteIds: string[] = [];

/** Every account this file creates, torn down in `after`. */
const createdUserIds: string[] = [];

/** A run marker so a failed teardown is identifiable and never collides. */
const runId = crypto.randomUUID().slice(0, 8);

type SeedOptions = {
  /** Days from `now` until the draft expires. */
  expiresInDays: number;
  reminderEmail?: string | null;
  reminderSentAt?: Date | null;
  status?: "live" | "expired" | "archived";
};

/**
 * Insert a draft directly rather than publishing one. The publish pipeline
 * writes R2 and KV, which this task does not touch and must not depend on — the
 * sweep reads Postgres and only Postgres.
 */
async function seedDraft(index: number, options: SeedOptions): Promise<string> {
  const { db } = await import("../db");
  const { sites } = await import("../db/schema");
  const now = Date.now();
  const [row] = await db
    .insert(sites)
    .values({
      slug: `e05-011-${runId}-${index}`,
      status: options.status ?? "live",
      expiresAt: new Date(now + options.expiresInDays * MS_PER_DAY),
      purgeAfter: new Date(
        now + (options.expiresInDays + DRAFT_GRACE_DAYS) * MS_PER_DAY,
      ),
      reminderEmail:
        options.reminderEmail === undefined
          ? `drill+${runId}-${index}@kept.invalid`
          : options.reminderEmail,
      reminderSentAt: options.reminderSentAt ?? null,
      anonTokenHash: `e05-011-${runId}-${index}-anon-hash`,
    })
    .returning({ id: sites.id });
  assert.ok(row, "seed insert must return the new row");
  createdSiteIds.push(row.id);
  return row.id;
}

/**
 * A real signed-up account: a Better Auth `user` row plus the `profiles` row
 * D3's create hook would have made for it. Deleting the user cascades to both.
 */
async function seedOwner(): Promise<string> {
  const { db } = await import("../db");
  const { profiles, user } = await import("../db/schema");
  const id = crypto.randomUUID();
  await db.insert(user).values({
    id,
    name: `E05-011 drill ${runId}`,
    email: `drill+${runId}-owner@kept.invalid`,
  });
  await db.insert(profiles).values({ id, email: `drill+${runId}-owner@kept.invalid` });
  createdUserIds.push(id);
  return id;
}

after(async () => {
  if (skipLive) return;
  const { db } = await import("../db");
  const { sites, user } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  if (createdSiteIds.length > 0) {
    await db.delete(sites).where(inArray(sites.id, createdSiteIds));
  }
  if (createdUserIds.length > 0) {
    // `profiles` cascades from `user`; `sites.owner_id` is already gone above.
    await db.delete(user).where(inArray(user.id, createdUserIds));
  }
  await db.$client.end();
});

describe("the due-draft predicate", { skip: skipLive }, () => {
  test("selects an anonymous live draft inside the T-2d window, and nothing else", async () => {
    const { selectDueReminders, REMINDER_LEAD_DAYS } = await import(
      "../db/queries/reminders"
    );

    const due = await seedDraft(1, { expiresInDays: REMINDER_LEAD_DAYS - 0.5 });
    const tooFarOut = await seedDraft(2, { expiresInDays: REMINDER_LEAD_DAYS + 1 });
    const alreadyExpired = await seedDraft(3, { expiresInDays: -1 });
    const noAddress = await seedDraft(4, {
      expiresInDays: REMINDER_LEAD_DAYS - 0.5,
      reminderEmail: null,
    });
    const alreadySent = await seedDraft(5, {
      expiresInDays: REMINDER_LEAD_DAYS - 0.5,
      reminderSentAt: new Date(),
    });
    const notLive = await seedDraft(6, {
      expiresInDays: REMINDER_LEAD_DAYS - 0.5,
      status: "archived",
    });

    const ids = (await selectDueReminders(new Date(), 100)).map((row) => row.id);

    assert.ok(ids.includes(due), "a draft inside the window must be selected");
    for (const [name, id] of [
      ["a draft outside the window", tooFarOut],
      ["a draft already past its clock", alreadyExpired],
      ["a draft with no reminder address", noAddress],
      ["a draft already reminded", alreadySent],
      ["a page that is not live", notLive],
    ] as const) {
      assert.ok(!ids.includes(id), `${name} must not be selected`);
    }
  });

  test("never selects an owned draft — its owner has a dashboard", async () => {
    const { db } = await import("../db");
    const { sites } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const { selectDueReminders, REMINDER_LEAD_DAYS } = await import(
      "../db/queries/reminders"
    );

    const id = await seedDraft(7, { expiresInDays: REMINDER_LEAD_DAYS - 0.5 });
    assert.ok(
      (await selectDueReminders(new Date(), 100)).some((row) => row.id === id),
      "the row must be due before ownership is attached, or the test proves nothing",
    );

    // `owner_id` is a real FK onto `profiles`, which is itself a real FK onto
    // Better Auth's `user`, so proving the owner clause needs a real pair of
    // rows — not a fabricated uuid the database would reject. They are created
    // here (task 002's uuid ids, exactly as `lib/auth/index.ts` mints them) and
    // torn down with everything else.
    const ownerId = await seedOwner();
    await db.update(sites).set({ ownerId }).where(eq(sites.id, id));
    assert.ok(
      !(await selectDueReminders(new Date(), 100)).some((row) => row.id === id),
      "an owned draft must drop out of the sweep",
    );
  });
});

describe("ordering and the run cap", { skip: skipLive }, () => {
  test("returns nearest expiry first, so the cap sacrifices the least urgent", async () => {
    const { selectDueReminders, REMINDER_LEAD_DAYS } = await import(
      "../db/queries/reminders"
    );

    const later = await seedDraft(10, { expiresInDays: REMINDER_LEAD_DAYS - 0.2 });
    const sooner = await seedDraft(11, { expiresInDays: REMINDER_LEAD_DAYS - 1.5 });

    const rows = await selectDueReminders(new Date(), 100);
    const positions = rows.map((row) => row.id);
    assert.ok(positions.indexOf(sooner) < positions.indexOf(later));

    // And with a cap of one, the urgent one is the one that survives.
    const capped = await selectDueReminders(new Date(), 1);
    assert.equal(capped.length, 1);
    assert.deepEqual(capped[0], rows[0]);
  });

  test("the cap is a number the sweep cannot exceed, budgeted against Resend's 100/day", async () => {
    const { REMINDER_RUN_CAP, selectDueReminders } = await import(
      "../db/queries/reminders"
    );
    // 40 to this sweep, ~60 held for magic-link sign-in, out of a shared 100.
    assert.equal(REMINDER_RUN_CAP, 40);
    assert.ok(REMINDER_RUN_CAP < 100, "must leave room for the auth path");

    const rows = await selectDueReminders(new Date());
    assert.ok(rows.length <= REMINDER_RUN_CAP);
  });
});

describe("one reminder maximum", { skip: skipLive }, () => {
  test("a claim is conditional: the second attempt on the same row loses", async () => {
    const { claimReminder, REMINDER_LEAD_DAYS, selectDueReminders } = await import(
      "../db/queries/reminders"
    );

    const id = await seedDraft(20, { expiresInDays: REMINDER_LEAD_DAYS - 0.5 });

    assert.equal(await claimReminder(id, new Date(), `hash-a-${runId}`), true);
    assert.equal(
      await claimReminder(id, new Date(), `hash-b-${runId}`),
      false,
      "a replayed run must claim nothing",
    );

    const rows = await selectDueReminders(new Date(), 100);
    assert.ok(
      !rows.some((row) => row.id === id),
      "a claimed row must not be selected again — this is what makes a second run send zero",
    );
  });

  test("a released claim is retried on the next run, with its token revoked", async () => {
    const { claimReminder, releaseReminder, REMINDER_LEAD_DAYS, selectDueReminders } =
      await import("../db/queries/reminders");
    const { findAnonTokenHashByReminderKeepTokenHash } = await import(
      "../db/queries/reminders"
    );

    const id = await seedDraft(21, { expiresInDays: REMINDER_LEAD_DAYS - 0.5 });
    const hash = `hash-released-${runId}`;

    assert.equal(await claimReminder(id, new Date(), hash), true);
    await releaseReminder(id);

    const rows = await selectDueReminders(new Date(), 100);
    assert.ok(
      rows.some((row) => row.id === id),
      "a send failure must leave the row eligible",
    );
    assert.equal(
      await findAnonTokenHashByReminderKeepTokenHash(hash),
      null,
      "an undelivered token must not stay live",
    );
  });
});

describe("the emailed keep token", { skip: skipLive }, () => {
  test("resolves through the one anon resolver, and unsubscribing revokes it", async () => {
    const { generateAnonToken, hashToken } = await import("@kept/shared");
    const { claimReminder, clearReminderByKeepTokenHash, REMINDER_LEAD_DAYS } =
      await import("../db/queries/reminders");
    const { findAnonTokenHashByReminderKeepTokenHash } = await import(
      "../db/queries/reminders"
    );
    const { db } = await import("../db");
    const { sites } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const id = await seedDraft(30, { expiresInDays: REMINDER_LEAD_DAYS - 0.5 });
    const token = generateAnonToken();
    const hash = await hashToken(token);
    assert.equal(await claimReminder(id, new Date(), hash), true);

    const mapped = await findAnonTokenHashByReminderKeepTokenHash(hash);
    assert.equal(
      mapped,
      `e05-011-${runId}-30-anon-hash`,
      "the reminder token must map onto the page's anon digest, so one resolver serves both",
    );

    assert.equal(await clearReminderByKeepTokenHash(hash), true);
    assert.equal(
      await findAnonTokenHashByReminderKeepTokenHash(hash),
      null,
      "unsubscribing must revoke the emailed link",
    );

    const [row] = await db
      .select({ email: sites.reminderEmail, sentAt: sites.reminderSentAt })
      .from(sites)
      .where(eq(sites.id, id));
    assert.ok(row);
    assert.equal(row.email, null, "unsubscribing clears the stored address");
    assert.ok(
      row.sentAt,
      "unsubscribing must not make the page eligible for a reminder again",
    );

    assert.equal(
      await clearReminderByKeepTokenHash(`no-such-hash-${runId}`),
      false,
      "an unknown token is answered identically, never confirmed",
    );
  });
});

describe("the reminder copy", () => {
  const message = () =>
    // Imported statically: it reads no environment and touches no store.
    import("./draft-reminder").then(({ buildDraftReminderEmail }) =>
      buildDraftReminderEmail({
        slug: "quiet-otter-1234",
        expiresAt: new Date("2026-09-01T12:00:00Z"),
        now: new Date("2026-08-30T12:00:00Z"),
        keepUrl: "https://app.example.test/keep/TOKEN",
        unsubscribeUrl: "https://app.example.test/unsubscribe/TOKEN",
        liveUrl: "https://quiet-otter-1234.kept-dev.xyz",
      }),
    );

  test("quotes every duration from @kept/shared, never a literal", async () => {
    const { text } = await message();
    assert.match(text, new RegExp(`${DRAFT_TTL_DAYS} days`));
    assert.match(text, new RegExp(`${DRAFT_GRACE_DAYS} days`));
    assert.match(text, new RegExp(`${KEPT_PAGE_LIMIT} pages`));
  });

  test("derives days-left from the row's own clock", async () => {
    const { subject } = await message();
    assert.equal(subject, "Your kept draft expires in 2 days");
  });

  test("carries an actionable keep link and a one-click unsubscribe", async () => {
    const { text, headers } = await message();
    assert.match(text, /https:\/\/app\.example\.test\/keep\/TOKEN/);
    assert.match(text, /https:\/\/app\.example\.test\/unsubscribe\/TOKEN/);
    assert.equal(
      headers["List-Unsubscribe"],
      "<https://app.example.test/unsubscribe/TOKEN>",
    );
    assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  });

  test("says the keep link is a credential, because it is", async () => {
    const { text } = await message();
    assert.match(text, /treat it like a password/i);
  });

  test("uses keep vocabulary, not claim", async () => {
    const { subject, text } = await message();
    assert.match(text, /\bKeep it forever\b/);
    assert.doesNotMatch(`${subject}\n${text}`, /\bclaim\b/i);
  });
});
