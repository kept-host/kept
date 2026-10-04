/**
 * The short Pro list — PRD §5.8, E06 task 010.
 *
 * What a free account is shown Pro adds, one `LockedRow` per line
 * (`components/kept/locked-row.tsx`, D15). One list, read by every screen that
 * shows it, so the settings Plan panel and the page detail screen cannot drift
 * into two descriptions of the same plan.
 *
 * ⚠️ NO TYPED LIMIT. Every number is `limitsFor("premium")` (D1): the day E11
 * moves a Pro limit, this list moves with it. No prices — E11 owns those.
 */
import { limitsFor } from "@kept/shared";

const pro = limitsFor("premium");

export const PRO_LIST: readonly string[] = [
  "Wall editor",
  "Share kit",
  `${pro.keptPages.toLocaleString("en-US")} kept pages`,
  `${pro.chosenNames} names`,
  `${pro.nameMinLength}-letter names`,
  "Minimal badge",
  `${pro.previousVersions} versions of every page`,
];
