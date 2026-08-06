/**
 * GitHub's verified-primary-email lookup — the mechanism behind E05 decision D2.
 *
 * D2: *the provider's own verification signal, read at the callback, is the only
 * thing that authorises a link.* For GitHub that signal is `GET /user/emails`
 * (`user:email` scope), NOT the `email` field on `GET /user`. The two are
 * different values with different guarantees:
 *
 *   - `GET /user` returns the account's PUBLIC PROFILE email. It is a display
 *     field. Treating it as a linking key is a direct account-takeover path onto
 *     another user's kept pages — an attacker sets it to `victim@example.com`,
 *     signs in, and naive email-matching hands them the victim's account.
 *   - `GET /user/emails` returns every address on the account with an explicit
 *     `verified` flag. Only `verified: true` proves GitHub itself saw the human
 *     answer that address.
 *
 * Better Auth's stock GitHub provider prefers the profile email and only falls
 * back to the primary one, so `getUserInfo` is overridden with this module
 * rather than configured around it.
 *
 * WHEN GITHUB PROVES NOTHING, WE INVENT NOTHING. If no address on the account is
 * verified, the identity is issued under GitHub's own per-account noreply
 * address instead. That is what turns D2's refusal into a *distinct account*
 * rather than a dead end: the noreply address is unique to one GitHub account,
 * so it can never collide with a real user's email, `user.email`'s UNIQUE
 * constraint is satisfied, and Better Auth creates a fresh `user` row with its
 * own (empty) page list instead of erroring out at the callback.
 */

/** The subset of `GET /user` this module reads. */
export type GithubProfileLike = {
  id: string | number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

/** One row of `GET /user/emails`. */
export type GithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
};

export type GithubIdentity = {
  email: string;
  /**
   * `true` only when GitHub reported THIS address verified. Better Auth's
   * account-linking gate reads exactly this field, so a `false` here is the
   * refusal: no implicit link, no session on the existing account.
   */
  emailVerified: boolean;
};

/**
 * GitHub's own placeholder for "this account has no address I will vouch for".
 * `{id}+{login}@users.noreply.github.com` is the form GitHub itself mints for
 * commit authorship, it is unique per account, and it is not deliverable to a
 * third party — so it cannot be used to reach anyone else's account.
 */
export function githubNoreplyEmail(profile: GithubProfileLike): string {
  return `${profile.id}+${profile.login}@users.noreply.github.com`;
}

/**
 * Choose the address GitHub is willing to stand behind.
 *
 * Order: the verified PRIMARY address, then any other verified address, then —
 * only if GitHub verified nothing — the noreply placeholder with
 * `emailVerified: false`.
 *
 * The profile email is deliberately never consulted. Not as a fallback, not as
 * a tiebreak: an address GitHub did not mark verified carries no more weight for
 * being the one on the public profile.
 */
export function selectGithubIdentity(
  profile: GithubProfileLike,
  emails: GithubEmail[] | null | undefined,
): GithubIdentity {
  const verified = (emails ?? []).filter((entry) => entry.verified && entry.email);
  const chosen = verified.find((entry) => entry.primary) ?? verified[0];
  return chosen
    ? { email: chosen.email, emailVerified: true }
    : { email: githubNoreplyEmail(profile), emailVerified: false };
}

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  // GitHub rejects an API request with no User-Agent.
  "User-Agent": "kept-control-plane",
};

/**
 * The callback-time lookup: profile + verified addresses, resolved into the one
 * identity Better Auth is allowed to link on.
 *
 * Returns `null` when `GET /user` fails — Better Auth turns that into a failed
 * sign-in, which is the correct outcome for "we could not establish who this
 * is". A failure of `GET /user/emails` alone is NOT fatal and is NOT retried
 * into the profile email: it simply means nothing is verified, so the sign-in
 * lands on the noreply identity and a distinct account, exactly as an account
 * with no verified address does.
 */
export async function fetchGithubIdentity(accessToken: string): Promise<{
  profile: GithubProfileLike & Record<string, unknown>;
  identity: GithubIdentity;
} | null> {
  const headers = { ...GITHUB_API_HEADERS, Authorization: `Bearer ${accessToken}` };

  const profile = await getJson<GithubProfileLike & Record<string, unknown>>(
    "https://api.github.com/user",
    headers,
  );
  if (!profile?.login || profile.id === undefined || profile.id === null) return null;

  const emails = await getJson<GithubEmail[]>(
    "https://api.github.com/user/emails",
    headers,
  );

  return {
    profile,
    identity: selectGithubIdentity(profile, Array.isArray(emails) ? emails : null),
  };
}

/** One GitHub GET, JSON or `null`. A transport error is a non-answer, not a throw. */
async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
