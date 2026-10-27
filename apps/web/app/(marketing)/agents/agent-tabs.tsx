"use client";

import type { AgentSetup, AgentSetupStep } from "@kept/shared";

import { CopyButton } from "@/components/kept/live-url";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * `/agents`' code block: JetBrains Mono on the sunken surface, with a Copy
 * button whose accessible name says what it copies.
 */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-sunken p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text">
        {code}
      </pre>
      <CopyButton
        text={code}
        label={
          <>
            Copy<span className="sr-only"> {label}</span>
          </>
        }
        size="sm"
        variant="secondary"
        className="shrink-0"
      />
    </div>
  );
}

function Step({
  index,
  title,
  step,
  agent,
}: {
  index: number;
  title: string;
  step: AgentSetupStep;
  agent: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 font-display text-base font-semibold text-text">
        <span className="mono-label text-xs text-text-muted">{index}</span>
        {title}
      </h3>
      <p className="text-sm text-text-secondary">{step.note}</p>
      {step.code !== null && <CodeBlock code={step.code} label={`${agent}: ${title}`} />}
    </section>
  );
}

/** One tab per agent, in `agentSetups`' order (Claude chat last, Q-PRD-3). */
export function AgentTabs({ setups }: { setups: readonly AgentSetup[] }) {
  return (
    <Tabs defaultValue={setups[0]?.id} className="gap-6">
      <TabsList className="h-auto w-full flex-wrap justify-start">
        {setups.map((setup) => (
          <TabsTrigger key={setup.id} value={setup.id}>
            {setup.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {setups.map((setup) => (
        <TabsContent
          key={setup.id}
          value={setup.id}
          className="flex flex-col gap-6 rounded-md border border-border bg-surface p-5"
        >
          <Step index={1} title="Install" step={setup.install} agent={setup.name} />
          <Step index={2} title="Or use MCP" step={setup.mcp} agent={setup.name} />
          <Step index={3} title="Use your account" step={setup.account} agent={setup.name} />
          <Step
            index={4}
            title="Try it"
            step={{ note: "Ask your agent:", code: setup.testPrompt }}
            agent={setup.name}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
