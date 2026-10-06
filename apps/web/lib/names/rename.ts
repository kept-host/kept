/**
 * Rename an owned page — `PATCH /api/sites/:id/name` (PRD §5.4). E06 task 006,
 * reworked from E06's first `lib/sites/rename.ts`, whose store ordering it keeps.
 *
 * ── ONE TRANSACTION, THEN THE OLD NAME ───────────────────────────────────────
 *
 *   lockOwner                          ← the owner's profile row: quota + 24 h count
 *   lock the page row, check it        ← kept and `live`, or refused
 *   lockNames(old, new)                ← sorted; closes the hold race (./availability.ts)
 *   re-check: rule, availability, quota, rate
 *   [held_for_you → delete that hold]
 *   UPDATE sites SET slug, name_kind = 'chosen'
 *   INSERT name_events
 *   [old name chosen → holdName(old, 'renamed')]
 *   writeManifest(new)                 ← pointer → KV → purge
 *   COMMIT
 *   removeManifest(old)                ← pointer → KV → purge
 *
 * **New first, old second, never the reverse** (`docs/edge-purge-contract.md`,
 * the rename event). New-first's transient state is "both names resolve" —
 * harmless and self-healing. Old-first's is "neither resolves", an outage on a
 * page somebody may have linked to.
 *
 * **The UPDATE runs before `writeManifest`, inside the transaction,** because
 * `sites_slug_key` answers "is it free" for active pages only by refusing the
 * UPDATE, and `writeManifest` overwrites whatever manifest sits at a key: a
 * manifest written before the index had spoken would briefly serve this page at
 * a stranger's name, and the unwind would take theirs dark. The uncommitted
 * UPDATE reserves the name without publishing it. A refusal or a failed
 * manifest write rolls the WHOLE transaction back — slug, event and hold — so a
 * refused rename leaves no row, no pointer, no KV key and no purge behind.
 *
 * ⚠️ A RENAME IS FOUR PURGES, TWO OF THEM DELAYED 125 s (`writeManifest` and
 * `removeManifest` each own theirs). That is the cost; do not optimise it away.
 *
 * ⚠️ R2 PAGE OBJECTS ARE UNTOUCHED. They are keyed by `siteId`, never by name.
 *
 * ⚠️ A CRASH BETWEEN COMMIT AND `removeManifest(old)` LEAVES A STALE ALIAS: the
 * old name still resolves to the same page. Not an outage and not a takeover —
 * the old name is held (or was generated, which nobody can choose by accident).
 * E07 owns the divergence audit; there is deliberately no sweep here.
 */
import type {
  NameCheckResult,
  NameCheckStatus,
  Region,
  SiteStatus,
  StudioErrorCode,
  StudioSite,
} from "@kept/shared";
import { and, eq } from "drizzle-orm";

import { db, type Tx } from "../db";
import { isSlugCollision } from "../db/queries/publish";
import { nameEvents, nameHolds, sites } from "../db/schema";
import { lockOwner, SiteNotFoundError } from "../sites/keep";
import { StudioRefusal } from "../sites/studio-refusal";
import { readStudioSite } from "../sites/studio-site";
import { servingBaseDomain } from "../storage/env";
import { removeManifest, writeManifest } from "../storage/manifest";

import { claimsItsName, lockNames } from "./availability";
import { nameRuleVerdict, namespaceVerdict } from "./check";
import { holdName } from "./holds";
import { nameStatusMessage } from "./messages";

/** Every check status that refuses a rename, and the studio code it answers with. */
const REFUSAL_CODE = {
  invalid: "name_invalid",
  too_short: "name_too_short",
  pro_length: "name_pro_length",
  reserved: "name_reserved",
  inappropriate: "name_inappropriate",
  taken: "name_taken",
  quota: "name_quota",
  rate_limited: "rename_rate_limited",
} as const satisfies Record<Exclude<NameCheckStatus, "available" | "held_for_you">, StudioErrorCode>;

