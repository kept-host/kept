/**
 * Downloads (D13) — one page and the streamed export. E06 task 008, PRD
 * acceptance criteria **39** and **40**, edge case 18.
 *
 * NO MOCKS: real dev Postgres and R2. Every call goes through
 * `downloadOwnedSite` / `exportOwnPages` — the exact functions the two GET
 * `route.ts` files delegate to — and reads the `Response` they return.
 *
 * ── AC40, AND HOW MEMORY IS MEASURED ─────────────────────────────────────────
 * `EXPORT_PAGES` (≥ 50) real pages are seeded: a `sites` row, a
 * `site_versions` row and an R2 object of `PAGE_BYTES` each, plus an archived
 * and a removed page the export must leave out. The export stream is consumed
 * chunk by chunk and written straight to a file on disk (the TEST's file, so it
 * holds nothing in memory either), and the zip is then checked by an
 * independent implementation — Info-ZIP's `unzip`: integrity (`-t`, CRCs), the
 * entry list, `kept-export.json`, and every page's bytes against R2.
 *
 * Memory: `v8.setFlagsFromString("--expose-gc")` makes `gc()` callable without
 * a command-line flag (`global.gc` is used when the run already has it). Before
 * the first chunk and after every MiB of zip, the test forces a full GC and
 * reads `process.memoryUsage()`, counting `heapUsed + arrayBuffers` —
 * `arrayBuffers` because streamed bytes live in `Uint8Array`s outside the V8
 * heap, where a heap-only reading could not see them buffering. The assertion
 * is that the peak rise over the baseline stays under `MEMORY_BOUND`, a fixed
 * number several times smaller than the bytes exported: had the export held
 * its pages (or the zip) in memory, the rise would grow with the page count and
 * pass the bound well before the last page.
 *
 * SKIPS without dev credentials or without an `unzip` binary. Every row and
 * object created here is removed in `after`.
 */
import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, studioErrorSchema } from "@kept/shared";
import { config } from "dotenv";

import { hasUnzip, unzip } from "../testing/unzip";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;
const skipZip: string | false =
  skip || (hasUnzip() ? false : "no `unzip` binary to check the archive with an independent reader");

/** AC40's "≥ 50 pages". */
const EXPORT_PAGES = 60;
/** Each seeded page's size — 60 × 256 KiB ≈ 15 MiB exported. */
const PAGE_BYTES = 256 * 1024;
/** The peak memory rise allowed while streaming — a fraction of what is exported. */
const MEMORY_BOUND = 4 * 1024 * 1024;
const SAMPLE_EVERY_BYTES = 1024 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdKeys = new Set<string>();

/** Lazy: the stores read env the moment they are used, after `config` above. */
async function deps() {
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db");
  const { profiles, siteVersions, sites, user } = await import("../db/schema");
  const { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } = await import("../storage/r2");
  const owner = await import("./owner-routes");
  return {
    eq,
    inArray,
    db,
    profiles,
    siteVersions,
    sites,
    user,
    PAGE_CONTENT_TYPE,
    pageObjectKey,
    r2Store,
    ...owner,
  };
}

