"use client";

/**
 * Connected providers, and the manual link — E06 task 012, inheriting the scope
 * **E05 decision D2 explicitly handed here**.
 *
 * ── WHY THIS SCREEN HAD TO EXIST BEFORE LINKING MADE SENSE ───────────────────
 * D2 refuses to join two identities on an unverified provider email, and E05's
 * sign-in copy promises the user a way out: *"Sign in the way you did the first
 * time; you can link this provider from settings once you are in."* This is that
 * settings. Being **signed in** is the proof of ownership the email string could
 * not give, which is why `accountLinking.allowDifferentEmails` is `true` for
 * `linkSocial` and stays irrelevant to sign-in.
 *
 * ⚠️ THIS UI DOES NOT WIDEN THE POLICY, AND CANNOT. Every decision is Better
 * Auth's, server-side, using the config in `lib/auth/index.ts`:
 * `trustedProviders` is empty, so the link happens **iff the provider asserts
 * the address verified** — `unable_to_link_account` is that refusal arriving,
 * and the copy below names it honestly instead of printing "something went
 * wrong". There is no client flag here that could relax it.
 *
 * ── THE LIST COMES FROM THE `account` TABLE ──────────────────────────────────
 * `getLinkedProviders()` reads Better Auth's `account` rows in the server
 * component and passes them down. There is no `github_handle` column, there
 * never will be, and this component holds no cached copy of the set — after a
 * link or an unlink it asks the server tree again (`router.refresh()`), because
 * the row is the truth and this screen's memory of it is not.
 *
 * ── EMAIL IS A DOOR AND IS SHOWN AS ONE ──────────────────────────────────────
 * A magic-link account has **zero** `account` rows: the plugin signs a user in
 * against a one-time token and creates no credential row. Showing only OAuth
 * would tell such a user they have no way in at all. So email is rendered as the
 * first route, always available, never linkable and never removable — which is
 * also true.
 *
 * ── UNLINKING REFUSES TO LEAVE AN ACCOUNT WITH NO DOOR ───────────────────────
 * Better Auth refuses to delete the last `account` row
 * (`FAILED_TO_UNLINK_LAST_ACCOUNT`), and this UI mirrors that rule rather than
 * inventing its own: with one linked provider the remove control is disabled and
 * says why. The server is still the authority — the refusal is handled below for
 * the tab that was left open while the other one unlinked something.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Unlink } from "lucide-react";

import {
  AUTH_PROVIDERS,
  ProviderButton,
  type AuthProviderRoute,
} from "@/components/kept/provider-button";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

/** One `account` row, serialised by the server component. */
export interface LinkedProviderView {
  providerId: string;
  accountId: string;
  /** ISO. Rendered as a date only — the hour a link was made helps nobody. */
  linkedAt: string;
}

/**
 * Why a link did not happen, in words, keyed by Better Auth's own code.
 *
 * Keys are lowercased before lookup, matching `app/auth/sign-in-form.tsx`: OAuth
 * codes arrive snake-cased and plugin codes upper-cased, in the same query
 * parameter. `email_doesn't_match` keeps its apostrophe because that is the
 * literal Better Auth emits.
 */
