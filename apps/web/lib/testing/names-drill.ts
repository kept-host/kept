/**
 * Real rows for the names drills (`lib/names/*.test.ts`) — E06 task 006.
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob in `apps/web/package.json`, so it never runs as a suite of its
 * own. NO MOCKS — every helper writes real `user` / `profiles` / `sites` /
 * `name_holds` / `name_events` rows on the dev Neon branch, and `cleanup()`
 * deletes every one of them. Store writes (KV manifests) are the calling drill's
 * to unwind, because only it knows which names it published.
 */
import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, type NameKind, type Plan, type SiteStatus } from "@kept/shared";
import { validateName } from "@kept/shared/names";
import { eq, inArray, or } from "drizzle-orm";

import { db } from "../db";
import { nameEvents, nameHolds, profiles, sites, user } from "../db/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DrillSite {
  id: string;
  slug: string;
}

export interface DrillSiteOptions {
  ownerId: string;
  /** Defaults to a fresh valid name. */
  slug?: string;
  nameKind?: NameKind;
  /** `true` (default): no clock. `false`: an owned draft. */
  kept?: boolean;
  status?: SiteStatus;
}

/** One drill's rows, tracked from creation so teardown can find all of them. */
export class NamesDrill {
  private readonly siteIds = new Set<string>();
  private readonly profileIds = new Set<string>();
  private readonly names = new Set<string>();

  constructor(private readonly prefix: string) {}

  /**
   * A name `validateName` accepts on every plan, unique to this run. Tracked,
   * so a hold the code under test writes for it is torn down too.
   */
  name(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = `${this.prefix}-${crypto.randomUUID().slice(0, 8)}`;
      if (validateName(candidate, "free") === "ok") {
        this.names.add(candidate);
        return candidate;
      }
    }
    throw new Error("Could not draw a valid drill name.");
  }

  /** Track names the drill did not draw (reserved probes, minted candidates). */
  track(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }

  /** A new account on `plan`. */
  async profile(plan: Plan = "free"): Promise<string> {
    const id = crypto.randomUUID();
    const email = `${this.prefix}-${id}@kept.invalid`;
    await db.insert(user).values({ id, name: `${this.prefix} drill`, email, emailVerified: true });
    await db.insert(profiles).values({ id, email, plan });
    this.profileIds.add(id);
    return id;
  }

  private row(options: DrillSiteOptions) {
    const id = crypto.randomUUID();
    const slug = options.slug ?? this.name();
    this.siteIds.add(id);
    this.names.add(slug);
    const kept = options.kept ?? true;
    const expiresAt = kept ? null : new Date(Date.now() + DRAFT_TTL_DAYS * MS_PER_DAY);
    return {
      id,
      slug,
      status: options.status ?? "live",
      region: "auto" as const,
      // A real-looking version id: a rename writes a manifest that names it.
      currentVersionId: crypto.randomUUID(),
      ownerId: options.ownerId,
      publisherHash: `${this.prefix}-drill`,
      expiresAt,
      purgeAfter: expiresAt ? new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY) : null,
      claimedAt: new Date(),
      nameKind: options.nameKind ?? "generated",
      contentHash: `${this.prefix}-${id}`,
      sizeBytes: 128,
    };
  }

  /** One owned page — kept and `live` with a generated name unless told otherwise. */
  async site(options: DrillSiteOptions): Promise<DrillSite> {
    const row = this.row(options);
    await db.insert(sites).values(row);
    return { id: row.id, slug: row.slug };
  }

  /** `n` owned pages in ONE insert — for filling a quota. */
  async sites(n: number, options: DrillSiteOptions): Promise<DrillSite[]> {
    const rows = Array.from({ length: n }, () => this.row(options));
    if (rows.length > 0) await db.insert(sites).values(rows);
    return rows.map(({ id, slug }) => ({ id, slug }));
  }

  /** A hold, written directly — for states no E06 path produces (an expired hold). */
  async hold(name: string, userId: string | null, heldUntil: Date): Promise<void> {
    this.names.add(name);
    await db.insert(nameHolds).values({ name, userId, reason: "renamed", heldUntil });
  }

  /** `n` renames by `userId`, stamped `at` — the D6 counter's input. */
  async renames(userId: string, siteId: string, n: number, at = new Date()): Promise<void> {
    const rows = Array.from({ length: n }, (_, i) => ({
      userId,
      siteId,
      oldName: `${this.prefix}-old-${i}`,
      newName: `${this.prefix}-new-${i}`,
      createdAt: at,
    }));
    await db.insert(nameEvents).values(rows);
  }

  async read(siteId: string) {
    const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
    if (!row) throw new Error(`Drill row ${siteId} vanished.`);
    return row;
  }

  async holdOf(name: string) {
    const [row] = await db.select().from(nameHolds).where(eq(nameHolds.name, name));
    return row ?? null;
  }

  async cleanup(): Promise<void> {
    const siteIds = [...this.siteIds];
    const profileIds = [...this.profileIds];
    const names = [...this.names];
    if (siteIds.length > 0 || profileIds.length > 0) {
      const byOwner = [
        ...(siteIds.length > 0 ? [inArray(nameEvents.siteId, siteIds)] : []),
        ...(profileIds.length > 0 ? [inArray(nameEvents.userId, profileIds)] : []),
      ];
      await db.delete(nameEvents).where(or(...byOwner));
    }
    if (names.length > 0) await db.delete(nameHolds).where(inArray(nameHolds.name, names));
    if (siteIds.length > 0) await db.delete(sites).where(inArray(sites.id, siteIds));
    if (profileIds.length > 0) {
      // `profiles.id` → `user.id` cascades, so deleting the user does both.
      await db.delete(user).where(inArray(user.id, profileIds));
    }
  }
}
