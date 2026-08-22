/**
 * Which providers is this account signed in with? — E06 task 012.
 *
 * ⚠️ THE ANSWER LIVES IN BETTER AUTH'S `account` TABLE AND NOWHERE ELSE. There
 * is no `github_handle`, no `google_handle` and no `provider` column on
 * `profiles`, and `lib/db/schema.ts` carries a standing note saying so — E05
 * task 006 barred them explicitly. A denormalised copy would need backfilling on
 * every link and would silently rot the first time somebody unlinked, so the
 * settings screen would confidently show a provider the user had removed. One
 * row per linked identity, keyed `(userId, providerId, accountId)`, read live.
 *
 * ⚠️ NO TOKENS LEAVE THIS FUNCTION. The `account` row also holds
 * `access_token`, `refresh_token` and `id_token`; the select below names four
 * columns and none of them is a credential. The result is serialised into an
 * RSC payload and shipped to a browser, so a `select()` with no projection here
 * would put a provider access token in the page source.
 *
 * A READ IN A SERVER COMPONENT, not a JSON route. "Which providers am I linked
 * to" is page data for one screen; adding a `GET /api/account/providers` would
 * be a second way to ask it, gated separately.
 */
import { asc, eq } from "drizzle-orm";

import { db } from "../index";
import { account } from "../schema";

/**
 * One linked provider identity, as the settings screen needs it.
 *
 * `providerId` is Better Auth's own string (`"github"`, `"google"`) rather than
 * a kept enum: it is the value the `account` row stores and the value
 * `unlinkAccount` takes back, and mapping it through a local enum would only
 * create a place for the two vocabularies to disagree.
 */
export interface LinkedProvider {
  providerId: string;
  /** The provider's own id for the user. Needed to unlink a specific identity. */
  accountId: string;
  /** When the link was made, for the "connected since" line. */
  linkedAt: Date;
}

/**
 * Every provider identity attached to a user, oldest first.
 *
 * Oldest first so the door somebody signed up through stays at the top of the
 * list as they add more, which is also the order that makes "this is the one you
 * started with" legible without labelling it.
 *
 * ⚠️ AN EMPTY RESULT IS NORMAL, NOT AN ERROR. A magic-link-only account has zero
 * `account` rows — the plugin signs a user in against a one-time token and
 * creates no credential row — so "no linked providers" means "email is the only
 * door", which is exactly what the screen says.
 */
export async function getLinkedProviders(userId: string): Promise<LinkedProvider[]> {
  return db
    .select({
      providerId: account.providerId,
      accountId: account.accountId,
      linkedAt: account.createdAt,
    })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(asc(account.createdAt));
}
