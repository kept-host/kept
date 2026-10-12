/**
 * Founding applications' SQL (E06a §4). They live on the `waitlist` row (D6);
 * `lib/founding/*` owns tokens, mail and answers, this module owns statements.
 */
import type { FoundingStatus } from "@kept/shared";
import { sql } from "drizzle-orm";

import { db } from "../index";

/** What the review card and the admin mail show. */
export interface FoundingApplication {
  email: string;
  socialUrl: string | null;
  note: string | null;
  foundingStatus: FoundingStatus;
}

interface ApplicationRow {
  email: string;
  social_url: string | null;
  note: string | null;
  founding_status: FoundingStatus;
  [key: string]: unknown;
}

const application = (row: ApplicationRow): FoundingApplication => ({
  email: row.email,
  socialUrl: row.social_url,
  note: row.note,
  foundingStatus: row.founding_status,
});

/**
 * Record an application on the row (creating it, source `founding`, if the
 * address is new). The details always update; the status becomes `pending`
 * unless Arun already decided, in which case it stays (AC12). Runs BEFORE the
 * double opt-in upsert, which then treats a new row as "pending, never sent".
 *
 * `confirmed` is true when the address is already confirmed and subscribed —
 * Arun hears about it now rather than at a confirmation that will not come.
 */
export async function upsertFoundingApplication(input: {
  email: string;
  socialUrl: string;
  note: string | null;
}): Promise<{ foundingStatus: FoundingStatus; confirmed: boolean }> {
  const [row] = await db.execute<{ founding_status: FoundingStatus; confirmed: boolean }>(sql`
    insert into waitlist (email, source, founding_status, social_url, note)
    values (${input.email}, 'founding', 'pending', ${input.socialUrl}, ${input.note})
    on conflict (email) do update set
      social_url = excluded.social_url,
      note = excluded.note,
      founding_status = coalesce(waitlist.founding_status, 'pending')
    returning founding_status, (confirmed_at is not null and unsubscribed_at is null) as confirmed
  `);
  return { foundingStatus: row!.founding_status, confirmed: row!.confirmed };
}

/** The application `email` made, or `null` when the address never applied (or is gone). */
export async function foundingApplication(email: string): Promise<FoundingApplication | null> {
  const [row] = await db.execute<ApplicationRow>(sql`
    select email, social_url, note, founding_status
    from waitlist
    where email = ${email} and founding_status is not null
  `);
  return row ? application(row) : null;
}

/**
 * Arun's decision. `changed` when the status moved (then `afterChange` ran,
 * inside the same transaction — if it throws, the decision rolls back so a
 * retry can send the mail again), `unchanged` when it already was `status`
 * (idempotent: nothing runs), `missing` when there is no application.
 */
export async function decideFounding(
  email: string,
  status: Exclude<FoundingStatus, "pending">,
  afterChange: (decided: FoundingApplication) => Promise<void>,
): Promise<"changed" | "unchanged" | "missing"> {
  return db.transaction(async (tx) => {
    const [updated] = await tx.execute<ApplicationRow>(sql`
      update waitlist
      set founding_status = ${status}, founding_decided_at = now()
      where email = ${email} and founding_status is not null and founding_status <> ${status}
      returning email, social_url, note, founding_status
    `);
    if (updated) {
      await afterChange(application(updated));
      return "changed";
    }
    const [exists] = await tx.execute(
      sql`select 1 from waitlist where email = ${email} and founding_status is not null`,
    );
    return exists ? "unchanged" : "missing";
  });
}

/**
 * `admin:founding add` (task 009): approve an address outright. No
 * `confirmed_at` (they gave no marketing consent) and no mail. An earlier
 * approval keeps its decision time.
 */
export async function upsertApprovedFounding(
  email: string,
  socialUrl: string,
  note?: string,
): Promise<void> {
  await db.execute(sql`
    insert into waitlist (email, source, founding_status, social_url, note, founding_decided_at)
    values (${email}, 'admin', 'approved', ${socialUrl}, ${note ?? null}, now())
    on conflict (email) do update set
      social_url = excluded.social_url,
      note = excluded.note,
      founding_decided_at = case
        when waitlist.founding_status = 'approved' then waitlist.founding_decided_at
        else now()
      end,
      founding_status = 'approved'
  `);
}