async function makeOwner(): Promise<string> {
  const { db, profiles, user } = await deps();
  const id = crypto.randomUUID();
  const email = `e06-008-ex-${id.slice(0, 8)}@kept-e06-008.invalid`;
  await db.insert(user).values({ id, name: "E06-008 export drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdUsers.add(id);
  return id;
}

/** A page document of exactly `bytes` bytes, unique to `marker`. */
function pageOf(marker: string, bytes: number): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1><p>`;
  const tail = "</p></body></html>\n";
  return head + "k".repeat(bytes - head.length - tail.length) + tail;
}

type SiteStatusValue = "live" | "under_review" | "quarantined" | "expired" | "archived" | "removed";

interface Seeded {
  siteId: string;
  slug: string;
  title: string;
  html: string;
  objectKey: string;
}

/**
 * Real pages, without the edge: a `sites` row, its `site_versions` row and the
 * R2 object a download reads. No manifest is written — downloads never read KV.
 */
async function seed(
  ownerId: string,
  n: number,
  options: { status?: SiteStatusValue; draft?: boolean; purgeAfter?: Date | null; bytes?: number } = {},
): Promise<Seeded[]> {
  const { db, siteVersions, sites, PAGE_CONTENT_TYPE, pageObjectKey, r2Store } = await deps();
  const now = Date.now();
  const pages = Array.from({ length: n }, (_, i) => {
    const siteId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const slug = `e06-008-ex-${siteId.slice(0, 8)}`;
    const title = `Export drill ${i} ${siteId.slice(0, 4)}`;
    const html = pageOf(title, options.bytes ?? 512);
    createdSites.add(siteId);
    const objectKey = pageObjectKey(siteId, versionId);
    createdKeys.add(objectKey);
    const expiresAt = options.draft ? new Date(now + DRAFT_TTL_DAYS * MS_PER_DAY) : null;
    return {
      seeded: { siteId, slug, title, html, objectKey },
      site: {
        id: siteId,
        slug,
        status: options.status ?? ("live" as const),
        region: "auto" as const,
        ownerId,
        publisherHash: "e06-008-export-drill",
        currentVersionId: versionId,
        title,
        expiresAt,
        purgeAfter:
          options.purgeAfter !== undefined
            ? options.purgeAfter
            : expiresAt
              ? new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY)
              : null,
        claimedAt: new Date(now),
        contentHash: `e06-008-${siteId}`,
        sizeBytes: Buffer.byteLength(html),
        // Distinct, ordered creation times: the export lists by `created_at`.
        createdAt: new Date(now - (n - i) * 1000),
      },
      version: {
        id: versionId,
        siteId,
        r2Key: objectKey,
        contentHash: `e06-008-${siteId}`,
        sizeBytes: Buffer.byteLength(html),
      },
    };
  });
  if (pages.length === 0) return [];
  await db.insert(sites).values(pages.map((p) => p.site));
  await db.insert(siteVersions).values(pages.map((p) => p.version));
  const r2 = r2Store();
  for (let i = 0; i < pages.length; i += 8) {
    await Promise.all(
      pages.slice(i, i + 8).map((p) => r2.put(p.seeded.objectKey, p.seeded.html, PAGE_CONTENT_TYPE)),
    );
  }
  return pages.map((p) => p.seeded);
}

after(async () => {
  if (skip) return;
  const { db, inArray, sites, user, r2Store } = await deps();
  const { closeDb } = await import("../db");
  const r2 = r2Store();
  const keys = [...createdKeys];
  for (let i = 0; i < keys.length; i += 8) {
    await Promise.all(keys.slice(i, i + 8).map((key) => r2.delete(key).catch(() => undefined)));
  }
  // `site_versions` cascades off `sites`.
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  await closeDb();
});

// ── GET /api/sites/:id/download (AC39) ──────────────────────────────────────

test(
  "download: the owner gets the current HTML as an attachment that is never sniffed, cached or run",
  { skip },
  async () => {
    const { downloadOwnedSite, PAGE_CONTENT_TYPE } = await deps();
    const owner = await makeOwner();
    const [page] = await seed(owner, 1);

    const res = await downloadOwnedSite(page!.siteId, owner);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), PAGE_CONTENT_TYPE);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${page!.slug}.html"`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "sandbox");
    assert.equal(await res.text(), page!.html);
  },
);

test(
  "download: every status but removed, until purge_after — and the same 404 for anyone else",
  { skip },
  async () => {
    const { downloadOwnedSite } = await deps();
    const owner = await makeOwner();
    const stranger = await makeOwner();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY);

    const allowed = [
      ...(await seed(owner, 1, { status: "under_review" })),
      ...(await seed(owner, 1, { status: "quarantined" })),
      ...(await seed(owner, 1, { status: "expired", draft: true, purgeAfter: future })),
      // D14: an archived page downloads until its purge_after.
      ...(await seed(owner, 1, { status: "archived", purgeAfter: future })),
    ];
    for (const page of allowed) {
      const res = await downloadOwnedSite(page.siteId, owner);
      assert.equal(res.status, 200, page.slug);
      assert.equal(await res.text(), page.html, page.slug);
    }

    const [mine] = await seed(owner, 1);
    const refused = [
      ...(await seed(owner, 1, { status: "archived", purgeAfter: past })).map((p) => p.siteId),
      ...(await seed(owner, 1, { status: "expired", draft: true, purgeAfter: past })).map((p) => p.siteId),
      ...(await seed(owner, 1, { status: "removed" })).map((p) => p.siteId),
      crypto.randomUUID(),
      "not-a-uuid",
    ];
    const bodies = new Set<string>();
    for (const id of refused) {
      const res = await downloadOwnedSite(id, owner);
      assert.equal(res.status, 404, id);
      bodies.add(await res.text());
    }
    // Somebody else asking for a page that IS downloadable by its owner.
    const theirs = await downloadOwnedSite(mine!.siteId, stranger);
    assert.equal(theirs.status, 404);
    bodies.add(await theirs.text());

    assert.equal(bodies.size, 1, "one body for every refusal — never an existence oracle");
    assert.equal(studioErrorSchema.parse(JSON.parse([...bodies][0]!)).error.code, "not_found");
  },
);

