import { afterEach, describe, expect, test } from "bun:test";
import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import { createCloudAgentLifecycleMonitor } from "./cloud-agent-lifecycle.js";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const OWNER_GENERATION = "owner-generation-1";
const activeMonitors: Array<{ stop: () => void }> = [];
const trackMonitor = <T extends { stop: () => void }>(monitor: T): T => {
  activeMonitors.push(monitor);
  return monitor;
};

afterEach(() => {
  for (const monitor of activeMonitors.splice(0)) monitor.stop();
});

const thread = (overrides: Record<string, unknown> = {}) => ({
  threadId: "cloud-thread-1",
  cloudConversationId: "cloud-conversation-1",
  originDeviceId: "device-1",
  originConversationId: "local-conversation-1",
  description: "Build the renderer",
  agentType: "general",
  ownerGeneration: OWNER_GENERATION,
  attemptGeneration: 3,
  status: "running",
  resultJson: null,
  errorMessage: null,
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describe("cloud agent lifecycle monitor", () => {
  test("does not query account-only lifecycle state for anonymous sessions", async () => {
    let connected = false;
    let queries = 0;
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: () => () => {},
      query: async () => {
        queries += 1;
        return { ownerGeneration: OWNER_GENERATION };
      },
      mutation: async () => ({}),
      canStart: () => connected,
      hasDurableLifecycleEvent: () => false,
      onLifecycleEvent: () => {},
    }));

    monitor.start();
    await flush();
    expect(queries).toBe(0);

    connected = true;
    monitor.start();
    await flush();
    expect(queries).toBe(1);
  });

  test("ignores running rows, routes terminal delivery, and acknowledges it", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const events: AgentLifecycleEvent[] = [];
    const durable = new Set<string>();
    const mutations: Array<{ ref: unknown; args: unknown }> = [];
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
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
    }));

    monitor.start();
    await flush();
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
    expect(events[0]?.eventId).toBe(
      `cloud-thread-1:${OWNER_GENERATION}:3:agent-completed`,
    );
    expect(events[0]?.result).toBe("Deployed.");
    expect(events[0]?.audience).toBe("orchestrator-only");
    expect(mutations).toEqual([
      {
        ref: "ack",
        args: {
          threadId: "cloud-thread-1",
          originDeviceId: "device-1",
          ownerGeneration: OWNER_GENERATION,
          attemptGeneration: 3,
          terminalUpdatedAt: 200,
        },
      },
    ]);
    monitor.stop();
  });

  test("persists the exact terminal control receipt before lifecycle delivery and ACK", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const order: string[] = [];
    const durable = new Set<string>();
    const controls: unknown[] = [];
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
      mutation: async () => {
        order.push("ack");
        return {};
      },
      onControlReceipt: (row) => {
        order.push("control");
        controls.push({
          cloudConversationId: row.cloudConversationId,
          ownerGeneration: row.ownerGeneration,
          attemptGeneration: row.attemptGeneration,
          threadUpdatedAt: row.updatedAt,
          status: row.status,
        });
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: (event) => {
        order.push("lifecycle");
        if (event.eventId) durable.add(event.eventId);
      },
    }));

    monitor.start();
    await flush();
    update([
      thread({
        status: "completed",
        updatedAt: 250,
        resultJson: JSON.stringify({ finalText: "Done." }),
      }),
    ]);
    await flush();
    expect(order).toEqual(["control", "lifecycle", "ack"]);
    expect(controls).toEqual([
      {
        cloudConversationId: "cloud-conversation-1",
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 3,
        threadUpdatedAt: 250,
        status: "completed",
      },
    ]);
  });

  test("acknowledges an already durable terminal event without replaying it", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const terminalEventId =
      `cloud-thread-1:${OWNER_GENERATION}:3:agent-failed`;
    const mutations: unknown[] = [];
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
      mutation: async (_ref, args) => {
        mutations.push(args);
        return {};
      },
      hasDurableLifecycleEvent: (event) => event.eventId === terminalEventId,
      onLifecycleEvent: () => {
        throw new Error("durable event must not be replayed");
      },
    }));

    monitor.start();
    await flush();
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
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 3,
        terminalUpdatedAt: 300,
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
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
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
    }));

    monitor.start();
    await flush();
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

  test("waits for durable persistence before ACK and does not duplicate an in-flight terminal wake", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const durable = new Set<string>();
    const events: string[] = [];
    const mutations: unknown[] = [];
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
      mutation: async (_ref, args) => {
        mutations.push(args);
        return {};
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: async (event) => {
        events.push(event.eventId ?? "");
        await deliveryGate;
        if (event.eventId) durable.add(event.eventId);
      },
    }));

    monitor.start();
    await flush();
    const terminal = thread({
      status: "completed",
      resultJson: JSON.stringify({ finalText: "Done." }),
      updatedAt: 600,
    });
    update([terminal]);
    update([terminal]);
    await flush();
    expect(events).toEqual([
      `cloud-thread-1:${OWNER_GENERATION}:3:agent-completed`,
    ]);
    expect(mutations).toEqual([]);

    releaseDelivery();
    await flush();
    expect(mutations).toEqual([
      {
        threadId: "cloud-thread-1",
        originDeviceId: "device-1",
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 3,
        terminalUpdatedAt: 600,
      },
    ]);
    monitor.stop();
  });

  test("retries a failed lifecycle delivery and ACKs only the successful durable attempt", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const durable = new Set<string>();
    let deliveries = 0;
    const mutations: unknown[] = [];
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      retryDelayMs: 0,
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
      mutation: async (_ref, args) => {
        mutations.push(args);
        return {};
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: async (event) => {
        deliveries += 1;
        if (deliveries === 1) throw new Error("writer stopped");
        if (event.eventId) durable.add(event.eventId);
      },
    }));

    monitor.start();
    await flush();
    update([
      thread({
        status: "failed",
        errorMessage: "Sandbox exited.",
        updatedAt: 700,
      }),
    ]);
    for (let index = 0; index < 10 && mutations.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(deliveries).toBe(2);
    expect(mutations).toEqual([
      {
        threadId: "cloud-thread-1",
        originDeviceId: "device-1",
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 3,
        terminalUpdatedAt: 700,
      },
    ]);
    monitor.stop();
  });

  test("retries a lost ACK response without duplicating the durable terminal wake", async () => {
    let update: (value: unknown) => void = () => {
      throw new Error("subscription did not start");
    };
    const durable = new Set<string>();
    let deliveries = 0;
    let acknowledgements = 0;
    const monitor = trackMonitor(createCloudAgentLifecycleMonitor({
      convexApi: {
        cloud_apps: {
          listMyDeviceAgentThreads: "list",
          acknowledgeMyDeviceAgentThreadDelivery: "ack",
        },
        execution_placement: {
          getMyExecutionPlacementIdentity: "identity",
        },
      },
      deviceId: "device-1",
      retryDelayMs: 0,
      subscribeQuery: (_query, _args, onUpdate) => {
        update = onUpdate;
        return () => {};
      },
      query: async () => ({ ownerGeneration: OWNER_GENERATION }),
      mutation: async () => {
        acknowledgements += 1;
        if (acknowledgements === 1) {
          throw new Error("response lost after commit");
        }
        return {};
      },
      hasDurableLifecycleEvent: (event) =>
        Boolean(event.eventId && durable.has(event.eventId)),
      onLifecycleEvent: async (event) => {
        deliveries += 1;
        if (event.eventId) durable.add(event.eventId);
      },
    }));

    monitor.start();
    await flush();
    update([
      thread({
        status: "completed",
        resultJson: JSON.stringify({ finalText: "Done once." }),
        updatedAt: 800,
      }),
    ]);
    for (
      let index = 0;
      index < 10 && acknowledgements < 2;
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(deliveries).toBe(1);
    expect(acknowledgements).toBe(2);
    monitor.stop();
  });

  test("re-resolves owner generation after reset and ignores stale subscription callbacks", async () => {
    const generationTwo = "owner-generation-2";
    let currentGeneration = OWNER_GENERATION;
    const subscriptions: Array<{
      args: Record<string, unknown>;
      update: (value: unknown) => void;
      error: (error: Error) => void;
    }> = [];
    const events: AgentLifecycleEvent[] = [];
    const durable = new Set<string>();
    const acknowledgements: unknown[] = [];
    const monitor = trackMonitor(
      createCloudAgentLifecycleMonitor({
        convexApi: {
          cloud_apps: {
            listMyDeviceAgentThreads: "list",
            acknowledgeMyDeviceAgentThreadDelivery: "ack",
          },
          execution_placement: {
            getMyExecutionPlacementIdentity: "identity",
          },
        },
        deviceId: "device-1",
        retryDelayMs: 0,
        query: async () => ({ ownerGeneration: currentGeneration }),
        subscribeQuery: (_query, args, onUpdate, onError) => {
          subscriptions.push({
            args,
            update: onUpdate,
            error: onError ?? (() => {}),
          });
          return () => {};
        },
        mutation: async (_ref, args) => {
          acknowledgements.push(args);
          return {};
        },
        hasDurableLifecycleEvent: (event) =>
          Boolean(event.eventId && durable.has(event.eventId)),
        onLifecycleEvent: (event) => {
          events.push(event);
          if (event.eventId) durable.add(event.eventId);
        },
      }),
    );

    monitor.start();
    await flush();
    expect(subscriptions[0]?.args).toEqual({
      originDeviceId: "device-1",
      ownerGeneration: OWNER_GENERATION,
      limit: 100,
    });

    currentGeneration = generationTwo;
    subscriptions[0]?.error(new Error("OWNER_DATA_GENERATION_STALE"));
    for (let index = 0; index < 10 && subscriptions.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(subscriptions[1]?.args).toEqual({
      originDeviceId: "device-1",
      ownerGeneration: generationTwo,
      limit: 100,
    });

    const staleTerminal = thread({
      status: "completed",
      updatedAt: 900,
    });
    subscriptions[0]?.update([staleTerminal]);
    subscriptions[1]?.update([
      thread({
        ownerGeneration: generationTwo,
        status: "completed",
        updatedAt: 901,
      }),
    ]);
    await flush();

    expect(events.map((event) => event.eventId)).toEqual([
      `cloud-thread-1:${generationTwo}:3:agent-completed`,
    ]);
    expect(acknowledgements).toEqual([
      {
        threadId: "cloud-thread-1",
        originDeviceId: "device-1",
        ownerGeneration: generationTwo,
        attemptGeneration: 3,
        terminalUpdatedAt: 901,
      },
    ]);
  });
});
