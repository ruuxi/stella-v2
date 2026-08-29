/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * The phone's standalone chat responder is gone: one chat rides cloud
 * conversations, and execution placement decides where a turn runs. Nothing
 * should answer at the old responder's addresses, and no build of the app
 * should be able to reach a mobile chat runtime that no longer exists.
 */
const RETIRED_ROUTES = [
  "/api/mobile/offline-chat",
  "/api/mobile/offline-chat/stream",
  "/api/mobile/chat",
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

  it("keeps the placement routes the one chat sends through", async () => {
    const t = convexTest(schema, modules);
    // Unauthenticated, so this proves the route exists and refuses rather than
    // that a turn was admitted.
    const response = await t.fetch("/api/mobile/execution/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).not.toBe(404);
  });
});
