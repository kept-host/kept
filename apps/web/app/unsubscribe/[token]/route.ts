/**
 * `/unsubscribe/{token}` — stop the draft-reminder email for one page.
 *
 * Two verbs, one effect:
 *   - POST is RFC 8058 one-click, paired with the `List-Unsubscribe` and
 *     `List-Unsubscribe-Post` headers `lib/email/draft-reminder.ts` sets. The
 *     mail client posts it; the reader never has to trust a link in an email in
 *     order to stop the email.
 *   - GET is the human clicking the link, and answers with a page rather than
 *     JSON.
 *
 * WHAT IT ACTUALLY DOES is clear `sites.reminder_email` — the identical state
 * E04's result screen already produces when somebody empties the field and
 * saves, so this introduces no new "unsubscribed" flag to keep in sync. The
 * emailed keep token is revoked in the same write.
 *
 * ONE ANSWER FOR EVERY TOKEN, matched or not: a distinguishable response would
 * turn this URL into a probe for whether a page exists, which is the property
 * `lib/publish/anon-token.ts` protects everywhere else.
 */
import { clearReminderByKeepTokenHash } from "../../../lib/db/queries/reminders";
import { hashToken } from "@kept/shared";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a column. Never cacheable. */
export const dynamic = "force-dynamic";

/**
 * Deliberately unstyled and self-contained. It is a terminal confirmation a
 * reader sees once, from their mail client, with no session and no navigation
 * back into the app — so it carries no design tokens, no theme and no hardcoded
 * colour, and reuses nothing from the themed app shell.
 */
const CONFIRMATION = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Reminders off — kept</title>
</head>
<body>
<h1>Reminders off</h1>
<p>We won't email you about this page again. It is unchanged and still online.</p>
</body>
</html>
`;

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The token is a path segment; a referrer would hand it to anything this page
  // ever links to. It links to nothing today — keep it that way regardless.
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

async function unsubscribe(token: string): Promise<void> {
  // Same structural reject as the anon resolver: 32 random bytes in unpadded
  // base64url, so anything outside that shape cannot be a token and must not
  // reach Postgres.
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return;
  await clearReminderByKeepTokenHash(await hashToken(token));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  await unsubscribe((await params).token);
  return new Response(CONFIRMATION, { status: 200, headers: HTML_HEADERS });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  await unsubscribe((await params).token);
  // RFC 8058: the mail client wants a success status, not a document.
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
