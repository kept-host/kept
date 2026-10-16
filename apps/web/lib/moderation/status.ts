/**
 * `setStatus` — THE ONLY WRITER OF MODERATION STATUS EDGES AND OF
 * `sites.moderation_reason` (E07 §6.7). The scanner, the report fast path, the
 * admin screen and appeal decisions all come through here; owner and lifecycle
 * edges (archive, expire, keep) stay where they are.
 *
 * Every change, in order:
 *
 *   PG tx: lockOwner (owned) → lock the site row → check the transition table
 *          → write status + reason (+ clocks) → D19 name hold / unhold
 *          → grant the open appeal (restore) → moderation_actions row
 *   commit → syncManifest(siteId)          (its own transaction, D18)
 *          → statement of reasons          (owner email or reminder_email)
 *          → admin alert                   (scanner and report actors only)
 *
 * The action row is written INSIDE the transaction rather than after the sync:
 * it is the statement-of-reasons record, and a crash between the commit and a
 * separate insert would leave a status change nobody can account for.
 *
 * Nothing after the commit throws: a failed sync leaves its `pending_purges`
 * row (the repurge job converges the edge), and a failed mail is logged and
 * reported in the result. The row is the authority.
 *
 * ── D4, BY CONSTRUCTION ─────────────────────────────────────────────────────
 * The scanner's only edge is `live → under_review`, and only while the version
 * it scanned is still current (edge case 3: replaced while scanning). Any other
 * call by `scanner` is refused before anything is written — the guarantee does
 * not depend on the caller.
 */
import {
  type ModerationAction,
  type ModerationActor,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";

import { db, type Tx } from "../db";
import {
  adminRestored,
  grantOpenAppeal,
  insertModerationAction,
  latestDoneScan,
  lockSiteForModeration,
  readSiteOwner,
  slugClaimedByAnother,
  statementRecipient,
  writeModerationStatus,
  type ModeratedSite,
} from "../db/queries/moderation";
import { isSlugCollision } from "../db/queries/publish";
import { sendAdminAlert, type AdminAlertOutcome } from "../email/admin-alert";
import {
  buildStatementOfReasons,
  moderationAlert,
  sendModerationEmail,
  type ModeratedStatus,
  type ModerationEmail,
} from "../email/moderation";
import { lockNames } from "../names/availability";
import { dropRemovedHold, holdName } from "../names/holds";
import { draftClocks, graceEnds, liveUrl } from "../publish/pipeline";
import { lockOwner } from "../sites/keep";
import { appOrigin } from "../storage/env";
import { syncManifest, type SyncManifestResult } from "../storage/manifest";

interface Transition {
  from: readonly SiteStatus[];
  to: ModeratedStatus;
  actors: readonly ModerationActor[];
  /** When set, the edge is open to these reasons only. */
  reasons?: readonly ModerationReason[];
}

/**
 * THE TRANSITION TABLE (§6.7), as data. Anything not listed is refused.
 * "Any non-purged → removed": every status a row can still have, except
 * `removed` itself.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: ["live"], to: "under_review", actors: ["scanner", "admin"] },
  { from: ["live", "under_review"], to: "quarantined", actors: ["admin"] },
  {
    from: ["live", "under_review"],
    to: "quarantined",
    actors: ["report"],
    reasons: ["child_sexual_abuse"],
  },
  {
    from: ["live", "under_review", "quarantined", "expired", "archived"],
    to: "removed",
    actors: ["admin"],
  },
  { from: ["under_review", "quarantined", "removed"], to: "live", actors: ["admin"] },
];

export function isAllowedTransition(
  from: SiteStatus,
  to: ModeratedStatus,
  actor: ModerationActor,
  reason: ModerationReason | undefined,
): boolean {
  return TRANSITIONS.some(
    (t) =>
      t.to === to &&
      t.from.includes(from) &&
      t.actors.includes(actor) &&
      (t.reasons === undefined || (reason !== undefined && t.reasons.includes(reason))),
  );
}

const ACTION_FOR: Record<ModeratedStatus, ModerationAction> = {
  under_review: "flag",
  quarantined: "hide",
  removed: "remove",
  live: "restore",
};

interface CommonOptions {
  /** Required for every restriction; a restore records what it is restored from. */
  reason?: ModerationReason;
  automated: boolean;
  note?: string;
  scanId?: string;
  reportId?: string;
  /** A restore that grants this appeal (it must still be open). */
  appealId?: string;
  actorUserId?: string;
}

export type SetStatusOptions =
  | (CommonOptions & {
      actor: "scanner";
      /** The version the scan judged — re-checked against `current_version_id` under the lock. */
      versionId: string;
    })
  | (CommonOptions & { actor: "report" | "admin"; versionId?: undefined });

