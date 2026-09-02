import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  DEVICE_PRESENCE_CLOSE,
  DEVICE_PRESENCE_PING_INTERVAL_MS,
  DEVICE_PRESENCE_STALE_AFTER_MS,
} from "@stella/contracts/turn-plane/placement";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";
import {
  createGateHarness,
  generateDeviceKey,
  withNow,
  type GateHarness,
} from "./helpers/owner-gate-harness.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { OwnerGate, OWNER_GATE_PRESENCE_KEEPALIVE_MS } = await import(
  "../src/owner-gate.js"
);
mock.restore();

/**
 * The presence socket is the device's whole identity: no offer, no claim, and
 * no destination row exists for a socket that has not proven possession of
 * the key the owner snapshot registered. These tests drive the real Durable
 * Object with a faked hibernation API, so every close code and every state
 * write below is the one a device would actually see.
 */

const NOW = 1_800_000_000_000;

const harnesses: GateHarness[] = [];
const open = (...args: Parameters<typeof createGateHarness>) => {
  const harness = createGateHarness(...args);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

const withDevices = async (deviceIds: string[]) => {
  const keys = await Promise.all(deviceIds.map(generateDeviceKey));
  return {
    keys,
    snapshot: sampleOwnerSnapshot({
      devices: keys.map((key) => ({
        deviceId: key.deviceId,
        publicKey: key.publicKey,
        remoteExecutionEnabled: true,
        label: `Desk ${key.deviceId}`,
      })),
    }),
  };
};

describe("device presence socket", () => {
  test("challenges, then only reports presence after a valid proof", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await harness.connect(keys[0]!);

    const challenge = socket.sent[0]!;
    expect(challenge).toMatchObject({
      type: "challenge",
      pingIntervalMs: DEVICE_PRESENCE_PING_INTERVAL_MS,
      staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
    });
    // `begin` is silent: nothing is disclosed before the proof.
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({
      type: "connected",
      presenceSessionId: "session-desk-1",
    });

    const devices = await harness.instance.devices();
    expect(devices.devices).toEqual([
      {
        deviceId: "desk-1",
        label: "Desk desk-1",
        remoteExecutionEnabled: true,
        online: true,
        presenceSessionId: "session-desk-1",
        availability: {
          ready: true,
          chatSlots: 1,
          agentSlots: 1,
          capabilities: ["chat", "agent", "attachments"],
        },
        lastSeenAt: expect.any(Number),
      },
    ]);
    expect(devices.cloud).toEqual({
      capabilities: ["chat", "agent", "attachments"],
    });
  });

  test("closes an unregistered device and a forged signature the same way", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const impostor = await generateDeviceKey("desk-1");

    const forged = open(OwnerGate, { snapshot });
    const { socket: forgedSocket } = await forged.connect(keys[0]!, {
      signWith: impostor,
    });
    expect(forgedSocket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.proofRejected, reason: "device_proof_rejected" },
    ]);
    expect((await forged.instance.devices()).devices[0].online).toBe(false);

    const unknown = open(OwnerGate, { snapshot });
    const stranger = await generateDeviceKey("desk-9");
    const { socket: strangerSocket } = await unknown.connect(stranger);
    expect(strangerSocket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.proofRejected, reason: "device_proof_rejected" },
    ]);
  });

  test("refuses frames out of order and oversize frames", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await harness.connect(keys[0]!, { skipProof: true });
    // A second `begin` on a socket already past the challenge is a protocol
    // error, not a re-handshake.
    await harness.sendFrame(socket, {
      type: "begin",
      presenceSessionId: "session-2",
      protocolVersion: 1,
      availability: {
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat"],
      },
    });
    expect(socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.protocol, reason: "bad_request" },
    ]);

    const second = open(OwnerGate, { snapshot });
    const { socket: big } = await second.connect(keys[0]!);
    await second.instance.webSocketMessage(
      big,
      JSON.stringify({ type: "availability", pad: "x".repeat(70_000) }),
    );
    expect(big.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.protocol, reason: "frame_too_large" },
    ]);
  });

  test("a claim frame from a socket that never proved is unauthorized", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await harness.connect(keys[0]!, { skipProof: true });
    await harness.sendFrame(socket, {
      type: "claim",
      dispatchId: "dsp:whatever",
      claimRequestId: "claim-1",
    });
    expect(socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.unauthorized, reason: "unauthorized" },
    ]);
  });

  test("pings keep the session alive and answer with the server clock", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await withNow(NOW - 1_000, () =>
      harness.connect(keys[0]!),
    );
    await withNow(NOW, () => harness.sendFrame(socket, { type: "ping" }));
    expect(socket.sent.at(-1)).toEqual({ type: "pong", serverTimeMs: NOW });
    const devices = await harness.instance.devices(NOW);
    expect(devices.devices[0].lastSeenAt).toBe(NOW);
  });

  test("an availability update replaces the advertised slots", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await harness.connect(keys[0]!);
    await harness.sendFrame(socket, {
      type: "availability",
      availability: {
        ready: false,
        chatSlots: 0,
        agentSlots: 3,
        capabilities: ["chat", "agent", "computer-use"],
      },
    });
    const devices = await harness.instance.devices();
    expect(devices.devices[0].availability).toEqual({
      ready: false,
      chatSlots: 0,
      agentSlots: 3,
      capabilities: ["chat", "agent", "computer-use"],
    });
    // A malformed availability is a protocol error rather than a silent drop.
    await harness.sendFrame(socket, {
      type: "availability",
      availability: { ready: true, chatSlots: -1 } as never,
    });
    expect(socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.protocol, reason: "bad_request" },
    ]);
  });

  test("a newly proven socket replaces the older one for the same device", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const first = await harness.connect(keys[0]!, {
      presenceSessionId: "session-a",
    });
    expect(first.socket.closed).toBe(false);
    const second = await harness.connect(keys[0]!, {
      presenceSessionId: "session-b",
    });
    expect(first.socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.replaced, reason: "replaced" },
    ]);
    expect(second.socket.closed).toBe(false);
    expect((await harness.instance.devices()).devices[0]).toMatchObject({
      online: true,
      presenceSessionId: "session-b",
    });
  });

  test("a failed handshake never evicts the working socket", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const impostor = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, { snapshot });
    const good = await harness.connect(keys[0]!, {
      presenceSessionId: "session-a",
    });
    const bad = await harness.connect(keys[0]!, {
      presenceSessionId: "session-b",
      signWith: impostor,
    });
    expect(bad.socket.closes[0]!.code).toBe(DEVICE_PRESENCE_CLOSE.proofRejected);
    expect(good.socket.closed).toBe(false);
    expect((await harness.instance.devices()).devices[0]).toMatchObject({
      online: true,
      presenceSessionId: "session-a",
    });
  });

  test("the alarm closes a silent socket and an expired sign-in as stale", async () => {
    const { keys, snapshot } = await withDevices(["desk-1", "desk-2"]);
    const harness = open(OwnerGate, { snapshot });
    const silent = await withNow(NOW, () => harness.connect(keys[0]!));
    const expiring = await withNow(NOW, () =>
      harness.connect(keys[1]!, { authExpiresAtMs: NOW + 30_000 }),
    );

    await withNow(NOW + 40_000, () => harness.instance.alarm());
    // Only the sign-in has lapsed so far; the silent socket is still fresh.
    expect(silent.socket.closed).toBe(false);
    expect(expiring.socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.stale, reason: "stale" },
    ]);

    await withNow(NOW + DEVICE_PRESENCE_STALE_AFTER_MS + 1, () =>
      harness.instance.alarm(),
    );
    expect(silent.socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.stale, reason: "stale" },
    ]);
    const devices = await harness.instance.devices(
      NOW + DEVICE_PRESENCE_STALE_AFTER_MS + 1,
    );
    expect(devices.devices.map((device: { online: boolean }) => device.online)).toEqual([
      false,
      false,
    ]);
  });

  test("a proven socket keeps the gate alarm armed within the keepalive interval", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await withNow(NOW, () => harness.connect(keys[0]!));
    // Proven: the next alarm is the keepalive, well before the stale deadline.
    expect(harness.alarms.at(-1)).toBeGreaterThan(NOW);
    expect(harness.alarms.at(-1)).toBeLessThanOrEqual(
      NOW + OWNER_GATE_PRESENCE_KEEPALIVE_MS,
    );
    expect(OWNER_GATE_PRESENCE_KEEPALIVE_MS).toBeLessThan(
      DEVICE_PRESENCE_STALE_AFTER_MS,
    );

    // Each firing re-arms the next one while the socket is still attached,
    // and a fresh ping keeps the socket itself from going stale.
    await withNow(NOW + 20_000, () =>
      harness.sendFrame(socket, { type: "ping" }),
    );
    await withNow(NOW + OWNER_GATE_PRESENCE_KEEPALIVE_MS, () =>
      harness.instance.alarm(),
    );
    expect(socket.closed).toBe(false);
    expect(harness.alarms.at(-1)).toBeGreaterThan(
      NOW + OWNER_GATE_PRESENCE_KEEPALIVE_MS,
    );
    expect(harness.alarms.at(-1)).toBeLessThanOrEqual(
      NOW + 2 * OWNER_GATE_PRESENCE_KEEPALIVE_MS,
    );

    // Once the socket is gone there is nothing to keep resident: the close
    // only nudges the already-due alarm by the 250 ms floor, and that firing
    // does not re-arm.
    const closedAt = NOW + 2 * OWNER_GATE_PRESENCE_KEEPALIVE_MS;
    await withNow(closedAt, () =>
      harness.instance.webSocketClose(socket, 1000),
    );
    expect(harness.alarms.at(-1)).toBeLessThanOrEqual(closedAt + 250);
    await withNow(closedAt + 250, () => harness.instance.alarm());
    expect(harness.alarms.at(-1)).toBeLessThanOrEqual(closedAt + 250);
  });

  test("an unproven socket does not keep the gate resident", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    await withNow(NOW, () => harness.connect(keys[0]!, { skipProof: true }));
    expect(harness.alarms.at(-1)).toBeGreaterThan(
      NOW + OWNER_GATE_PRESENCE_KEEPALIVE_MS,
    );
  });

  test("a socket whose sign-in has already lapsed is dropped on its next frame", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await withNow(NOW, () =>
      harness.connect(keys[0]!, { authExpiresAtMs: NOW + 10_000 }),
    );
    await withNow(NOW + 20_000, () =>
      harness.sendFrame(socket, { type: "ping" }),
    );
    expect(socket.closes).toEqual([
      { code: DEVICE_PRESENCE_CLOSE.stale, reason: "stale" },
    ]);
  });

  test("a close marks the device offline without losing its row", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const { socket } = await harness.connect(keys[0]!);
    await harness.instance.webSocketClose(socket, 1000);
    const devices = await harness.instance.devices();
    expect(devices.devices[0]).toMatchObject({
      deviceId: "desk-1",
      online: false,
      presenceSessionId: "session-desk-1",
    });
    expect(devices.devices[0].availability.ready).toBe(false);
  });

  test("the upgrade refuses a mismatched owner, an expired token, or plain HTTP", async () => {
    const { keys, snapshot } = await withDevices(["desk-1"]);
    const harness = open(OwnerGate, { snapshot });
    const upgrade = (headers: Record<string, string>) =>
      harness.instance.fetch(
        new Request("https://owner-gate/presence", { headers }),
      );
    expect(
      (
        await upgrade({
          "x-stella-owner": "owner-1",
          "x-stella-device-id": keys[0]!.deviceId,
          "x-stella-token-exp": String(Date.now() + 60_000),
        })
      ).status,
    ).toBe(426);
    expect(
      (
        await upgrade({
          upgrade: "websocket",
          "x-stella-owner": "someone-else",
          "x-stella-device-id": keys[0]!.deviceId,
          "x-stella-token-exp": String(Date.now() + 60_000),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await upgrade({
          upgrade: "websocket",
          "x-stella-owner": "owner-1",
          "x-stella-device-id": keys[0]!.deviceId,
          "x-stella-token-exp": String(Date.now() - 1),
        })
      ).status,
    ).toBe(401);
  });
});
