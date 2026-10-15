/**
 * Appeals (E07 §6.10): an owner or token holder asks for a review of a
 * restricted page; Arun grants (restore, through `setStatus`) or rejects.
 *
 * A page can be appealed while it is `under_review`, `quarantined`, or
 * `removed` before its `purge_after`. One open appeal per site
 * (`appeals_site_open_key`), at most `APPEALS_PER_SITE_WINDOW` per site in a
 * rolling window — counted from the `appeals` rows themselves, so the window
 * is exact rather than epoch-aligned. Two submissions serialise on the site
 * row lock; the partial unique index is the backstop.
 *
 * The admin screen (task 011) calls `grantAppeal` / `rejectAppeal`; the two
 * routes call `submitAppeal` through `./appeal-http.ts`.
 */
import { APPEALS_PER_SITE_WINDOW, type SiteStatus } from "@kept/shared";

import { db } from "../db";
import {
  appealsSince,
  findAppeal,
  hasOpenAppeal,
  insertAppeal,
  insertModerationAction,
  lockSiteForAppeal,
  lockSiteForModeration,
  rejectOpenAppeal,
} from "../db/queries/moderation";
import { sendAdminAlert } from "../email/admin-alert";
import { appealAlert, buildAppealRejectedEmail } from "../email/moderation";
import { liveUrl } from "../publish/pipeline";
import { MS_PER_DAY, MS_PER_SECOND } from "../sites/display";
import { isPastGrace } from "../sites/keep";
import { appOrigin } from "../storage/env";

import { mailOwner, setStatus, type SetStatusResult, type StatementOutcome } from "./status";

/** The statuses a page can be appealed from (a `removed` one only before purge). */
const APPEALABLE: readonly SiteStatus[] = ["under_review", "quarantined", "removed"];

export type SubmitAppealResult =
  | { ok: true; appealId: string; createdAt: Date }
  | { ok: false; refusal: "not_found" | "not_restricted" | "appeal_open" }
  | { ok: false; refusal: "rate_limited"; retryAfterSeconds: number };

/** Postgres unique violation on the one-open-appeal index. */
function isOpenAppealCollision(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint_name === "appeals_site_open_key") return true;
    cursor = candidate.cause;
  }
  return false;
}

/**
 * Record an appeal. `submittedByUserId` is the signed-in owner — the lookup is
 * then owner-scoped in the SQL, so another account's page is `not_found` — or
 * `null` for the token holder, whose token the caller has already resolved to
 * `siteId`. `message` is already validated (`appealRequestSchema`).
 */
export async function submitAppeal(
  siteId: string,
  message: string,
  submittedByUserId: string | null,
): Promise<SubmitAppealResult> {
  let recorded;
  try {
    recorded = await db.transaction(async (tx) => {
      const site = await lockSiteForAppeal(tx, siteId, submittedByUserId);
      const now = new Date();
      // Past `purge_after` the page is the purge job's, not anybody's to act on (D13).
      if (!site || isPastGrace(site, now)) return refusal("not_found");
      if (!APPEALABLE.includes(site.status)) return refusal("not_restricted");
      if (await hasOpenAppeal(tx, site.id)) return refusal("appeal_open");

      const windowMs = APPEALS_PER_SITE_WINDOW.days * MS_PER_DAY;
      const recent = await appealsSince(tx, site.id, new Date(now.getTime() - windowMs));
      if (recent.count >= APPEALS_PER_SITE_WINDOW.limit && recent.oldest) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((recent.oldest.getTime() + windowMs - now.getTime()) / MS_PER_SECOND),
        );
        return { ok: false as const, refusal: "rate_limited" as const, retryAfterSeconds };
      }

      const appeal = await insertAppeal(tx, { siteId: site.id, submittedByUserId, message });
      return { ok: true as const, appeal, site };
    });
  } catch (err) {
    if (isOpenAppealCollision(err)) return refusal("appeal_open");
    throw err;
  }
  if (!recorded.ok) return recorded;

  const { appeal, site } = recorded;
  await sendAdminAlert(
    appealAlert({
      slug: site.slug,
      pageUrl: liveUrl(site.slug),
      status: site.status,
      reason: site.moderationReason,
      message,
      anonymous: submittedByUserId === null,
      origin: appOrigin(),
    }),
  );
  return { ok: true, appealId: appeal.id, createdAt: appeal.createdAt };
}

function refusal(refusal: "not_found" | "not_restricted" | "appeal_open") {
  return { ok: false as const, refusal };
}

/**
 * Grant an open appeal: restore the page (`setStatus` → `live`, actor admin),
 * which marks the appeal granted in the same transaction and mails the owner
 * the restore statement. Refused (nothing written) when the appeal is not open
 * or the page cannot be restored.
 */
export async function grantAppeal(
  appealId: string,
  adminUserId: string,
  note: string,
): Promise<SetStatusResult> {
  const appeal = await findAppeal(appealId);
  // Checked again under the lock, inside `setStatus`.
  if (appeal?.status !== "open") {
    return { ok: false, refusal: "appeal_not_open", message: "That appeal is not open any more." };
  }
  return setStatus(appeal.siteId, "live", {
    actor: "admin",
    automated: false,
    note,
    appealId,
    actorUserId: adminUserId,
  });
}

export type RejectAppealResult =
  | { ok: true; actionId: string; statement: StatementOutcome }
  | { ok: false; refusal: "note_required" | "appeal_not_open" };

/**
 * Reject an open appeal. The note is required — it is what the owner reads.
 * The page's status does not change; the decision is logged and mailed.
 * Lock order as `setStatus`: the site row, then the appeal.
 */
export async function rejectAppeal(
  appealId: string,
  adminUserId: string,
  note: string,
): Promise<RejectAppealResult> {
  const decisionNote = note.trim();
  if (!decisionNote) return { ok: false, refusal: "note_required" };
  const appeal = await findAppeal(appealId);
  if (!appeal) return { ok: false, refusal: "appeal_not_open" };

  const decided = await db.transaction(async (tx) => {
    const site = await lockSiteForModeration(tx, appeal.siteId);
    if (!site || !(await rejectOpenAppeal(tx, appealId, decisionNote))) return null;
    const actionId = await insertModerationAction(tx, {
      siteId: site.id,
      slug: site.slug,
      actor: "admin",
      actorUserId: adminUserId,
      action: "appeal_rejected",
      fromStatus: site.status,
      toStatus: null,
      reason: site.moderationReason,
      automated: false,
      note: decisionNote,
      scanId: null,
      reportId: null,
      appealId,
    });
    return { actionId, site };
  });
  if (!decided) return { ok: false, refusal: "appeal_not_open" };

  const { site } = decided;
  const statement = await mailOwner(site, (from) =>
    buildAppealRejectedEmail({
      pageUrl: liveUrl(site.slug),
      note: decisionNote,
      status: site.status,
      purgeAfter: site.purgeAfter,
      origin: appOrigin(),
      from,
    }),
  );
  return { ok: true, actionId: decided.actionId, statement };
}
