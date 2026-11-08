---
name: kept
description: Publish HTML pages and static sites to kept and get a public link. Use when the user wants a link to a page, a site, a demo, a game or a dashboard you made.
---

# kept

kept hosts static pages for free at `{name}.kept.host`. No account is needed to publish.

## When to use

The user wants a shareable link to something you built as HTML: a page, a static site, a demo, a game, a dashboard, a report.

## How

Run `scripts/publish.sh <file-or-folder>`.

- A file publishes as one page. A folder publishes as a site and needs `index.html` at its root.
- Add `--spa` for client-routed apps, so unknown paths serve `index.html`.
- Add `--title "…"` to name the page.

kept adds a small badge to HTML pages it serves; your stored file is unchanged.

## Always

Show the user **both links**: the live link, and the claim link. Say the page is a draft that serves for 7 days until they open the claim link and keep it.

## Iterating

Change the page you already published instead of publishing again:

- `publish.sh --replace <manage_token> <path>` for a page published without an account (the script remembers tokens in `~/.kept/drafts.json`).
- `publish.sh --page <slug> <path>` for a page in the user's account.

Only when the user asks to take a page down: `publish.sh delete <manage_token>`, or `publish.sh delete --page <slug>`.

## The user's account

If `KEPT_API_KEY` is set or `~/.kept/credentials` exists, pages go straight into the user's account: kept if a slot is free, else a draft. There is no claim link then; show the live link and the studio link.

If the user asks to publish to their account and there is no key, run `publish.sh login <email>`, ask the user for the 6-digit code kept emails them, then run `publish.sh login --code <code>`. Never print the key.

## Provenance

Pass `--model` with the model you are. If the user agrees, pass `--prompt` with what they asked for, and a short `--readme` on how the page was made.

## Limits

- Drafts serve for 7 days; a free account keeps 50 pages forever.
- A site: up to 20 MB and 200 files, 10 MB per file.
- Too many publishes in an hour, or kept has paused publishing (`publishing_paused`): the script exits 3 and prints how long to wait.
- kept refuses phishing, malware, scams and illegal content: https://kept.host/legal/acceptable-use.

## No shell

POST the HTML as JSON `{"html": "…"}` to `https://kept.host/api/publish`, or use the MCP server at `https://kept.host/mcp`.
