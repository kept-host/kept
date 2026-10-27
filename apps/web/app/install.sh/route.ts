/** `GET /install.sh` — the no-npm skill installer (E09 D2; Q-PRD-2: no MCP config). */
import { installScript } from "@kept/shared";

import { agentBase, discoveryResponse } from "@/lib/agents/discovery";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return discoveryResponse(installScript(agentBase()), "text/x-shellscript; charset=utf-8");
}
