/**
 * Waitlist mail (E06a §3): the double opt-in confirmation, and the unsubscribe
 * link + headers every LATER waitlist mail carries (006's approval mail, the
 * launch mail).
 *
 * Same sender as the magic link (`resendConfig().from`, Arun 2026-10-11). Open
 * and click tracking are per-domain Resend settings, not send options; they are
 * checked by `pnpm --filter @kept/web resend:tracking`, never set here.
 *
 * Every link is an APEX URL built from configuration (`appOrigin()` →
 * `farewellHref`), never from a request. Nothing here logs an address or a token.
 */
import { WAITLIST_CONSENT_TEXT, WAITLIST_CONFIRM_TTL_DAYS } from "@kept/shared";
import { Resend } from "resend";

import { farewellHref } from "../routing/host-split";
import { appOrigin, resendConfig } from "../storage/env";
import { unsubscribeToken } from "../waitlist/unsubscribe";
import { emailFooter } from "./footer";
import { listUnsubscribeHeaders } from "./list-unsubscribe";

/**
 * `path` on the landing's origin — `https://kept.host/…` on prod; the one
 * origin on a single-host local deploy. From configuration only.
 */
export function apexUrl(path: string, origin: string = appOrigin()): string {
  return new URL(path, new URL(farewellHref(origin), origin)).href;
}

/** `[label](/path)` in the consent text → `label: https://apex/path` for plain text. */
function plainConsent(origin: string): string {
  return WAITLIST_CONSENT_TEXT.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, path: string) => `${label}: ${apexUrl(path, origin)}`,
  );
}

export interface ConfirmationEmail {
  subject: string;
  text: string;
}

/**
 * The confirmation itself. No marketing, no `List-Unsubscribe`: it is the one
 * mail sent before consent, and it asks for nothing but the click.
 */
export function buildConfirmationEmail({
  token,
  from,
  origin,
}: {
  token: string;
  from: string;
  origin: string;
}): ConfirmationEmail {
  const link = apexUrl(`/waitlist/confirm?t=${encodeURIComponent(token)}`, origin);
  return {
    subject: "Confirm your email for kept",
    text:
      `Confirm your email to join the kept waitlist:\n${link}\n\n` +
      `The link works for ${WAITLIST_CONFIRM_TTL_DAYS} days. By confirming you agree to this:\n` +
      `${plainConsent(origin)}\n\n` +
      `If this wasn't you, ignore this. Nothing else will arrive.\n\n` +
      emailFooter({ from, origin }).text,
  };
}

/** Send the confirmation. Throws on a Resend refusal; the caller decides. */
export async function sendConfirmationEmail(email: string, token: string): Promise<void> {
  const { apiKey, from } = resendConfig();
  const message = buildConfirmationEmail({ token, from, origin: appOrigin() });
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: email,
    subject: message.subject,
    text: message.text,
  });
  if (error) throw new Error(`${error.name} — ${error.message}`);
}

/**
 * What every waitlist mail after the confirmation carries: the visible link
 * (`/waitlist/unsubscribe?t=…`, a page) and the RFC 8058 header pair pointing
 * at the one-click endpoint (`/api/waitlist/unsubscribe?t=…`, no redirect).
 */
export function waitlistUnsubscribe(
  email: string,
  origin: string = appOrigin(),
): { url: string; headers: Record<string, string> } {
  const t = encodeURIComponent(unsubscribeToken(email));
  return {
    url: apexUrl(`/waitlist/unsubscribe?t=${t}`, origin),
    headers: listUnsubscribeHeaders(apexUrl(`/api/waitlist/unsubscribe?t=${t}`, origin)),
  };
}
