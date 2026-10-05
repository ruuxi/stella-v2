import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  PLACEMENT_PROTOCOL,
  SELECTED_DEVICE_NEEDS_CONSENT,
  type DispatchSubmitRequest,
} from "@stella/contracts/turn-plane/placement";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";
import {
  createGateHarness,
  generateDeviceKey,
  withNow,
  type DeviceKey,
  type GateHarness,
} from "./helpers/owner-gate-harness.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { OwnerGate } = await import("../src/owner-gate.js");
mock.restore();

/**
 * Being listed and being willing to run dispatched work are different states.
 *
 * Signing in registers a computer, which is what puts it in the device list;
 * it does not enlist it. Nothing may be offered to it until the owner has said
 * yes once — on that computer's own screen when something first tries, or from
 * any signed-in session with the enable control. These tests pin the gap
 * between the two, because collapsing it is how the feature gets deleted by
 * accident rather than replaced.
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

type Consent = "unconfigured" | "asking" | "enabled" | "declined";

const snapshotWith = (entries: Array<[DeviceKey, Consent]>) =>
  sampleOwnerSnapshot({
    devices: entries.map(([key, remoteExecution]) => ({
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      remoteExecutionEnabled: remoteExecution === "enabled",
      remoteExecution,
    })),
  });

let keyCounter = 0;
const submitBody = (
  overrides: Partial<DispatchSubmitRequest> = {},
): DispatchSubmitRequest => ({
  protocol: PLACEMENT_PROTOCOL,
  idempotencyKey: `idem-${(keyCounter += 1).toString().padStart(8, "0")}`,
  kind: "chat",
  ingress: "desktop",
  subject: "computer",
  conversationId: "conversation-1",
  requiredCapabilities: ["chat"],
  payload: {
    schemaVersion: 1,
    prompt: "Summarize my notes",
    conversationId: "conversation-1",
    clientMsgId: "client-msg-0001",
  },
  ...overrides,
});

const lastFrame = (
  socket: { sent: Array<{ type: string }> },
  type: string,
) => [...socket.sent].reverse().find((frame) => frame.type === type);

const deviceRow = async (harness: GateHarness, deviceId: string) => {
  const response = await withNow(NOW, () => harness.instance.devices(NOW));
  return response.devices.find(
    (device: { deviceId: string }) => device.deviceId === deviceId,
  );
};

const connect = (harness: GateHarness, key: DeviceKey) =>
  withNow(NOW, () =>
    harness.connect(key, { availability: { ready: true } }),
  );

const submit = (harness: GateHarness, key: DeviceKey) =>
  withNow(NOW, () =>
    harness.instance.submit({
      request: submitBody({
        targetMode: "device",
        targetDeviceId: key.deviceId,
        requestingDeviceId: key.deviceId,
      }),
      now: NOW,
    }),
  );

describe("a listed computer that has not agreed to run remote work", () => {
  test("appears in the device list but is not dispatchable", async () => {
    const key = await generateDeviceKey(`desk-${(keyCounter += 1)}`);
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([[key, "unconfigured"]]),
    });
    await connect(harness, key);

    const listed = await deviceRow(harness, key.deviceId);
    // Listed and reachable, and still refusing. Both halves matter: dropping
    // it from the list would hide the machine the owner wants to enable.
    expect(listed).toMatchObject({
      deviceId: key.deviceId,
      online: true,
      remoteExecution: "unconfigured",
      remoteExecutionEnabled: false,
    });

    const result = await submit(harness, key);

    expect(result.response.dispatch.state).toBe("blocked");
    expect(result.response.dispatch.errorCode).toBe(
      SELECTED_DEVICE_NEEDS_CONSENT,
    );
  });

  test("is asked on its own screen, and the ask is not the answer", async () => {
    const key = await generateDeviceKey(`desk-${(keyCounter += 1)}`);
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([[key, "unconfigured"]]),
    });
    const { socket } = await connect(harness, key);

    await submit(harness, key);

    expect(lastFrame(socket, "consent.request")).toMatchObject({
      type: "consent.request",
      requestedAt: NOW,
    });
    // Raising the prompt must not grant anything. If asking enabled the
    // device, anything that could trigger a dispatch could enlist a machine.
    const asked = await deviceRow(harness, key.deviceId);
    expect(asked).toMatchObject({
      remoteExecution: "asking",
      remoteExecutionEnabled: false,
    });
    expect(lastFrame(socket, "offer")).toBeUndefined();
  });

  test("becomes dispatchable once it allows on its own socket", async () => {
    const key = await generateDeviceKey(`desk-${(keyCounter += 1)}`);
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([[key, "unconfigured"]]),
    });
    const { socket } = await connect(harness, key);

    await withNow(NOW, () =>
      harness.sendFrame(socket, { type: "consent", allow: true }),
    );

    expect(await deviceRow(harness, key.deviceId)).toMatchObject({
      remoteExecution: "enabled",
      remoteExecutionEnabled: true,
    });

    const result = await submit(harness, key);

    expect(result.response.dispatch.errorCode).toBeUndefined();
    expect(result.response.dispatch.state).not.toBe("blocked");
  });

  test("records a refusal as an answer rather than as never having been asked", async () => {
    const key = await generateDeviceKey(`desk-${(keyCounter += 1)}`);
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([[key, "unconfigured"]]),
    });
    const { socket } = await connect(harness, key);

    await withNow(NOW, () =>
      harness.sendFrame(socket, { type: "consent", allow: false }),
    );

    // "declined" rather than back to "unconfigured": the difference is what
    // lets the list say the owner said no, instead of silently re-asking.
    expect(await deviceRow(harness, key.deviceId)).toMatchObject({
      remoteExecution: "declined",
      remoteExecutionEnabled: false,
    });
  });
});

describe("devices already in the table before consent existed", () => {
  test("come through enabled and are never asked", async () => {
    // The migration backfills from `remote_execution_enabled`, which every
    // registration wrote as 1, so every pre-existing device — including every
    // desktop a phone had paired with — lands here.
    const key = await generateDeviceKey(`desk-${(keyCounter += 1)}`);
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([[key, "enabled"]]),
    });
    const { socket } = await connect(harness, key);

    const result = await submit(harness, key);

    expect(result.response.dispatch.errorCode).toBeUndefined();
    expect(lastFrame(socket, "consent.request")).toBeUndefined();
  });
});
