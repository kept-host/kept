/**
 * The account's plan, named — PRD §3 item 3 / §5.8. `Founding` arrives with
 * E11; until then `profiles.plan` is `free | premium`, shown as Free / Pro.
 * Better Auth has no opinion about plans, so the label mapping lives here, once:
 * the studio's plan pill and the publish copy (`lib/publish/fileset/copy.ts`)
 * both read it.
 */
import type { Plan } from "@kept/shared";

export const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  premium: "Pro",
};
