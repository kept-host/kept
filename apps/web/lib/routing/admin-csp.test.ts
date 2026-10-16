/**
 * The `/admin/*` Content-Security-Policy (E07 task 011, AC20, Risk 8): the
 * policy itself, and `middleware()` putting it on the admin prefix only — on
 * the response (the browser enforces it) and on the forwarded request (Next
 * reads the nonce from it). Pure: a real `NextRequest`, no server.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

import { adminContentSecurityPolicy, isAdminPath } from "./admin-csp";

const APP_URL = "https://app.kept-test.example";

function run(path: string) {
  const saved = { app: process.env.NEXT_PUBLIC_APP_URL, open: process.env.NEXT_PUBLIC_KEPT_OPEN };
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.NEXT_PUBLIC_KEPT_OPEN = "true";
  try {
    return middleware(new NextRequest(new Request(`${APP_URL}${path}`)));
  } finally {
    for (const [name, value] of [["NEXT_PUBLIC_APP_URL", saved.app], ["NEXT_PUBLIC_KEPT_OPEN", saved.open]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the policy: nonce scripts only, no framing of the screen, srcdoc frames only", () => {
  const policy = adminContentSecurityPolicy("abc123", false);
  const directives = new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values.join(" ")];
    }),
  );
  assert.equal(directives.get("default-src"), "'self'");
  assert.equal(directives.get("script-src"), "'self' 'nonce-abc123' 'strict-dynamic'");
  assert.equal(directives.get("frame-src"), "about:");
  assert.equal(directives.get("frame-ancestors"), "'none'");
  assert.equal(directives.get("object-src"), "'none'");
  assert.equal(directives.get("base-uri"), "'none'");
  // 'unsafe-inline' is for styles only, never scripts; no 'unsafe-eval' outside `next dev`.
  assert.doesNotMatch(directives.get("script-src")!, /unsafe/);
  assert.equal(directives.get("style-src"), "'self' 'unsafe-inline'");
  assert.match(adminContentSecurityPolicy("n", true), /script-src [^;]*'unsafe-eval'/);
});

test("the prefix: /admin and below, nothing that merely starts with the letters", () => {
  for (const path of ["/admin", "/admin/", "/admin/moderation", "/admin/moderation/site/x"]) assert.ok(isAdminPath(path), path);
  for (const path of ["/", "/administrator", "/dashboard", "/api/admin/moderation/reports", "/site/admin"]) {
    assert.ok(!isAdminPath(path), path);
  }
});

test("middleware: /admin/* gets the policy on the response and the request, each with a fresh nonce", () => {
  const first = run("/admin/moderation?tab=log");
  const second = run("/admin/moderation");
  const policy = first.headers.get("content-security-policy");
  assert.ok(policy, "the response carries the policy");
  assert.equal(first.headers.get("x-middleware-request-content-security-policy"), policy);
  // The pathname stamp survives beside it.
  assert.equal(first.headers.get("x-middleware-request-x-kept-pathname"), "/admin/moderation?tab=log");
  const nonce = (value: string | null) => /'nonce-([^']+)'/.exec(value ?? "")?.[1];
  assert.ok(nonce(policy));
  assert.notEqual(nonce(policy), nonce(second.headers.get("content-security-policy")));
});

test("middleware: no other route on app. gets a policy", () => {
  for (const path of ["/dashboard", "/site/x", "/auth", "/settings", "/api/admin/moderation/reports", "/api/sites"]) {
    const response = run(path);
    assert.equal(response.headers.get("content-security-policy"), null, path);
    assert.equal(response.headers.get("x-middleware-request-content-security-policy"), null, path);
  }
});