// ── GET /api/export (AC40) ──────────────────────────────────────────────────

/** `kept-export.json`, read back out of the zip by `unzip`. */
interface ExportEntryOnDisk {
  name: string;
  title: string | null;
  status: string;
  kind: string;
  created_at: string;
  updated_at: string;
  url: string;
}

test(
  `export: ${EXPORT_PAGES} pages stream into a valid zip whose JSON lists every non-archived page, whose files match R2, with flat memory`,
  { skip: skipZip, timeout: 600_000 },
  async () => {
    const { exportOwnPages, r2Store } = await deps();
    const owner = await makeOwner();
    const pages = await seed(owner, EXPORT_PAGES, { bytes: PAGE_BYTES });
    const drafts = await seed(owner, 1, { draft: true });
    const all = [...pages, ...drafts];
    await seed(owner, 1, { status: "archived", purgeAfter: new Date(Date.now() + MS_PER_DAY) });
    await seed(owner, 1, { status: "removed" });

    v8.setFlagsFromString("--expose-gc");
    const gc = (globalThis.gc ?? vm.runInNewContext("gc")) as () => void;
    const used = () => {
      gc();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };

    const dir = await mkdtemp(join(tmpdir(), "kept-export-"));
    const file = join(dir, "export.zip");
    try {
      const res = await exportOwnPages(owner);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/zip");
      assert.match(
        res.headers.get("content-disposition") ?? "",
        /^attachment; filename="kept-export-\d{4}-\d{2}-\d{2}\.zip"$/,
      );
      assert.ok(res.body);

      const baseline = used();
      let peak = 0;
      let total = 0;
      let sinceSample = 0;
      const handle = await open(file, "w");
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk);
          total += chunk.byteLength;
          sinceSample += chunk.byteLength;
          if (sinceSample >= SAMPLE_EVERY_BYTES) {
            sinceSample = 0;
            peak = Math.max(peak, used() - baseline);
          }
        }
      } finally {
        await handle.close();
      }
      const exported = EXPORT_PAGES * PAGE_BYTES;
      assert.ok(total > exported, `the zip carries every page (${total} bytes)`);
      assert.ok(
        peak < MEMORY_BOUND,
        `memory rose ${Math.round(peak / 1024)} KiB while streaming ${Math.round(exported / 1024)} KiB — bound ${MEMORY_BOUND / 1024} KiB`,
      );
      console.log(
        `[export drill] streamed ${Math.round(total / 1024)} KiB; peak heapUsed+arrayBuffers rise ${Math.round(peak / 1024)} KiB`,
      );

      // An independent reader: every CRC checks out.
      unzip(["-tq", file]);

      const names = unzip(["-Z1", file]).toString("utf8").trim().split("\n");
      assert.deepEqual(
        names,
        ["kept-export.json", ...all.map((p) => `${p.slug}/index.html`)],
        "the JSON first, then every non-archived page in created order — no archived, no removed",
      );

      const manifest = JSON.parse(unzip(["-p", file, "kept-export.json"]).toString("utf8")) as ExportEntryOnDisk[];
      assert.deepEqual(
        manifest.map((entry) => entry.name),
        all.map((p) => p.slug),
      );
      for (const [i, entry] of manifest.entries()) {
        assert.equal(entry.title, all[i]!.title);
        assert.equal(entry.status, "live");
        assert.equal(entry.kind, i < pages.length ? "kept" : "draft");
        assert.ok(!Number.isNaN(Date.parse(entry.created_at)));
        assert.ok(!Number.isNaN(Date.parse(entry.updated_at)));
        assert.equal(entry.url, `https://${entry.name}.${process.env.KEPT_BASE_DOMAIN}`);
      }

      const r2 = r2Store();
      for (const page of all) {
        const zipped = unzip(["-p", file, `${page.slug}/index.html`]).toString("utf8");
        assert.equal(zipped, await r2.get(page.objectKey), `${page.slug}: zipped bytes match R2`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("export: an account with no pages still gets a valid zip with an empty list", { skip: skipZip }, async () => {
  const { exportOwnPages } = await deps();
  const owner = await makeOwner();
  const dir = await mkdtemp(join(tmpdir(), "kept-export-"));
  const file = join(dir, "empty.zip");
  try {
    const res = await exportOwnPages(owner);
    assert.equal(res.status, 200);
    const handle = await open(file, "w");
    await handle.write(new Uint8Array(await res.arrayBuffer()));
    await handle.close();

    unzip(["-tq", file]);
    assert.deepEqual(unzip(["-Z1", file]).toString("utf8").trim().split("\n"), ["kept-export.json"]);
    assert.deepEqual(JSON.parse(unzip(["-p", file, "kept-export.json"]).toString("utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
