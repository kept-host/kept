/**
 * The RFC 8058 one-click unsubscribe header pair (E06a §3) that every kept mail
 * except the waitlist confirmation carries. Mail clients POST `url` themselves
 * with the body `List-Unsubscribe=One-Click`, so the reader never has to trust a
 * link in an email to stop the email.
 *
 * Pure. `url` must be an absolute https URL that accepts that POST without a
 * redirect: `/unsubscribe/{token}` for draft reminders, `/api/waitlist/unsubscribe`
 * for the waitlist (`lib/email/waitlist.ts`).
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