export type SetStatusRefusal =
  | "not_found"
  | "not_allowed"
  | "reason_required"
  | "not_current_version"
  | "admin_restored"
  | "slug_taken"
  | "appeal_not_open";

/** Admin-facing (011 shows them); never sent to an owner. */
const REFUSAL_MESSAGES: Record<SetStatusRefusal, string> = {
  not_found: "No such page.",
  not_allowed: "That status change is not allowed from the page's current status, for this actor.",
  reason_required: "A restriction needs a reason.",
  not_current_version: "The scanned version is no longer the page's current version; nothing changed.",
  admin_restored: "An admin restored this version; the scanner does not flag it again.",
  slug_taken:
    "Another page has taken this page's name since it was removed, so it cannot be restored under it.",
  appeal_not_open: "That appeal is not open for this page any more.",
};

/** What happened to the statement of reasons. */
export type StatementOutcome = "sent" | "no_recipient" | "failed";

export type SetStatusResult =
  | {
      ok: true;
      actionId: string;
      from: SiteStatus;
      to: ModeratedStatus;
      manifest: SyncManifestResult;
      statement: StatementOutcome;
      /** `null`: the actor is a person, so no operator alert. */
      alert: AdminAlertOutcome | null;
    }
  | { ok: false; refusal: SetStatusRefusal; message: string };

type Refused = Extract<SetStatusResult, { ok: false }>;

function refused(refusal: SetStatusRefusal): Refused {
  return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] };
}

/** The owner changed between the unlocked read and the row lock: start over. */
class OwnerChanged extends Error {}
const OWNER_RETRIES = 3;

interface Decided {
  ok: true;
  actionId: string;
  site: ModeratedSite;
  /** The reason the mail and the alert talk about. */
  reason: ModerationReason | null;
  purgeAfter: Date | null;
  appealGranted: boolean;
}

/**
 * The clocks of a page coming back (§6.7). A kept page stays kept — even at the
 * cap, which only gates new keeps (edge case 23) — and loses any `purge_after`
 * a removal set. A draft keeps its clock, or gets a fresh one if it ran out
 * while hidden (edge case 15); its `purge_after` is the grace after that clock.
 */
function restoredClocks(site: ModeratedSite, now: Date): { expiresAt?: Date; purgeAfter: Date | null } {
  if (site.expiresAt === null) return { purgeAfter: null };
  const expiresAt = site.expiresAt > now ? site.expiresAt : draftClocks(now).expiresAt;
  return { expiresAt, purgeAfter: graceEnds(expiresAt) };
}

async function decide(
  tx: Tx,
  siteId: string,
  to: ModeratedStatus,
  options: SetStatusOptions,
): Promise<Decided | Refused> {
  // Lock order: the owner's profile row first (a late keep, expiry and purge
  // take it too), then the page.
  const ownerId = await readSiteOwner(tx, siteId);
  if (ownerId === undefined) return refused("not_found");
  if (ownerId) await lockOwner(tx, ownerId);
  const site = await lockSiteForModeration(tx, siteId);
  if (!site) return refused("not_found");
  if (site.ownerId !== ownerId) throw new OwnerChanged();

  if (!isAllowedTransition(site.status, to, options.actor, options.reason)) return refused("not_allowed");
  if (options.actor === "scanner" && site.currentVersionId !== options.versionId) {
    return refused("not_current_version");
  }
  // D-72: an admin who restored this version overruled the scanner on it, so
  // no flag of it — reused, rescanned or read back by a rollback — undoes that.
  // Unconditional, P2 included: the human decision is the later, better-
  // informed one, and an admin who changes their mind hides the version, which
  // lifts this. A new version is a new key and is flagged as usual. Read under
  // the row lock, so a restore committing while a scan runs is seen here.
  if (options.actor === "scanner" && (await adminRestored(tx, site.id, options.versionId))) {
    return refused("admin_restored");
  }

  const now = new Date();
  let appealId = options.appealId ?? null;
  let purgeAfter = site.purgeAfter;

  if (to === "live") {
    // Every refusal before the first write: a refusal returns, and the
    // transaction commits whatever was already written.
    // `sites_slug_key` excludes `removed`, so coming back re-claims the name.
    // The D19 hold makes a taker impossible; refuse clearly if one exists.
    if (site.status === "removed" && (await slugClaimedByAnother(tx, site.slug, site.id))) {
      return refused("slug_taken");
    }
    // A restore answers the open appeal, whether or not it was asked from one.
    appealId = await grantOpenAppeal(tx, site.id, options.note ?? null, options.appealId);
    if (options.appealId && !appealId) return refused("appeal_not_open");
    if (site.status === "removed") await dropRemovedHold(site.slug, site.id, tx);
    const clocks = restoredClocks(site, now);
    purgeAfter = clocks.purgeAfter;
    await writeModerationStatus(tx, site.id, { status: "live", moderationReason: null, ...clocks });
  } else if (!options.reason) {
    return refused("reason_required");
  } else if (to === "removed") {
    purgeAfter = graceEnds(now);
    await writeModerationStatus(tx, site.id, { status: "removed", moderationReason: options.reason, purgeAfter });
    // D19: the name stays off the market, generated or chosen, with no owner —
    // unless another page already claims it (a removal of an archived page).
    await lockNames(tx, [site.slug]);
    if (!(await slugClaimedByAnother(tx, site.slug, site.id))) {
      await holdName(site.slug, null, "removed", site.id, tx);
    }
  } else {
    await writeModerationStatus(tx, site.id, { status: to, moderationReason: options.reason });
  }

  const reason = to === "live" ? site.moderationReason : (options.reason ?? null);
  const actionId = await insertModerationAction(tx, {
    siteId: site.id,
    slug: site.slug,
    actor: options.actor,
    actorUserId: options.actorUserId ?? null,
    action: to === "live" && options.appealId ? "appeal_granted" : ACTION_FOR[to],
    fromStatus: site.status,
    toStatus: to,
    reason,
    automated: options.automated,
    note: options.note ?? null,
    versionId: site.currentVersionId,
    scanId: options.scanId ?? null,
    reportId: options.reportId ?? null,
    appealId,
  });

  return { ok: true, actionId, site, reason, purgeAfter, appealGranted: to === "live" && appealId !== null };
}

