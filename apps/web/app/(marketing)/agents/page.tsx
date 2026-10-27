import { agentPrompt, agentSetups } from "@kept/shared";
import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/kept/code-block";
import { LegalLinks } from "@/components/kept/legal-links";
import { agentBase } from "@/lib/agents/discovery";
import { agentsMetadata } from "@/lib/og/preview";

import { AgentTabs } from "./agent-tabs";

/**
 * `/agents` (apex, public, open and closed alike) — how to let an agent publish
 * to kept, one tab per agent (E09 PRD §5.5). Every string comes from
 * `@kept/shared`'s agent copy (D12). No imported design (Q12): built from the
 * marketing pages' layout and tokens; flagged for Arun's review.
 *
 * Per request, because the URLs come from `NEXT_PUBLIC_APP_URL`, which a build
 * without app env (CI) does not have.
 */
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return agentsMetadata();
}

export default function AgentsPage() {
  const base = agentBase();

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">For agents</p>
        <h1 className="font-display text-3xl font-semibold text-text">
          Let your agent publish.
        </h1>
        <p className="text-text-secondary">
          Codex, Claude Code, Cursor or any agent can put a page on kept and hand you two
          links: the live link, and a claim link to keep it. No account, no key.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold text-text">Paste this into any agent</h2>
        <CodeBlock code={agentPrompt(base)} label="the prompt" />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold text-text">Set up your agent</h2>
        <AgentTabs setups={agentSetups(base)} />
      </section>

      <p className="text-sm text-text-secondary">
        Agents reading this site: start at{" "}
        <a href="/llms.txt" className="text-accent underline">
          /llms.txt
        </a>{" "}
        or{" "}
        <a href="/skill.md" className="text-accent underline">
          /skill.md
        </a>
        .
      </p>

      <footer className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Link href="/" className="mono-label text-xs text-accent hover:underline">
          ← Back to kept
        </Link>
        <LegalLinks />
      </footer>
    </main>
  );
}
