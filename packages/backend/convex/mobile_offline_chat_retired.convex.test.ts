/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * The phone's standalone chat responder is gone: one chat rides cloud
 * conversations. So is Convex's placement ingress — the phone now submits to
 * the cloud-builder's turn route with its pairing proof and the owner gate
 * decides where the turn runs. Nothing should answer at either address, and
 * no build of the app should be able to reach a runtime that no longer exists.
 */
const RETIRED_ROUTES = [
  "/api/mobile/offline-chat",
  "/api/mobile/offline-chat/stream",
  "/api/mobile/chat",
  "/api/mobile/execution/submit",
  "/api/mobile/execution/cancel",
  "/api/execution-placement/presence/socket/check",
  "/api/execution-placement/presence/socket/disconnect",
];

describe("retired mobile offline chat responder", () => {
  it("has no route left at any responder address", async () => {
    const t = convexTest(schema, modules);
    for (const path of RETIRED_ROUTES) {
      const response = await t.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status, `POST ${path}`).toBe(404);
    }
  });

  it("no longer serves execution status from Convex", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch(
      "/api/mobile/execution/status?dispatchId=abc",
      { method: "GET" },
    );
    expect(response.status).toBe(404);
  });
});
