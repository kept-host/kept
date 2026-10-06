"use client";

/**
 * Sign-in methods — connect and disconnect GitHub and Google, with the email
 * link shown as the door that is always there. E06 task 012 built it on the
 * scope E05 decision D2 handed here; task 013 restyled it to `kept Settings
 * Screen.dc.html` (section `account`, "Sign-in methods").
 *
 * ⚠️ THIS UI DOES NOT WIDEN THE POLICY, AND CANNOT. Every decision is Better
 * Auth's, server-side, using the config in `lib/auth/index.ts`:
 * `trustedProviders` is empty, so a link happens **iff the provider asserts the
 * address verified** — `unable_to_link_account` is that refusal arriving, and
 * the copy below names it honestly. Being signed in is the proof of ownership
 * the email string could not give, which is why `allowDifferentEmails` is `true`
 * for `linkSocial` and irrelevant to sign-in.
 *
 * ── THE LIST COMES FROM THE `account` TABLE ──────────────────────────────────
 * `getLinkedProviders()` reads Better Auth's rows in the server component. This
 * island holds no copy of the set: after an unlink it asks the server tree again
 * (`router.refresh()`), because the row is the truth.
 *
 * ── EMAIL IS A DOOR AND IS SHOWN AS ONE ──────────────────────────────────────
 * A magic-link account has **zero** `account` rows — the plugin signs in against
 * a one-time token and creates no credential row. So the email link is a row of
 * its own, always on, never linkable and never removable.
 *
 * ── THE LAST PROVIDER (AC42, edge case 20) ───────────────────────────────────
 * Better Auth refuses to delete the last `account` row: its own
 * `/unlink-account` answers `FAILED_TO_UNLINK_LAST_ACCOUNT`. That endpoint is
 * not wrapped; this client maps the code to the studio's `last_sign_in_method`
 * and its sentence, "You need at least one way to sign in." The UI mirrors the
 * rule rather than inventing its own — with one provider connected its
 * Disconnect is disabled and says why — and the mapping covers the tab that was
 * left open while another one unlinked something. (Epic Risk 11: the email link
 * is always there, so the sentence is a little stronger than the mechanism.)
 */
import { AtSign } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { StudioError } from "@kept/shared";

import { AUTH_PROVIDERS, type AuthProviderRoute } from "@/components/kept/provider-button";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { COULD_NOT_SAVE } from "@/lib/sites/owner-client";

import { SettingsCard } from "./settings-card";

/** One `account` row, serialised by the server component. */
export interface LinkedProviderView {
  providerId: string;
  accountId: string;
  /** ISO. Rendered as a date only — the hour a link was made helps nobody. */
  linkedAt: string;
}

/** Better Auth's last-account refusal, in the studio's vocabulary (PRD §5.8, §7). */
const LAST_SIGN_IN_METHOD: StudioError = {
  code: "last_sign_in_method",
  message: "You need at least one way to sign in.",
};

/**
 * Why a link did not happen, keyed by the code Better Auth's OAuth callback
 * puts in `?error=` (lowercased: OAuth codes arrive snake-cased, plugin codes
 * upper-cased). `email_doesn't_match` keeps the apostrophe Better Auth emits.
 * Anything not listed is the epic's generic sentence.
 */
const LINK_ERROR_COPY: Record<string, string> = {
  /**
   * D2's refusal. The one message here that must never be softened into a
   * generic failure: the recovery is specific and the user can perform it.
   */
  unable_to_link_account:
    "That provider did not confirm an email address for the account you just used, and an unconfirmed address is not proof of who you are — so we did not connect it. Verify your address with that provider, then try again. Nothing about your kept account changed.",
  /** Deliberately does not confirm whose account it is. */
  account_already_linked_to_different_user:
    "That provider account is already connected to a different kept account. An identity can only belong to one account at a time — sign in to that one and remove the connection there first, or use a different provider account.",
  "email_doesn't_match":
    "The address that provider gave us is not the address on this account, and this account is not set up to accept a different one. Nothing changed.",
  unable_to_get_user_info:
    "That provider signed you in but told us nothing about the account, so there was nothing to connect. Nothing changed — try again.",
  access_denied:
    "The connection was cancelled before it finished — either consent was declined or the window closed early. Nothing changed, and nothing was shared with us.",
};

function linkErrorCopy(code: string): string {
  return LINK_ERROR_COPY[code.toLowerCase()] ?? COULD_NOT_SAVE.message;
}

/** Better Auth's unlink refusal, as the studio error the screen shows. */
function unlinkError(failure: unknown): StudioError {
  const code =
    typeof failure === "object" && failure !== null && "code" in failure
      ? String((failure as { code?: unknown }).code ?? "")
      : "";
  return code.toUpperCase() === "FAILED_TO_UNLINK_LAST_ACCOUNT" ? LAST_SIGN_IN_METHOD : COULD_NOT_SAVE;
}

/** Better Auth's provider ids, mapped to the routes E05 already draws. */
function routeFor(providerId: string): AuthProviderRoute | undefined {
  return AUTH_PROVIDERS.find((route) => route.id === providerId);
}

