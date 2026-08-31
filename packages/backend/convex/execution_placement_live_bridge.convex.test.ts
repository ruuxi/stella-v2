/// <reference types="vite/client" />

import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import {
  ExecutionPlacementBridge,
  type ExecutionPlacementClient,
} from "../../runtime/host/execution-placement-bridge";
import type { SqliteDatabase } from "../../runtime/kernel/storage/shared";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|live-bridge-owner";
const ownerGeneration = "legacy";

const identityRef = makeFunctionReference<"query">(
  "execution_placement:getMyExecutionPlacementIdentity",
);
const destinationsRef = makeFunctionReference<"query">(
  "execution_placement:listMyExecutionDestinations",
);
const statusRef = makeFunctionReference<"query">(
  "execution_placement:getMyExecutionDispatchStatus",
);
const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

type TestHarness = ReturnType<typeof createTest>;

const asOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "live-bridge-owner",
    tokenIdentifier: ownerId,
    iat: 1_000,
  });

const deviceIdentity = (deviceId: string) => {
  const pair = generateKeyPairSync("ed25519");
  return {
    deviceId,
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
};

type Subscription = {
  reference: FunctionReference<"query">;
  args: Record<string, unknown>;
  onValue: (value: unknown) => void;
  onError?: (error: Error) => void;
};

const createLiveClient = (t: TestHarness) => {
  const owner = asOwner(t);
  const subscriptions = new Set<Subscription>();
  let refreshTail = Promise.resolve();

  const query = async (reference: unknown, args: Record<string, unknown>) =>
    await owner.query(reference as FunctionReference<"query">, args as never);

  const refresh = async () => {
    for (const subscription of [...subscriptions]) {
      try {
        subscription.onValue(
          await query(subscription.reference, subscription.args),
        );
      } catch (error) {
        subscription.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  };

  const scheduleRefresh = () => {
    refreshTail = refreshTail.then(refresh, refresh);
    return refreshTail;
  };

  const client: ExecutionPlacementClient = {
    query,
    mutation: async (reference, args) => {
      const result = await owner.mutation(
        reference as FunctionReference<"mutation">,
        args as never,
      );
      void scheduleRefresh();
      return result;
    },
    onUpdate: (reference, args, onValue, onError) => {
      const subscription: Subscription = {
        reference: reference as FunctionReference<"query">,
        args,
        onValue,
        ...(onError ? { onError } : {}),
      };
      subscriptions.add(subscription);
      void scheduleRefresh();
      return { unsubscribe: () => subscriptions.delete(subscription) };
    },
  };

  return {
    client,
    flush: async () => {
      await scheduleRefresh();
      await refreshTail;
    },
  };
};

const waitFor = async <T>(read: () => Promise<T | null>, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for execution.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("live execution placement bridge integration", () => {
  it("routes and executes on only the explicitly selected live runtime", async () => {
    const t = createTest();
    const owner = asOwner(t);
    const conversationId = "conv-live-exact-runtime";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId,
        ownerId,
        title: "Live bridge",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const macTransport = createLiveClient(t);
    const windowsTransport = createLiveClient(t);
    const macDatabase = new DatabaseSync(":memory:");
    const windowsDatabase = new DatabaseSync(":memory:");
    const executions = { mac: 0, windows: 0 };
    const macIdentity = deviceIdentity("live-mac");
    const windowsIdentity = deviceIdentity("live-windows");
    const availability = () => ({
      ready: true,
      chatSlots: 1,
      agentSlots: 1,
      capabilities: ["chat", "agent"] as Array<"chat" | "agent">,
    });
    const macBridge = new ExecutionPlacementBridge({
      client: macTransport.client,
      database: macDatabase as unknown as SqliteDatabase,
      deviceIdentity: macIdentity,
      deviceName: "MacBook",
      platform: "darwin",
      appVersion: "live-test",
      getAvailability: availability,
      runExecution: async () => {
        executions.mac += 1;
        return { status: "ok", finalText: "unexpected mac execution" };
      },
      cancelExecution: async () => undefined,
    });
    const windowsBridge = new ExecutionPlacementBridge({
      client: windowsTransport.client,
      database: windowsDatabase as unknown as SqliteDatabase,
      deviceIdentity: windowsIdentity,
      deviceName: "Windows PC",
      platform: "win32",
      appVersion: "live-test",
      getAvailability: availability,
      runExecution: async ({ payload }) => {
        expect(payload.prompt).toBe("Run on Windows only");
        executions.windows += 1;
        return { status: "ok", finalText: "ran on Windows" };
      },
      cancelExecution: async () => undefined,
    });

    try {
      await Promise.all([macBridge.start(), windowsBridge.start()]);
      await Promise.all([macTransport.flush(), windowsTransport.flush()]);
      expect(await owner.query(identityRef, {})).toMatchObject({
        ownerId,
        ownerGeneration,
      });
      expect(await owner.query(destinationsRef, {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            deviceId: windowsIdentity.deviceId,
            name: "Windows PC",
            online: true,
            ready: true,
          }),
        ]),
      );

      const idempotencyKey = "desktop:live-target-windows";
      const payloadJson = JSON.stringify({
        prompt: "Run on Windows only",
        expectedOwnerGeneration: ownerGeneration,
        conversationId,
        clientMsgId: idempotencyKey,
      });
      const payloadHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payloadJson),
      );
      const dispatch = await macBridge.submitDesktopExecution({
        idempotencyKey,
        requestedTargetMode: "device",
        requestedExecutorDeviceId: windowsIdentity.deviceId,
        payloadJson,
        payloadHash: Buffer.from(payloadHash).toString("hex"),
        kind: "chat",
        subject: "portable",
        conversationId,
        requiredCapabilities: ["chat"],
      });
      expect(dispatch).toMatchObject({ state: "offering" });
      await Promise.all([macTransport.flush(), windowsTransport.flush()]);

      const terminal = await waitFor(async () => {
        await Promise.all([macTransport.flush(), windowsTransport.flush()]);
        const status = await owner.query(statusRef, {
          dispatchId: dispatch.dispatchId,
        });
        return status?.state === "completed" ? status : null;
      });
      expect(terminal).toMatchObject({
        state: "completed",
        placement: "computer",
        executorDeviceId: windowsIdentity.deviceId,
        resultJson: JSON.stringify({ finalText: "ran on Windows" }),
      });
      expect(executions).toEqual({ mac: 0, windows: 1 });

      const macRows = macDatabase
        .prepare("SELECT COUNT(*) AS count FROM execution_placement_inbox")
        .get() as { count: number };
      const windowsRows = windowsDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_placement_inbox WHERE state = 'terminal'",
        )
        .get() as { count: number };
      expect(macRows.count).toBe(0);
      expect(windowsRows.count).toBe(1);
    } finally {
      await Promise.allSettled([macBridge.stop(), windowsBridge.stop()]);
      macDatabase.close();
      windowsDatabase.close();
    }
  });
});
