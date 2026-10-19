/**
 * `/admin/moderation` — Arun's one screen (E07 D12, §6.11, AC20). The tab
 * comes from `?tab=` (Queue by default) and only that tab's data is read.
 * Loading is skeleton rows (the Suspense boundary, keyed so a tab switch shows
 * them again); a failed read is `./error.tsx`, inline with a retry.
 */
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getAdminSession } from "@/lib/auth/admin";

import { ADMIN_METADATA, AdminShell } from "./admin-shell";
import { TabPanel } from "./panels";
import { SkeletonRows } from "./skeleton-rows";
import { parsePage, parseTab } from "./tab-list";
import { ModerationTabs } from "./tabs";

/** Per-request and cookie-gated: never prerendered. */
export const dynamic = "force-dynamic";

export const metadata = ADMIN_METADATA;

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The gate, before anything is read or drawn (`./admin-shell.tsx`).
  if (!(await getAdminSession())) notFound();
  const params = await searchParams;
  const tab = parseTab(params.tab);
  const page = parsePage(params.page);

  return (
    <AdminShell>
      <h1 className="font-display text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-text">Moderation</h1>
      <ModerationTabs active={tab}>
        <Suspense key={`${tab}:${page}`} fallback={<SkeletonRows />}>
          <TabPanel tab={tab} page={page} />
        </Suspense>
      </ModerationTabs>
    </AdminShell>
  );
}
