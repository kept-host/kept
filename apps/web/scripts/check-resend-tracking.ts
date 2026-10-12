/**
 * Read-only: are open and click tracking off on the sending domain? (E06a §3)
 *
 *   pnpm --filter @kept/web resend:tracking
 *
 * Tracking is a per-domain Resend setting, never a send option, so kept's code
 * cannot turn it off — it can only check. This looks up the domain of
 * `EMAIL_FROM` through `resendConfig()` (apps/web/.env.local locally) and
 * prints the domain name and the two booleans — nothing else, never the key.
 * Exits 1 when either is on, or when the key cannot read domains.
 *
 * The app's own key is (and should stay) SENDING-ONLY, which Resend refuses
 * here with `restricted_api_key`. Run it with a full-access key for that one
 * command — an explicit variable beats `.env.local`:
 *
 *   RESEND_API_KEY=<full-access key> pnpm --filter @kept/web resend:tracking
 */
import { config } from "dotenv";
import { Resend } from "resend";

import { resendConfig } from "../lib/storage/env";

config({ path: ".env.local", quiet: true });

const { apiKey, from } = resendConfig();
const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
if (!domain) throw new Error("EMAIL_FROM has no domain");

const resend = new Resend(apiKey);
const listed = await resend.domains.list();
if (listed.error) {
  console.error(
    `resend:tracking — cannot list domains (${listed.error.name}); a sending-only key can't. ` +
      "Rerun with a full-access RESEND_API_KEY for this command.",
  );
  process.exit(1);
}
const match = listed.data?.data.find((entry) => entry.name.toLowerCase() === domain);
if (!match) {
  console.error(`resend:tracking — ${domain} is not a domain on this Resend account`);
  process.exit(1);
}
const detail = await resend.domains.get(match.id);
if (detail.error || !detail.data) {
  console.error(`resend:tracking — cannot read ${domain}: ${detail.error?.name ?? "no data"}`);
  process.exit(1);
}

const openTracking = detail.data.open_tracking ?? false;
const clickTracking = detail.data.click_tracking ?? false;
console.log(JSON.stringify({ domain, open_tracking: openTracking, click_tracking: clickTracking }));
process.exit(openTracking || clickTracking ? 1 : 0);
