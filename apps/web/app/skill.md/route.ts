/** `GET /skill.md` — the kept skill's `SKILL.md` (E09 D2, D12). */
import { skillMarkdown } from "@kept/shared";

import { agentBase, discoveryResponse } from "@/lib/agents/discovery";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return discoveryResponse(skillMarkdown(agentBase()), "text/markdown; charset=utf-8");
}
