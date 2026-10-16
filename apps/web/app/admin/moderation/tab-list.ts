/** The moderation screen's tabs, in order (E07 §6.11). Shared by the server page and the client tab bar. */
export const MODERATION_TABS = [
  { value: "queue", label: "Queue" },
  { value: "reports", label: "Reports" },
  { value: "appeals", label: "Appeals" },
  { value: "watch", label: "Watch" },
  { value: "log", label: "Log" },
  { value: "scanner", label: "Scanner" },
] as const;
export type ModerationTab = (typeof MODERATION_TABS)[number]["value"];

/** `?tab=` → a tab; anything else is the Queue. */
export function parseTab(raw: string | string[] | undefined): ModerationTab {
  return MODERATION_TABS.find((tab) => tab.value === raw)?.value ?? "queue";
}

/** `?page=` → a page number from 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const page = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}
