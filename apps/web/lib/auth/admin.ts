/**
 * Who may use the moderation screen and its API (E07 D12, §6.11, AC20): a
 * signed-in user whose address passes `isAdminEmail`. Everyone else — signed
 * out, signed in as anyone else — gets the SAME 404 an unknown path gets, never
 * a 403 or a sign-in redirect: the screen's existence is not advertised.
 */
import { isAdminEmail } from "./closed-sign-in";
import { getSession, sessionFor, type AppSession } from "./session";

function adminOnly(session: AppSession | null): AppSession | null {
  return session !== null && isAdminEmail(session.user.email) ? session : null;
}

/** The admin's session in a server component, or `null`. */
export async function getAdminSession(): Promise<AppSession | null> {
  return adminOnly(await getSession());
}

/** The same answer for a route handler's request. */
export async function adminSessionFor(request: Request): Promise<AppSession | null> {
  return adminOnly(await sessionFor(request.headers));
}