/**
 * Mail the page's owner — the account address, else the draft's
 * `reminder_email`, else nobody (edge case 20). Never throws; logs no address.
 */
export async function mailOwner(
  site: { id: string; slug: string },
  build: (from: string, owned: boolean) => ModerationEmail,
): Promise<StatementOutcome> {
  try {
    const recipient = await statementRecipient(site.id);
    if (!recipient?.email) return "no_recipient";
    const { owned } = recipient;
    await sendModerationEmail(recipient.email, (from) => build(from, owned));
    return "sent";
  } catch (err) {
    console.error(
      `[kept] moderation mail for site ${site.id} (slug "${site.slug}") not sent — ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}

/** The statement of reasons (§6.9) for a change `decide` committed. */
function sendStatement(decided: Decided, to: ModeratedStatus, options: SetStatusOptions): Promise<StatementOutcome> {
  return mailOwner(decided.site, (from, owned) =>
    buildStatementOfReasons({
      to,
      pageUrl: liveUrl(decided.site.slug),
      siteId: decided.site.id,
      reason: decided.reason,
      actor: options.actor,
      automated: options.automated,
      note: options.note ?? null,
      appealGranted: decided.appealGranted,
      owned,
      purgeAfter: decided.purgeAfter,
      origin: appOrigin(),
      from,
    }),
  );
}

/**
 * Change a page's moderation status. Refusals are values and write nothing;
 * see the header for what a change does.
 */
export async function setStatus(
  siteId: string,
  to: ModeratedStatus,
  options: SetStatusOptions,
): Promise<SetStatusResult> {
  if (to !== "live" && !options.reason) return refused("reason_required");
  // D4: nothing but `under_review` is ever the scanner's, whatever the page.
  if (options.actor === "scanner" && to !== "under_review") return refused("not_allowed");

  let decided: Decided | Refused;
  for (let attempt = 1; ; attempt++) {
    try {
      decided = await db.transaction((tx) => decide(tx, siteId, to, options));
      break;
    } catch (err) {
      if (err instanceof OwnerChanged && attempt < OWNER_RETRIES) continue;
      if (isSlugCollision(err)) return refused("slug_taken");
      throw err;
    }
  }
  if (!decided.ok) return decided;

  const manifest = await syncManifest(siteId);
  const statement = await sendStatement(decided, to, options);
  const alert =
    options.actor === "admin"
      ? null
      : await sendAdminAlert(
          moderationAlert({
            slug: decided.site.slug,
            pageUrl: liveUrl(decided.site.slug),
            from: decided.site.status,
            to,
            actor: options.actor,
            reason: decided.reason,
            scanId: options.scanId ?? null,
            reportId: options.reportId ?? null,
            origin: appOrigin(),
          }),
        );

  return { ok: true, actionId: decided.actionId, from: decided.site.status, to, manifest, statement, alert };
}

/**
 * The verdict of a version's latest finished scan, or `null` when it has none —
 * so a restore of a version that was flagged goes straight back to
 * `under_review` (edge case 4), and the scan runtime (task 007) can ask too.
 */
export async function lastVerdictFor(versionId: string) {
  const scan = await latestDoneScan(versionId);
  return scan?.verdict ? { verdict: scan.verdict, reason: scan.reason, scanId: scan.id } : null;
}
