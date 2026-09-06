import { describe, expect, mock, test } from "bun:test";
import { withBrowserCors } from "../src/browser-cors.js";

describe("browser cloud API CORS", () => {
  const preflight = (origin: string, path = "/conversations/test/turns", headers = "authorization, content-type") =>
    new Request(`https://builder.example${path}`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": headers },
    });

  test("trusted browser preflight succeeds before bearer authentication", async () => {
    for (const origin of ["https://stella.sh", "http://localhost:57314", "http://127.0.0.1:57314"]) {
      for (const path of ["/conversations/test/turns", "/owners/me/devices", "/owners/me/dispatches", "/conversations/test/local-turns/begin"]) {
        const handle = mock(async () => new Response(null, { status: 401 }));
        const response = await withBrowserCors(preflight(origin, path), handle);
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(handle).not.toHaveBeenCalled();
      }
    }
  });

  test("rejects untrusted origins and privileged headers", async () => {
    const handle = mock(async () => new Response(null));
    for (const origin of ["https://stella.sh.evil.example", "null", "http://localhost:9999", "https://evil.example"]) {
      const response = await withBrowserCors(preflight(origin), handle);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await withBrowserCors(preflight("https://stella.sh", undefined, "x-stella-owner-id"), handle)).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  test("actual calls keep authentication errors and stream bodies visible to trusted clients", async () => {
    const request = new Request("https://builder.example/conversations/test/turns", { method: "POST", headers: { origin: "https://stella.sh" } });
    const handle = mock(async () => Response.json({ error: "Unauthorized" }, { status: 401, headers: { Vary: "Accept" } }));
    const response = await withBrowserCors(request, handle);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://stella.sh");
    expect(response.headers.get("vary")).toBe("Accept, Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("does not expose internal service routes", async () => {
    const response = await withBrowserCors(preflight("https://stella.sh", "/internal/sandboxes/retire"), async () => new Response(null, { status: 401 }));
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
