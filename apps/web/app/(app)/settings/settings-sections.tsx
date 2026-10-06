"use client";

/**
 * The settings screen's section nav and the one section it shows — E06 task
 * 013, from `kept Settings Screen.dc.html` (`sections` / `section` state).
 *
 * The design's six sections are cut to the four the PRD scopes for E06 (§5.8):
 * Account, Plan, Your data and Danger zone. Handle (E10), Own domain (E11) and
 * Referrals (E10) are left out of the tree — no "Soon" pill, no disabled entry
 * (AC10). "Your data" is not in the design, which puts the export inside its
 * danger section; the PRD makes it a section of its own, so it gets a nav entry
 * here in the same language.
 *
 * Like the design, one section is mounted at a time. The section bodies are
 * rendered by the server component and passed in, so every read stays in RSC
 * and this island owns nothing but which one is showing.
 *
 * Desktop: a 200px column beside the content, sticky. Phone: a row across the
 * top that scrolls sideways if it has to.
 */
import { useState } from "react";

import { cn } from "@/lib/utils";

export interface SettingsSection {
  id: string;
  label: string;
  content: React.ReactNode;
}

export function SettingsSections({ sections }: { sections: readonly SettingsSection[] }) {
  const [current, setCurrent] = useState(sections[0]?.id);
  const shown = sections.find((section) => section.id === current) ?? sections[0];

  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
      <nav
        aria-label="Settings sections"
        className="flex shrink-0 basis-full gap-0.5 overflow-x-auto md:sticky md:top-8 md:basis-[200px] md:flex-col"
      >
        {sections.map((section) => {
          const on = section.id === shown?.id;
          return (
            <button
              key={section.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setCurrent(section.id)}
              className={cn(
                "flex h-10 shrink-0 items-center whitespace-nowrap rounded-[var(--r-sm)] px-3 text-left font-body text-[15px] font-medium outline-none hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-accent",
                on ? "bg-sunken text-text" : "text-text-secondary",
              )}
            >
              {section.label}
            </button>
          );
        })}
      </nav>

      <div
        data-testid={`settings-section-${shown?.id}`}
        className="flex min-w-0 flex-[1_1_480px] flex-col gap-4"
      >
        {shown?.content}
      </div>
    </div>
  );
}
