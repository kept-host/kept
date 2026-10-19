"use client";

/**
 * The moderation screen's six tabs (E07 §6.11). Radix Tabs is the behaviour and
 * a11y layer; the selected tab lives in the URL (`?tab=`), so a tab is a server
 * render of its own data, linkable and refreshable. Only the active panel is
 * mounted — the server rendered only its data.
 */
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MODERATION_TABS, type ModerationTab } from "./tab-list";

export function ModerationTabs({ active, children }: { active: ModerationTab; children: ReactNode }) {
  const router = useRouter();
  return (
    <Tabs value={active} onValueChange={(tab) => router.push(`/admin/moderation?tab=${tab}`)}>
      <TabsList className="h-auto w-full flex-wrap justify-start md:w-auto">
        {MODERATION_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} data-testid={`tab-${tab.value}`}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={active} data-testid={`panel-${active}`}>
        {children}
      </TabsContent>
    </Tabs>
  );
}
