"use client";

/**
 * Agents and API keys — E09 task 006 (PRD UI Source, §8; D6).
 *
 * ⚠️ NO IMPORTED DESIGN (Q12). Built from the settings cards and tokens only;
 * flagged for Arun's review.
 *
 * Two cards. "Connect an agent": Codex · Claude Code · Cursor · Any agent, each
 * its install command with Copy, and Claude chat as a smaller fifth (Q-PRD-3;
 * no ChatGPT, D11). "API keys": the account's live keys, Create (the key is shown
 * once, in a dialog, and dropped from state when it closes) and Revoke behind a
 * confirm. The list arrives from the server component; this island keeps it in
 * step with what it creates and revokes.
 */
import {
  API_KEY_LIMIT_MESSAGE,
  API_KEYS_PER_ACCOUNT,
  apiKeyNameSchema,
  apiKeySummarySchema,
  type AgentSetup,
  type ApiKeyCreated,
  type ApiKeySummary,
} from "@kept/shared";
import { KeyRound, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { CodeBlock } from "@/components/kept/code-block";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createApiKey, revokeApiKey } from "@/lib/sites/owner-client";

import { SettingsCard } from "./settings-card";

/** The four main cards, in `/agents`' order; Claude chat follows, smaller. */
const CARD_IDS = ["codex", "claude-code", "cursor", "any"] as const;

/** `YYYY-MM-DD`, UTC — the same on the server render and in the browser. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function AgentCard({ setup, compact = false }: { setup: AgentSetup; compact?: boolean }) {
  return (
    <div
      data-testid={`agent-card-${setup.id}`}
      className="flex min-w-0 flex-col gap-2 rounded-[var(--r-md)] border border-border p-4"
    >
      <h3 className={compact ? "text-sm font-medium text-text" : "font-display text-base font-semibold text-text"}>
        {setup.name}
      </h3>
      <p className="text-[13px] leading-relaxed text-text-secondary">{setup.install.note}</p>
      {setup.install.code !== null && (
        <CodeBlock code={setup.install.code} label={`${setup.name} install command`} />
      )}
    </div>
  );
}

export function AgentsPanel({
  setups,
  agentsUrl,
  initialKeys,
}: {
  setups: readonly AgentSetup[];
  /** `/agents` on the apex, for the full per-agent setup. */
  agentsUrl: string;
  initialKeys: readonly ApiKeySummary[];
}) {
  const nameId = useId();
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>(initialKeys);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The just-created key — the only time the raw key is in this tab. */
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const cards = CARD_IDS.map((id) => setups.find((setup) => setup.id === id)).filter(
    (setup): setup is AgentSetup => setup !== undefined,
  );
  const chat = setups.find((setup) => setup.id === "claude-chat");
  const atLimit = keys.length >= API_KEYS_PER_ACCOUNT;
  const nameValid = apiKeyNameSchema.safeParse(name).success;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!nameValid || creating || atLimit) return;
    setCreating(true);
    setError(null);
    const outcome = await createApiKey(name);
    setCreating(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    // The schema strips `api_key`: the list never holds the raw key.
    const summary = apiKeySummarySchema.parse(outcome.key);
    setKeys((current) => [summary, ...current]);
    setName("");
    setCreated(outcome.key);
  }

  async function revoke() {
    if (!revoking) return;
    setRevokePending(true);
    setRevokeError(null);
    const outcome = await revokeApiKey(revoking.id);
    setRevokePending(false);
    if (!outcome.ok) {
      setRevokeError(outcome.error.message);
      return;
    }
    const gone = revoking.id;
    setKeys((current) => current.filter((key) => key.id !== gone));
    setRevoking(null);
  }

  return (
    <>
      <SettingsCard title="Connect an agent" data-testid="agents-panel">
        <p className="text-[15px] text-text-secondary">
          Install once and your agent can publish to kept. Without a key, it hands you a live
          link and a claim link; with one, pages land in this account.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((setup) => (
            <AgentCard key={setup.id} setup={setup} />
          ))}
        </div>
        {chat ? <AgentCard setup={chat} compact /> : null}
        <a href={agentsUrl} className="self-start text-sm text-accent hover:underline">
          Every agent&rsquo;s full setup →
        </a>
      </SettingsCard>

      <SettingsCard
        title="API keys"
        data-testid="api-keys-panel"
        aside={
          <span data-testid="api-keys-count" className="mono-label text-xs text-text-muted">
            {keys.length} of {API_KEYS_PER_ACCOUNT}
          </span>
        }
      >
        {keys.length === 0 ? (
          <p data-testid="api-keys-empty" className="text-[15px] text-text-secondary">
            No keys yet. Keys let your agents publish straight into your account.
          </p>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table data-testid="api-keys-table" className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Key</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Created</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Last used</th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} data-testid="api-key-row" className="border-b border-border last:border-b-0">
                    <td className="max-w-[16ch] truncate py-2 pr-3 text-text">{key.name}</td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-text-secondary">
                      {key.prefix}…
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-text-secondary">
                      {day(key.created_at)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-text-secondary">
                      {key.last_used_on ?? "Never"}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRevokeError(null);
                          setRevoking(key);
                        }}
                      >
                        Revoke<span className="sr-only"> {key.name}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {atLimit ? (
          <p data-testid="api-keys-limit" className="text-[13px] text-text-secondary">
            {API_KEY_LIMIT_MESSAGE}
          </p>
        ) : (
          <form onSubmit={(event) => void create(event)} className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-medium text-text">
              Key name
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={nameId}
                data-testid="api-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My laptop"
                maxLength={60}
                autoComplete="off"
                disabled={creating}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${nameId}-error` : undefined}
                className="h-10 min-w-0 flex-[1_1_200px] rounded-[var(--r-sm)] shadow-none"
              />
              <Button
                type="submit"
                variant="secondary"
                data-testid="api-key-create"
                disabled={!nameValid || creating}
                className="h-10 rounded-[var(--r-md)] px-4 font-body font-medium"
              >
                <KeyRound aria-hidden="true" strokeWidth={1.5} />
                {creating ? "Creating…" : "Create key"}
              </Button>
            </div>
            {error ? (
              <p id={`${nameId}-error`} role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </SettingsCard>

      <Dialog
        open={created !== null}
        onOpenChange={(next) => {
          if (!next) setCreated(null);
        }}
      >
        <DialogContent data-testid="api-key-created" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Your new key</DialogTitle>
            <DialogDescription>
              You won&rsquo;t see this again. Copy it now and keep it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          {created ? <CodeBlock code={created.api_key} label="the new key" /> : null}
          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next && !revokePending) setRevoking(null);
        }}
      >
        <DialogContent data-testid="api-key-revoke-dialog" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              Agents using this key stop publishing at once. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeError ? (
            <p role="alert" className="text-[13px] text-danger">
              {revokeError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={revokePending} onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="api-key-revoke-confirm"
              disabled={revokePending}
              onClick={() => void revoke()}
            >
              <Trash2 aria-hidden="true" strokeWidth={1.5} />
              {revokePending ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
