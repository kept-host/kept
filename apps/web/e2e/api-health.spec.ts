import { test, expect } from "@playwright/test";

/**
 * /api/health route handler.
 *
 * The handler returns `{ status: "ok", shared: SHARED_PACKAGE }` where
 * SHARED_PACKAGE is the "@kept/shared" constant exported from packages/shared —
 * so this proves the route-handler wiring AND that the app resolves the shared
 * workspace package. Asserting on `shared` keeps it grounded in a stable value.
 */
test.describe("api health", () => {
  test("GET /api/health returns 200 and reflects the @kept/shared constant", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { status: string; shared: string };
    expect(body.status).toBe("ok");
    expect(body.shared).toBe("@kept/shared");
  });
});