const LINK_ERROR_COPY: Record<string, string> = {
  /**
   * D2's refusal, arriving. `trustedProviders` is empty, so this is what the
   * server says when the provider did not assert the address verified — the one
   * message on this screen that must never be softened into a generic failure,
   * because the recovery is specific and the user can actually perform it.
   */
  unable_to_link_account:
    "That provider did not confirm an email address for the account you just used, and an unconfirmed address is not proof of who you are — so we did not connect it. Verify your address with that provider, then try again. Nothing about your kept account changed.",
  /**
   * The provider identity is already somebody else's kept account. Deliberately
   * does not confirm whose, or that the other account is yours.
   */
  account_already_linked_to_different_user:
    "That provider account is already connected to a different kept account. An identity can only belong to one account at a time — sign in to that one and remove the connection there first, or use a different provider account.",
  "email_doesn't_match":
    "The address that provider gave us is not the address on this account, and this account is not set up to accept a different one. Nothing changed.",
  unable_to_get_user_info:
    "That provider signed you in but told us nothing about the account, so there was nothing to connect. Nothing changed — try again.",
  access_denied:
    "The connection was cancelled before it finished — either consent was declined or the window closed early. Nothing changed, and nothing was shared with us.",
  /** `linkSocial` never got as far as a redirect. */
  provider_unreachable:
    "kept could not start the hand-off, so you were never sent anywhere and nothing was shared. Try again in a moment.",
  /** `unlinkAccount`, from a tab that was open while the other one unlinked. */
  failed_to_unlink_last_account:
    "That is the only provider connected to this account, so removing it would leave you with one way in. Connect another provider first, then remove this one.",
  account_not_found:
    "That connection is already gone — it may have been removed in another tab. Reload to see the current list.",
};

const GENERIC_LINK_ERROR =
  "That did not work. Nothing about your account changed — the pages you have are exactly where they were.";

function linkErrorCopy(code: string): string {
  return LINK_ERROR_COPY[code.toLowerCase()] ?? GENERIC_LINK_ERROR;
}

/** Better Auth's provider ids, mapped to the routes E05 already draws. */
function routeFor(providerId: string): AuthProviderRoute | undefined {
  return AUTH_PROVIDERS.find((route) => route.id === providerId);
}

