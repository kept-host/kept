/**
 * `KEPT_EMAIL_DELIVERY=off` — honoured on a localhost origin, refused anywhere
 * else (`emailDeliveryOff()` in `lib/storage/env.ts`, used by `sendEmail`).
 *
 * Real code, no mocks, no network: every case either returns before the Resend
 * call (delivery off on localhost) or throws before it (any other origin). The
 * placeholder credential below is configuration no case transmits.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { emailDeliveryOff } from "../storage/env";
import { sendEmail } from "./send";

const NAMES = ["KEPT_EMAIL_DELIVERY", "NEXT_PUBLIC_APP_URL", "RESEND_API_KEY", "EMAIL_FROM"] as const;

/** Run `fn` with exactly `vars` set for these names, then put the originals back. */
async function withEnv(
  vars: Partial<Record<(typeof NAMES)[number], string>>,
  fn: () => unknown,
): Promise<void> {
  const saved = NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of NAMES) {
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const LOCAL = "https://localhost:3000";
const GUARD = /KEPT_EMAIL_DELIVERY — `off` is honoured only when NEXT_PUBLIC_APP_URL is a localhost origin/;

test("unset, blank or `on` delivers, on any origin", async () => {
  for (const value of [undefined, "", "on"]) {
    await withEnv({ KEPT_EMAIL_DELIVERY: value, NEXT_PUBLIC_APP_URL: "https://app.kept.host" }, () =>
      assert.equal(emailDeliveryOff(), false, `KEPT_EMAIL_DELIVERY=${String(value)}`),
    );
  }
});

test("`off` is honoured on a localhost origin", async () => {
  await withEnv({ KEPT_EMAIL_DELIVERY: "off", NEXT_PUBLIC_APP_URL: LOCAL }, () =>
    assert.equal(emailDeliveryOff(), true),
  );
});

test("`off` throws on every deployed origin, and on one that only looks local", async () => {
  for (const origin of ["https://app.kept.host", "https://app.kept-dev.xyz", "https://localhost.kept.host"]) {
    await withEnv({ KEPT_EMAIL_DELIVERY: "off", NEXT_PUBLIC_APP_URL: origin }, () =>
      assert.throws(() => emailDeliveryOff(), GUARD, origin),
    );
  }
});

test("any other value is a configuration error", async () => {
  await withEnv({ KEPT_EMAIL_DELIVERY: "false", NEXT_PUBLIC_APP_URL: LOCAL }, () =>
    assert.throws(() => emailDeliveryOff(), /Invalid or missing environment: KEPT_EMAIL_DELIVERY/),
  );
});

test("sendEmail with delivery off composes with the configured sender and resolves", async () => {
  const env = {
    KEPT_EMAIL_DELIVERY: "off",
    NEXT_PUBLIC_APP_URL: LOCAL,
    RESEND_API_KEY: "unprovisioned.resend.invalid",
    EMAIL_FROM: "kept <page@kept.invalid>",
  };
  await withEnv(env, async () => {
    let composedWith: string | undefined;
    await sendEmail((from) => {
      composedWith = from;
      return { to: "someone@kept.invalid", subject: "send.test", text: "body" };
    });
    assert.equal(composedWith, env.EMAIL_FROM);
  });
});

test("sendEmail with delivery off on a deployed origin rejects before any send", async () => {
  await withEnv(
    {
      KEPT_EMAIL_DELIVERY: "off",
      NEXT_PUBLIC_APP_URL: "https://app.kept.host",
      RESEND_API_KEY: "unprovisioned.resend.invalid",
      EMAIL_FROM: "page@kept.invalid",
    },
    () =>
      assert.rejects(
        sendEmail(() => ({ to: "someone@kept.invalid", subject: "send.test", text: "body" })),
        GUARD,
      ),
  );
});