/** A check result that refuses the rename — every status but the two that allow it. */
type RefusedVerdict = NameCheckResult & { status: keyof typeof REFUSAL_CODE };

function isRefused(verdict: NameCheckResult): verdict is RefusedVerdict {
  return verdict.status in REFUSAL_CODE;
}

/**
 * The name may not go on this page. The sentence is the field's own
 * (`nameStatusMessage`), so the save says exactly what the check said.
 */
class NameRefusal extends StudioRefusal {
  constructor(verdict: RefusedVerdict, name: string) {
    super(
      REFUSAL_CODE[verdict.status],
      nameStatusMessage(verdict, name, `.${servingBaseDomain()}`),
    );
    this.name = "NameRefusal";
  }
}

/** Throw the refusal `verdict` is, if it is one. */
function assertAllowed(verdict: NameCheckResult | null, name: string): void {
  if (verdict && isRefused(verdict)) throw new NameRefusal(verdict, name);
}

/**
 * The page is not one whose name may change: a draft (chosen names are for kept
 * pages only, D3 — AC17), or a page that is not `live`.
 *
 * `quarantined` and `under_review` are read-only on purpose: moving a flagged
 * page to a fresh URL is precisely the evasion the flag exists to stop.
 */
class SiteNotRenamableError extends StudioRefusal {
  constructor(state: SiteStatus | "draft") {
    super("not_allowed_in_status", explainState(state));
    this.name = "SiteNotRenamableError";
  }
}

function explainState(state: SiteStatus | "draft"): string {
  switch (state) {
    case "draft":
      return "Only kept pages can have a chosen name. Keep this page first, then rename it.";
    case "quarantined":
    case "under_review":
      return "This page is under review, so its address is locked while that is resolved. Everything else about it still works.";
    default:
      return "This page cannot be renamed right now.";
  }
}

/**
 * The new manifest could not be written. The transaction rolled back, so
 * nothing changed and "retry" is the truth; the failed step is the log's.
 */
class RenameStoreError extends StudioRefusal {
  constructor(detail: string) {
    super(
      "internal_error",
      "kept could not move this page to the new address just now. Nothing changed — the page is still live at its current one. Try again in a moment.",
      `The rename could not be published to the edge: ${detail}`,
    );
    this.name = "RenameStoreError";
  }
}

/** What the Postgres half did — and what the store half needs to finish it. */
export interface AppliedRename {
  /** The page as it now reads inside the transaction. */
  site: StudioSite;
  /** The name it left, or `null` for the no-op (renamed to the name it has). */
  previousSlug: string | null;
  versionId: string;
  region: Region;
}

/**
 * THE POSTGRES HALF of a rename, inside the caller's transaction: every lock,
 * every re-check and every row write — no store call. `renameSite` composes it
 * with the manifest writes; the race drill drives it directly to hold a
 * transaction open at the exact point a concurrent rename must wait.
 *
 * @throws {SiteNotFoundError} not this account's page, or archived / removed
 * @throws {SiteNotRenamableError} a draft, or not `live`
 * @throws {NameRefusal} the name rule, the namespace, the quota or the 24 h limit
 */