function linkedOn(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function LinkProviders({
  email,
  emailVerified,
  linked,
  justLinked,
  initialErrorCode,
}: {
  email: string;
  emailVerified: boolean;
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
  const [announcement, setAnnouncement] = useState("");

  // A successful round trip lands on `/settings?linked=github`. The server tree
  // it arrived with already lists the new row, so this only announces it and
  // takes the parameter back out of the URL — a reload of a stale `?linked=`
  // would otherwise re-announce a link made an hour ago.
  useEffect(() => {
    if (!justLinked) return;
    const route = routeFor(justLinked);
    setAnnouncement(`${route?.name ?? justLinked} is connected to this account.`);
    router.replace("/settings");
  }, [justLinked, router]);

  const linkedIds = new Set(linked.map((row) => row.providerId));

  async function link(route: AuthProviderRoute) {
    if (busy) return;
    setBusy(route.id);
    setError(null);
    // `await`-and-check is not enough — the client returns `{ error }` for an
    // HTTP failure but THROWS for a transport one, which unhandled would leave
    // this row on "Connecting…" for ever. Same guard as the sign-in screen.
    const { error: failure } = await authClient
      .linkSocial({
        provider: route.id,
        // Relative, and validated by Better Auth against its trusted origins.
        callbackURL: `/settings?linked=${route.id}`,
        // Bounce refusals back here rather than onto Better Auth's own
        // `/api/auth/error` page; the code arrives as `?error=`.
        errorCallbackURL: "/settings",
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));

    // On success the redirect has already been set on `window.location`; this
    // row stays in its pending state while that navigation runs.
    if (failure) {
      setBusy(null);
      setError(linkErrorCopy("provider_unreachable"));
    }
  }

  async function unlink(row: LinkedProviderView) {
    if (busy) return;
    setBusy(row.providerId);
    setError(null);

    const { error: failure } = await authClient
      .unlinkAccount({
        providerId: row.providerId,
        // The specific identity, not "whatever GitHub row you find" — an account
        // may hold more than one row for a provider.
        accountId: row.accountId,
      })
      .catch((cause: unknown) => ({ error: cause ?? new Error("unreachable") }));
    setBusy(null);

    if (failure) {
      const code =
        typeof failure === "object" && failure !== null && "code" in failure
          ? String((failure as { code?: unknown }).code ?? "")
          : "";
      setError(code ? linkErrorCopy(code) : GENERIC_LINK_ERROR);
      return;
    }

    const route = routeFor(row.providerId);
    setAnnouncement(`${route?.name ?? row.providerId} is no longer connected.`);
    // The `account` row is the truth; this screen's copy of the list is not.
    router.refresh();
  }

  return (
    <section className="rounded-[var(--r-lg)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-4">
        <h2 className="font-display text-xl font-semibold text-text">Account</h2>
        <p className="mono-label text-[11px] text-text-muted">How you sign in</p>
      </div>

      {/* ── Email: the address, and the door it is ──────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="mono-label text-[10px] text-text-muted">Email</p>
          <p className="mt-1 break-all font-display text-base font-semibold text-text">
            {email}
          </p>
        </div>
        <span
          className={`mono-label inline-flex items-center gap-2 rounded-[var(--r-pill)] border px-3 py-1 text-[10px] ${
            emailVerified
              ? "border-border bg-surface text-text-secondary"
              : "border-warning bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-warning"
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${emailVerified ? "bg-live" : "bg-warning"}`}
          />
          {emailVerified ? "Confirmed" : "Not confirmed"}
        </span>
      </div>

      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
        {emailVerified
          ? "A magic link to this address always signs you in, whatever else is connected below. It is also where draft reminders go."
          : "This address has not been confirmed yet. Sign in once with a magic link sent to it and it becomes a confirmed way in — and a valid account to connect a provider to."}
      </p>

      {/* ── The providers ──────────────────────────────────────────────────── */}
      <div className="mt-7 border-t border-border pt-5">
        <h3 className="font-display text-base font-semibold text-text">
          Connected providers
        </h3>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
          Connect a provider and it becomes another way into this same account —
          same pages, same links, nothing moves. We only connect one whose email
          address the provider itself confirms; an unconfirmed address is not
          proof of who you are.
        </p>

        <ul className="mt-5 flex flex-col gap-3">
          {AUTH_PROVIDERS.map((route) => {
            const row = linked.find((candidate) => candidate.providerId === route.id);
            const lastDoor = row !== undefined && linked.length === 1;

            return (
              <li
                key={route.id}
                data-provider-row={route.id}
                data-connected={row ? "true" : "false"}
                className="rounded-[var(--r-md)] border border-border bg-sunken px-4 py-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="text-text [&_svg]:size-[18px]">
                      {route.icon}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{route.name}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
                        {row
                          ? `Connected ${linkedOn(row.linkedAt)}`
                          : "Not connected"}
                      </p>
                    </div>
                  </div>

                  {row ? (
                    <div className="flex items-center gap-3">
                      <span className="mono-label inline-flex items-center gap-1.5 text-[10px] text-live">
                        <Check aria-hidden="true" className="size-3.5" />
                        Connected
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid={`unlink-${route.id}`}
                        disabled={busy !== null || lastDoor}
                        onClick={() => void unlink(row)}
                        className="text-text-secondary hover:text-text"
                      >
                        <Unlink aria-hidden="true" />
                        {busy === route.id ? "Removing…" : "Remove"}
                        <span className="sr-only"> {route.name}</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="w-full sm:w-auto sm:min-w-[16rem]">
                      <ProviderButton
                        route={{ ...route, label: `Connect ${route.name}` }}
                        disabled={busy !== null}
                        onSelect={(selected) => void link(selected)}
                      />
                    </div>
                  )}
                </div>

                {/* The one honest reason a remove control is disabled. Rendered
                    as text rather than a tooltip: a disabled control's
                    explanation has to reach somebody who cannot hover it. */}
                {lastDoor ? (
                  <p className="mt-3 text-xs leading-relaxed text-text-muted">
                    This is the only provider connected, so it cannot be removed —
                    connect another one first. Magic links to {email} keep working
                    either way.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        {busy !== null && linkedIds.has(busy) === false ? (
          <p role="status" className="mt-4 text-xs leading-relaxed text-text-muted">
            Sending you to {routeFor(busy)?.name ?? busy} to approve the
            connection. You will come right back.
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            data-testid="link-error"
            className="mt-4 max-w-[62ch] text-xs leading-relaxed text-danger"
          >
            {error}
          </p>
        ) : null}

        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </div>
    </section>
  );
}
