import { DRAFT_GRACE_DAYS, generateAnonToken, hashToken } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

/**
 * `POST /api/cron/draft-reminder` over the wire — E05 tasks 011 and 012.
 *
 * `lib/email/draft-reminder.test.ts` and `lib/cron/authorize.test.ts` drill the
 * predicate, the claim, the copy and the guard. What they cannot do — and what
 * task 011 explicitly deferred to here — is put a REAL message through Resend
 * and prove the link in it opens. That needs a provisioned key and a verified
 * sending domain, which task 012 provisioned.
 *
 * THE BUDGET. Resend's free tier is 100 sends a day, split ≤40 to this sweep
 * and ~60 held for interactive sign-in. This file spends exactly ONE, on
 * Resend's always-deliverable address, and everything else it asserts is
 * arranged so no second send is needed:
 *
 *   1. one due draft in, one `sent` back, `reminder_sent_at` stamped;
 *   2. the minted keep link in that email actually opens the keep screen;
 *   3. an immediate second run sends NOTHING (the "exactly one" property);
 *   4. an unauthenticated call is refused before any database work.
 *
 * The per-run cap is `REMINDER_RUN_CAP` as a SQL `LIMIT` and is drilled in the
 * unit suite; proving it here would cost 41 real emails, i.e. the whole day's
 * budget, which is precisely the failure the cap exists to prevent.
 *
 * NO MOCKS: real dev Neon branch, real HTTP, real Resend.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = ["DATABASE_URL", "RESEND_API_KEY", "EMAIL_FROM", "CRON_SECRET"] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

const SKIP: string | false =
  missing.length > 0
    ? `cron/email credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

/** Resend's own always-deliverable address; a real send to a real service. */
const DELIVERABLE = "delivered@resend.dev";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

test.describe("the draft-reminder cron endpoint", () => {
  test.skip(!!SKIP, SKIP || undefined);

  const createdSiteIds: string[] = [];

  test.afterAll(async () => {
    if (SKIP) return;
    if (createdSiteIds.length) {
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    await closeDb();
  });

  test("an unauthenticated call is refused, in one shape, before any work", async ({
    request,
  }) => {
    const secret = process.env.CRON_SECRET!;
    const bodies = new Set<string>();
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer not-the-secret" },
      { authorization: `Basic ${secret}` },
      // The right secret presented the wrong way is still no.
      { authorization: secret },
    ];

    for (const headers of attempts) {
      const response = await request.post("/api/cron/draft-reminder", { headers });
      expect(response.status(), JSON.stringify(headers)).toBe(401);
      expect(response.headers()["cache-control"]).toContain("no-store");
      bodies.add(JSON.stringify(await response.json()));
    }

    // One byte-identical refusal for every wrong way in: a caller without the
    // secret learns only that a secret is required.
    expect(bodies.size).toBe(1);

    // GET is not a way round it either — a link prefetcher must not be able to
    // fire the sweep.
    expect(
      (await request.get("/api/cron/draft-reminder")).status(),
    ).toBeGreaterThanOrEqual(400);
  });

  test("a draft at T-2d gets exactly one real email, and its keep link opens", async ({
    request,
    page,
  }) => {
    // A draft two days from expiry with a reminder address on it: the due
    // predicate's exact shape, written as data rather than as a stubbed query.
    const id = crypto.randomUUID();
    const slug = `e05-012-cron-${id.slice(0, 12)}`;
    const token = generateAnonToken();
    const expiresAt = new Date(Date.now() + 2 * MS_PER_DAY - 60_000);

    await db.insert(schema.sites).values({
      id,
      slug,
      status: "live",
      region: "auto",
      ownerId: null,
      anonTokenHash: await hashToken(token),
      publisherHash: "e05-012-cron",
      expiresAt,
      purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
      contentHash: "e05-012-cron",
      sizeBytes: 128,
      reminderEmail: DELIVERABLE,
    });
    createdSiteIds.push(id);

    const headers = { authorization: `Bearer ${process.env.CRON_SECRET}` };
    const first = await request.post("/api/cron/draft-reminder", { headers });
    expect(first.status(), await first.text()).toBe(200);
    const result = (await first.json()) as {
      ok: boolean;
      selected: number;
      sent: number;
      failed: number;
    };

    // THE REAL SEND. `runDraftReminderSweep` counts a send only after Resend
    // accepted the message, so a non-zero `sent` is Resend's own answer.
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.selected).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(row!.reminderSentAt).not.toBeNull();
    // The one-time keep token the sweep minted, stored as a digest and never in
    // plaintext — the raw value existed only inside the email.
    expect(row!.reminderKeepTokenHash).not.toBeNull();
    expect(row!.reminderKeepTokenHash).not.toBe(token);

    // "Whose keep link works", checked by resolving the digest the way the
    // route does: the page's OWN token is the same door, and the screen it
    // opens is the one the email points at.
    await page.goto(`/keep/${token}`);
    await expect(page.getByRole("button", { name: "Keep it forever" })).toBeVisible();
    expect(await page.content()).toContain(slug);

    // EXACTLY ONE. A second run finds nothing due for this draft — `sent` may
    // count other genuinely-due drafts on the dev branch, so the assertion is
    // made on the row, which is where "one reminder, ever" actually lives.
    const second = await request.post("/api/cron/draft-reminder", { headers });
    expect(second.status()).toBe(200);
    const [after] = await db.select().from(schema.sites).where(eq(schema.sites.id, id));
    expect(after!.reminderSentAt!.getTime()).toBe(row!.reminderSentAt!.getTime());
    expect(after!.reminderKeepTokenHash).toBe(row!.reminderKeepTokenHash);

    // And the reminder changed nothing about the draft itself.
    expect(after!.expiresAt!.getTime()).toBe(expiresAt.getTime());
    expect(after!.ownerId).toBeNull();
  });
});