export async function applyRename(
  tx: Tx,
  siteId: string,
  userId: string,
  newName: string,
): Promise<AppliedRename> {
  const plan = await lockOwner(tx, userId);

  const [site] = await tx
    .select({
      slug: sites.slug,
      status: sites.status,
      expiresAt: sites.expiresAt,
      nameKind: sites.nameKind,
      region: sites.region,
      currentVersionId: sites.currentVersionId,
    })
    .from(sites)
    .where(
      and(
        eq(sites.id, siteId),
        eq(sites.ownerId, userId),
        claimsItsName(),
      ),
    )
    .for("update");

  if (!site) throw new SiteNotFoundError(siteId);
  if (site.expiresAt !== null) throw new SiteNotRenamableError("draft");
  if (site.status !== "live") throw new SiteNotRenamableError(site.status);
  if (!site.currentVersionId) {
    // A `live` row with no version cannot be expressed as a manifest
    // (`kvManifestSchema.versionId` is required). Every publish sets it.
    throw new Error(`Site ${siteId} is live with no current version; its manifest cannot be rewritten.`);
  }

  const unchanged = {
    versionId: site.currentVersionId,
    region: site.region,
  };

  // The name it already has: a no-op success — no event, no hold, no purge.
  if (newName === site.slug) {
    return { site: await readStudioSite(tx, siteId), previousSlug: null, ...unchanged };
  }

  // The pure rule first, so a junk name takes no lock.
  assertAllowed(nameRuleVerdict(newName, plan), newName);

  await lockNames(tx, [site.slug, newName]);
  const verdict = await namespaceVerdict(tx, {
    name: newName,
    userId,
    plan,
    nameKind: site.nameKind,
  });
  assertAllowed(verdict, newName);

  // Taking a name back (edge cases 5, 6): the hold is spent.
  if (verdict.status === "held_for_you") {
    await tx.delete(nameHolds).where(eq(nameHolds.name, newName));
  }

  try {
    await tx
      .update(sites)
      .set({ slug: newName, nameKind: "chosen" })
      .where(eq(sites.id, siteId));
  } catch (err) {
    // The index is still the final arbiter for active names — a minted page can
    // land on a name in the instant between the check and this write.
    if (isSlugCollision(err)) throw new NameRefusal({ status: "taken" }, newName);
    throw err;
  }

  await tx.insert(nameEvents).values({ userId, siteId, oldName: site.slug, newName });

  if (site.nameKind === "chosen") {
    await holdName(site.slug, userId, "renamed", siteId, tx);
  }

  return { site: await readStudioSite(tx, siteId), previousSlug: site.slug, ...unchanged };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Move a kept page to a name its owner chose. Returns the page as it now is.
 *
 * @throws everything `applyRename` throws
 * @throws {RenameStoreError} the new manifest could not be written; nothing changed
 */
export async function renameSite(
  siteId: string,
  userId: string,
  newName: string,
): Promise<StudioSite> {
  const applied = await db.transaction(async (tx) => {
    const result = await applyRename(tx, siteId, userId, newName);
    if (result.previousSlug === null) return result;

    const written = await writeManifest(result.site.slug, {
      siteId,
      versionId: result.versionId,
      // `live` by `applyRename`'s guard. The clock lives in Postgres, never here.
      status: "live",
      region: result.region,
      ownerId: userId,
      updatedAt: Date.now(),
    });

    if (!written.ok) {
      // `kv` means the POINTER landed and must come back out; `validate` and
      // `pointer` mean nothing reached a store. Safe: the new name is reserved by
      // this uncommitted UPDATE, so no other page can own what is deleted here.
      if (written.step === "kv") {
        const unwound = await removeManifest(result.site.slug);
        if (!unwound.ok) {
          console.error(
            `[kept] rename: ROLLBACK INCOMPLETE — name "${result.site.slug}" kept a pointer after a failed manifest write (${unwound.step}: ${unwound.error}). The row is rolled back, so a pointer may resolve a name no row claims. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
          );
        }
      }
      // Throwing rolls back the slug, the event and the hold together.
      throw new RenameStoreError(`${written.step}: ${written.error}`);
    }
    return result;
  });

  // COMMITTED. From here a failure costs nothing but a stale alias.
  const { site, previousSlug } = applied;
  if (previousSlug !== null) {
    try {
      const removed = await removeManifest(previousSlug);
      if (!removed.ok) {
        console.error(
          `[kept] rename: site ${siteId} moved to "${site.slug}" but the old name "${previousSlug}" failed to unpublish at the "${removed.step}" step — ${removed.error}. Both names resolve to the same page; the rename itself succeeded. Replay this removal (contract §3).`,
        );
      }
    } catch (err) {
      console.error(
        `[kept] rename: site ${siteId} moved to "${site.slug}" but removing the old name "${previousSlug}" threw — ${message(err)}. Both names resolve to the same page; the rename itself succeeded.`,
      );
    }
  }
  return site;
}
