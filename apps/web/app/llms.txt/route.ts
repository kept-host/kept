/** `GET /llms.txt` — how an agent publishes to kept (E09 D12). */
import { llmsTxt } from "@kept/shared";

import { agentBase, discoveryResponse } from "@/lib/agents/discovery";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return discoveryResponse(llmsTxt(agentBase()), "text/plain; charset=utf-8");
}