function linkedOn(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Connected";
  return `Connected ${parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

export function LinkProviders({
  email,
  linked,
  justLinked,
  initialErrorCode,
}: {
  email: string;
  linked: LinkedProviderView[];
  /** `?linked=github` — the provider that just came back successfully. */
  justLinked: string | null;
  /** `?error=` from a bounced round trip, or `null`. */
  initialErrorCode: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    initialErrorCode ? linkErrorCopy(initialErrorCode) : null,
  );

  // A successful round trip lands on `/settings?linked=github`. The server tree
  // it arrived with already lists the new row, so this only says so and takes
  // the parameter back out of the URL — a reload of a stale `?linked=` would
  // otherwise re-announce a link made an hour ago. The toast id makes a second
  // effect run (Strict Mode) update the same toast rather than stack another.
  useEffect(() => {
    if (!justLinked) return;
    const route = routeFor(justLinked);
    toast.success(`${route?.name ?? justLinked} is connected to this account.`, {
      id: `linked-${justLinked}`,
    });
    router.replace("/settings");
  }, [justLinked, router]);

  async function link(route: AuthProviderRoute) {
    if (busy) return;
    setBusy(route.id);
    setError(null);
    // The client returns `{ error }` for an HTTP failure but THROWS for a
    // transport one, which unhandled would leave this row on "Connecting…".
    const { error: failure } = await authClient
      .linkSocial({
        provider: route.id,
        // Relative, and validated by Better Auth against its trusted origins.
        callbackURL: `/settings?linked=${route.id}`,
        // Refusals come back here as `?error=`, not to Better Auth's error page.
        errorCallbackURL: "/settings",
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));

    // On success the redirect is already under way; the row stays pending.
    if (failure) {
      setBusy(null);
      setError(COULD_NOT_SAVE.message);
    }
  }

  async function unlink(route: AuthProviderRoute, row: LinkedProviderView) {
    if (busy) return;
    setBusy(route.id);
    setError(null);

    const { error: failure } = await authClient
      .unlinkAccount({
        providerId: row.providerId,
        // The specific identity — an account may hold more than one row per provider.
        accountId: row.accountId,
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));
    setBusy(null);

    if (failure) {
      setError(unlinkError(failure).message);
      // The refusal means the list on screen is stale (another tab unlinked).
      router.refresh();
      return;
    }

    toast.success(`${route.name} is no longer connected.`);
    router.refresh();
  }

  return (
    <SettingsCard title="Sign-in methods" className="gap-1">
      <p className="mb-2 mt-1 text-sm text-text-secondary">Keep at least one connected.</p>

      {AUTH_PROVIDERS.map((route) => {
        const row = linked.find((candidate) => candidate.providerId === route.id);
        const lastDoor = row !== undefined && linked.length === 1;
        const pending = busy === route.id;

        return (
          <div
            key={route.id}
            data-provider-row={route.id}
            data-connected={row ? "true" : "false"}
            className="border-t border-border py-3"
          >
            <MethodRow
              icon={route.icon}
              label={route.name}
              detail={row ? linkedOn(row.linkedAt) : "Not connected"}
            >
              {row ? (
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={`unlink-${route.id}`}
                  disabled={busy !== null || lastDoor}
                  title={lastDoor ? "Connect another method first" : undefined}
                  onClick={() => void unlink(route, row)}
                  className="h-9 px-3.5 font-body font-medium"
                >
                  {pending ? "Disconnecting…" : "Disconnect"}
                  <span className="sr-only"> {route.name}</span>
                </Button>
              ) : (
                <Button
                  type="button"
                  data-testid={`link-${route.id}`}
                  disabled={busy !== null}
                  onClick={() => void link(route)}
                  className="h-9 px-3.5 font-body font-medium"
                >
                  {pending ? "Connecting…" : "Connect"}
                  <span className="sr-only"> {route.name}</span>
                </Button>
              )}
            </MethodRow>
            {/* A disabled control's reason has to reach somebody who cannot
                hover it, so it is text, not only the `title` — unless the
                refusal below is already saying the same sentence. */}
            {lastDoor && error !== LAST_SIGN_IN_METHOD.message ? (
              <p data-testid="last-method-note" className="mt-2 text-[13px] text-text-secondary">
                {LAST_SIGN_IN_METHOD.message}
              </p>
            ) : null}
          </div>
        );
      })}

      <div data-provider-row="email" className="border-t border-border py-3">
        <MethodRow icon={<AtSign strokeWidth={1.5} />} label="Email link" detail={email}>
          <span className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
            Always on
          </span>
        </MethodRow>
      </div>

      {error ? (
        <p role="alert" data-testid="link-error" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  );
}

/** One method: the glyph tile, the name over a mono detail line, and its control. */
function MethodRow({
  icon,
  label,
  detail,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-sunken text-text [&_svg]:size-[18px]"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-[1_1_160px] flex-col leading-[1.35]">
        <span className="text-[15px] font-medium text-text">{label}</span>
        <span className="break-all font-mono text-xs text-text-secondary">{detail}</span>
      </span>
      {children}
    </div>
  );
}
