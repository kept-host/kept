/** `GET /.well-known/skills/index.json` — the Hermes skills index (E09 D2). */
import { skillsIndex } from "@kept/shared";

import { agentBase, discoveryResponse } from "@/lib/agents/discovery";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return discoveryResponse(JSON.stringify(skillsIndex(agentBase())), "application/json");
}
