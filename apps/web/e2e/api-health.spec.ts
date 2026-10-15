import { test, expect } from "@playwright/test";

/**
 * /api/health route handler.
 *
 * The handler returns `{ status: "ok", shared: SHARED_PACKAGE, open, scanner }`
 * where SHARED_PACKAGE is the "@kept/shared" constant exported from
 * packages/shared — so this proves the route-handler wiring AND that the app
 * resolves the shared workspace package. Asserting on `shared` keeps it
 * grounded in a stable value. `open` is the launch gate; `scanner` is E07 D17's
 * switch (`"off"` without `OPENROUTER_API_KEY`), which the release smoke reads.
 */
test.describe("api health", () => {
  test("GET /api/health returns 200, the @kept/shared constant, the gate and the scanner switch", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { status: string; shared: string; open: unknown; scanner: unknown };
    expect(body.status).toBe("ok");
    expect(body.shared).toBe("@kept/shared");
    expect(typeof body.open).toBe("boolean");
    expect(["on", "off"]).toContain(body.scanner);
    expect(Object.keys(body).sort()).toEqual(["open", "scanner", "shared", "status"]);
  });
});
