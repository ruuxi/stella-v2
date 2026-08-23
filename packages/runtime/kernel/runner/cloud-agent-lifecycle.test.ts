import { describe, expect, test } from "bun:test";
import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import { createCloudAgentLifecycleMonitor } from "./cloud-agent-lifecycle.js";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const thread = (overrides: Record<string, unknown> = {}) => ({
  threadId: "cloud-thread-1",
  originDeviceId: "device-1",
  originConversationId: "local-conversation-1",
  description: "Build the renderer",
  agentType: "general",
  status: "running",
  resultJson: null,
  errorMessage: null,
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describe("cloud agent lifecycle monitor", () => {
  test("ignores running rows, routes terminal delivery, and acknowledges it", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const events: AgentLifecycleEvent[] = [];
    const durable = new Set<string>();
    const mutations: Array<{ ref: unknown; args: unknown }> = [];
    const monitor = createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      mutation: async (ref, args) => {
        mutations.push({ ref, args });
        return {};
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: (event) => {
        events.push(event);
        if (event.eventId) durable.add(event.eventId);
      },
    });

    monitor.start();
    update([thread()]);
    await flush();
    expect(events).toEqual([]);
    expect(mutations).toHaveLength(0);

    update([
      thread({
        status: "completed",
        resultJson: JSON.stringify({ finalText: "Deployed." }),
        updatedAt: 200,
      }),
    ]);
    await flush();
    expect(events.map((event) => event.type)).toEqual(["agent-completed"]);
    expect(events[0]?.result).toBe("Deployed.");
    expect(events[0]?.audience).toBe("orchestrator-only");
    expect(mutations).toEqual([
      {
        ref: "ack",
        args: {
          threadId: "cloud-thread-1",
          originDeviceId: "device-1",
        },
      },
    ]);
    monitor.stop();
  });

  test("acknowledges an already durable terminal event without replaying it", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const terminalEventId = "cloud:cloud-thread-1:failed:300";
    const mutations: unknown[] = [];
    const monitor = createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      mutation: async (_ref, args) => {
        mutations.push(args);
        return {};
      },
      hasDurableLifecycleEvent: (event) => event.eventId === terminalEventId,
      onLifecycleEvent: () => {
        throw new Error("durable event must not be replayed");
      },
    });

    monitor.start();
    update([
      thread({
        status: "failed",
        errorMessage: "Sandbox exited.",
        updatedAt: 300,
      }),
      thread({ originDeviceId: "some-other-device" }),
    ]);
    await flush();
    expect(mutations).toEqual([
      {
        threadId: "cloud-thread-1",
        originDeviceId: "device-1",
      },
    ]);
    monitor.stop();
  });

  test("maps failed and canceled cloud rows to terminal desktop events", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const events: AgentLifecycleEvent[] = [];
    const durable = new Set<string>();
    const acknowledged: string[] = [];
    const monitor = createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      mutation: async (_ref, args) => {
        acknowledged.push((args as { threadId: string }).threadId);
        return {};
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: (event) => {
        events.push(event);
        if (event.eventId) durable.add(event.eventId);
      },
    });

    monitor.start();
    update([
      thread({
        threadId: "failed-thread",
        status: "failed",
        errorMessage: "Native CLI exited.",
        updatedAt: 400,
      }),
      thread({
        threadId: "canceled-thread",
        status: "canceled",
        errorMessage: "Paused by orchestrator.",
        updatedAt: 500,
      }),
    ]);
    await flush();

    expect(
      events.map(({ type, agentId, error }) => ({ type, agentId, error })),
    ).toEqual([
      {
        type: "agent-failed",
        agentId: "failed-thread",
        error: "Native CLI exited.",
      },
      {
        type: "agent-canceled",
        agentId: "canceled-thread",
        error: "Paused by orchestrator.",
      },
    ]);
    expect(acknowledged).toEqual(["failed-thread", "canceled-thread"]);
    monitor.stop();
  });
});
