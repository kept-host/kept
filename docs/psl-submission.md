# Public Suffix List submission

**Status: prepared, not filed.** kept files this request after launch, once it
serves thousands of users (decision D16 / D-60). It is not a launch blocker.
This page holds everything needed to file it: the entry, the rationale, the DNS
proof and the checks to run first.

## 1. Why kept wants the listing

Every page is served from its own subdomain, `{slug}.kept.host`, and pages are
arbitrary user-written HTML with scripts. Listing `kept.host` as a public
suffix makes each `{slug}.kept.host` its own registrable domain (its own
"site"). Then:

- a page can no longer set a cookie for `Domain=kept.host`, or read one meant
  for another page;
- pages are cross-site to each other and to `app.kept.host`, so `SameSite`
  cookies and the browser's site isolation separate them;
- reputation systems such as Google Safe Browsing can judge one page without
  judging all of `kept.host`.

**Isolation does not wait for the listing.** The control plane lives on
`app.kept.host`, its session cookie is `__Host-kept.session_token` (host-only by
browser rule, so no page can toss or shadow it), and every cookie-authenticated
mutation checks `Origin` / `Sec-Fetch-Site` (E05a). The listing is defence in
depth and a reputation win. Until it lands, Google Search Console watches the
domain (see [abuse runbook](./abuse-runbook.md) §5).

Why not now: the PSL guidelines say projects that do not yet serve thousands of
users are likely to be declined, and kept is pre-launch.

## 2. The entry

Added to the `===BEGIN PRIVATE DOMAINS===` section of `public_suffix_list.dat`,
placed alphabetically by organisation name ("kept"):

```
// kept : https://kept.host/
// Submitted by <operator's full name, as in the Impressum> <abuse@kept.host>
kept.host
```

Only `kept.host` is listed. The dev domain `kept-dev.xyz` is not: it has no
users and is never offered to the public.

## 3. The rationale (pull-request text)

> kept (https://kept.host) is free, open-source (AGPL-3.0) static hosting. Each
> page is served at its own subdomain, `{name}.kept.host`, and its content is
> HTML written by the user or by their AI agent, scripts included. Different
> subdomains belong to different, unrelated people. We ask for `kept.host` to be
> listed so that browsers isolate those pages from each other: cookies cannot be
> set across them, and reputation is judged per page rather than for the whole
> domain.
>
> The authenticated control plane runs on `app.kept.host` with a `__Host-`
> session cookie and origin checks, so security does not depend on this listing.
> kept serves {number} users and {number} pages as of {date}.
>
> `kept.host` is registered until {expiry date}, more than two years from today,
> and we commit to keeping its registration in good standing with more than a
> year left in its term.
>
> Expected behaviour: `foo.kept.host` and `bar.kept.host` are different
> registrable domains (eTLD+1); the public suffix of `foo.kept.host` is
> `kept.host`.

Fill the three `{…}` values on the day of filing, from the open books.

## 4. Checks before filing

1. **Registration has more than two years left.** The guidelines require an
   expiry more than two years after the PR's date. Check it with
   `whois kept.host` (or the registrar's RDAP record). If it is two years or
   less away, renew first. Keep auto-renew on, and check the expiry once a
   year for as long as the entry is listed.
2. **Nothing relies on the apex and `app.` being same-site.** Once listed,
   `kept.host` and `app.kept.host` are different sites. Confirm that sign-in,
   the drop-to-publish hero and the claim flow still work when they are
   cross-site: no `SameSite` cookie is expected on a request between them.
3. **The list's tests pass.** In a fork of `publicsuffix/list`, add the entry and
   run `make test`. A patch that fails is rejected.

## 5. The `_psl` DNS proof

The guidelines require a `_psl` TXT record on each submitted name, containing
the pull request's URL. After opening the PR (number `N`):

1. In Cloudflare DNS for the `kept.host` zone, add:

   ```
   _psl.kept.host.  TXT  "https://github.com/publicsuffix/list/pull/N"
   ```

   A TXT record is DNS-only. It does not touch the Worker route
   `*.kept.host/*`, and `_psl` can never be a page name (names allow no
   underscore).
2. Check it: `dig +short TXT _psl.kept.host` prints the URL.
3. Leave the record in place for as long as the entry is listed. The
   maintainers re-check it, and a missing record can get the entry removed.

## 6. After filing

There is no deadline and no expedite. Merged entries take weeks to months to
reach browsers, and some platforms ship the list with the operating system.
Nothing in kept's code changes when the entry lands. Update this page's
status line with the PR link, and later with the merge date.
