# Abuse runbook

How kept's operator handles abuse: the moderation queue, what each decision
does, child sexual abuse material, scanner trouble, and Google Search Console.
One person reviews everything. The rules pages are judged against are the
[acceptable-use policy](https://kept.host/legal/acceptable-use).

Where things come from:

- **The scanner.** Every new version is checked by one classifier right after
  it is stored. It can only move a `live` page to `under_review` (the edge
  serves 451). It never hides, removes or restores anything.
- **Reports.** Anyone can report a page at `/report` or by email to
  `abuse@kept.host`. A report for child sexual abuse material hides the page
  at once (`quarantined`). Every other category waits for a person. Mail to
  `abuse@kept.host` does not reach the queue by itself: file it through
  `/report`.
- **Appeals.** The owner of a restricted page can appeal once at a time, from
  the studio or from the page's `/p` link.

Alerts go to every address in `KEPT_ADMIN_EMAILS`: one per scanner flag; one
per page per hour for ordinary reports; a **PRIORITY** mail for every child
sexual abuse report or flag, never deduplicated; one for each appeal.

## 1. Reviewing the queue

Open `/admin/moderation` on the control plane (`app.kept.host`). It answers
404 to anyone who is not signed in with an admin address.

| Tab | Shows |
| --- | --- |
| Queue | Pages `under_review` or `quarantined`. Child sexual abuse items are pinned to the top. Everything else is oldest first. |
| Reports | Open reports. |
| Appeals | Open appeals. |
| Watch | Re-scans triggered by a traffic spike in the last 14 days. |
| Log | Every moderation action, newest first. |
| Scanner | Whether the scanner works (section 4). |

An item shows the page's facts, why it was flagged, its reports, its appeal and
its timeline. **Preview** renders the page in a sandboxed frame. Its scripts
run, but they cannot reach the network, `app.` cookies or this window.
**Source** shows the first 200 KB as plain text. Decide from those two views,
the report text and the scan facts.

## 2. What each action does

Every action is logged and sends the owner a statement of reasons. It goes to
the account email, or to a draft's reminder email. The owner reads your note.
Keep notes factual and short, and never put anything in a note that the owner
must not see.

| Action | From | Result |
| --- | --- | --- |
| **Hide** (reason required) | `live`, `under_review` | `quarantined`. The edge serves 451. The owner can appeal. The page's open reports close as actioned and their reporters are told. |
| **Remove** (reason required, confirmed) | any status but `removed` | `removed`. The page leaves the edge. Its name is held with no owner for 12 months, and that hold outlives the page. The owner keeps a read-only view and a download for 30 days (`purge_after`). After that the purge job deletes the bytes and the row. Open reports close as actioned. |
| **Restore** (note required) | `under_review`, `quarantined`, `removed` | `live`. The reason and any name hold are cleared, and an open appeal is granted. A kept page stays kept even over its limit. A draft whose clock ran out while hidden gets a fresh 7 days. Refused if another page has taken the name. |
| **Dismiss** (note required) | open reports | The reports close as dismissed and the reporters are told. The page is not touched. |
| **Grant appeal** (note required) | open appeal | The same as Restore. |
| **Reject appeal** (note required) | open appeal | The appeal closes and the owner gets your note. The page is not touched. The owner may appeal again (3 per page per 30 days). |

A change reaches the edge in seconds. In the worst case it takes about two
minutes, because every change is purged twice, the second time 125 s later
([edge purge contract](./edge-purge-contract.md) §6). If the edge still
disagrees after that, the `repurge` job retries from Postgres every 12 minutes.
After 5 failed attempts it mails the admins and leaves the `pending_purges` row
in place. Fix the cause, then reset the row's `attempts` to replay it.

## 3. Child sexual abuse material

For reason `child_sexual_abuse`, kept serves no bytes to anyone. There is no
studio preview, no `/p` preview, no download and no export. The admin preview
stays off until you click **Show**.

1. **Do not download, save, screenshot, copy or forward the content.**
   Possessing it is a crime (§ 184b StGB), and no copy is needed: the bytes
   stay in storage, unserved, until the page is purged.
2. Click **Show** only if the report, the scan facts and the address are not
   enough to decide. Leave the item when you are done.
3. **Remove** the page with reason `child_sexual_abuse`. A report in that
   category has already hidden it; a scanner flag has only put it under
   review. Write no case details in the note.
4. **Report it the same day.**
   - Notify the Bundeskriminalamt (BKA) through its intake for Article 18 DSA
     notifications. Article 18 requires a hosting provider to tell the
     authorities when it learns of a suspected criminal offence that threatens a
     person's life or safety. Recital 56 names child sexual abuse as an example.
   - Report the page address to a German INHOPE member hotline, such as
     jugendschutz.net or the eco Beschwerdestelle. INHOPE members pass reports on
     to the country where the content is hosted.
   - Give the page address, the times it was published, reported and removed,
     and the report and scan references from the item view. Hand over account
     data only on the authority's own lawful request.
5. **Preserve the records.** Moderation actions and reports stay when the
   page is purged: they keep the slug and lose only the link to the row. Scan
   rows go with the page, so copy any scan details the authority needs before
   then. Do not dismiss or edit the records. Keep the authority's case
   reference outside kept.

The bytes do not stay forever. A removed page is purged 30 days after removal,
unless an appeal is open. Under D-68, deleting the owner's account archives a
quarantined page, and its bytes are purged after the same 30-day grace. Make
the report to the authorities before then. There is no legal-hold switch: if an
authority asks for the content to be kept longer, move that row's
`purge_after` forward by hand. *(Retention period to be confirmed with the
lawyer.)*

## 4. Scanner outage and the credit limit

The scanner calls OpenRouter's Decisions API with `OPENROUTER_API_KEY`.

- **`/api/health`** reports `scanner: "on"` or `"off"`. `off` means the deploy
  has no key. Scans are then recorded as `skipped`, and only the deterministic
  rule P4 (hidden code on a page that asks for a secret) can flag. A prod
  release fails its smoke test if the deploy is open and the scanner is off.
- **The Scanner tab** is red when the key is missing, when `scan-retry` has
  never succeeded, or when its last success is more than 24 h old. It is green
  under 1 h and amber in between.
- **When a call fails**, the page stays live and P4 still applies. Failures are
  a 10 s timeout, a 5xx, a 402 (credit limit) or a malformed answer. The scan
  is marked `failed` and `scan-retry` (every 12 minutes) retries it after 5 min,
  15 min, 1 h, 6 h and 24 h, then stops. More than 20 failed attempts in
  24 h send one admin mail a day. Reports remain the backstop.
- **The credit limit.** The OpenRouter key has a monthly credit limit. When it
  is spent, every call answers 402 and the failure reads `credit_limit`. Raise
  the limit in OpenRouter or wait for the reset. Scans still inside their retry
  schedule recover on their own. For scans that used up every retry, run
  `pnpm --filter @kept/web admin:scan --all-live --dry-run` and then `--apply`
  in a shell configured for that environment. Pages whose content already has
  a verdict reuse it without a new call. `admin:scan --unscanned` covers live
  pages that never got a scan at all.
- Per-scan cost is stored in `scans.cost_usd`.

## 5. Google Search Console

Until `kept.host` is on the Public Suffix List ([PSL submission](./psl-submission.md)),
Google Safe Browsing can treat every page as part of one site. Watch it through
a **domain property**, which covers the apex and every `*.kept.host` subdomain:

1. In Search Console, add a property of type **Domain** for `kept.host`.
2. Add the `google-site-verification=…` TXT record it shows at the apex of
   the `kept.host` zone in Cloudflare DNS, then click **Verify**. Leave the
   record in place: removing it revokes access.
3. Turn on email notifications for the property.
4. Check **Security & Manual actions** (Security issues, Manual actions)
   weekly, and act on every notification the day it arrives.

When Google lists a kept page, report it through `/report` so it lands in the
queue, then decide it as above. Once the page is removed, click **Request
review** in Security issues and say what was taken down.
