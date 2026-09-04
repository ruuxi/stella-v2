import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  DISPATCH_ACCEPTED_LEASE_MS,
  DISPATCH_CLAIM_LEASE_MS,
  DISPATCH_OFFER_WINDOW_MS,
  PLACEMENT_PROTOCOL,
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
const { DISPATCH_CLOUD_RETRY_DELAY_MS, OwnerGate } =
  await import("../src/owner-gate.js");
mock.restore();

/**
 * Placement end to end inside the owner gate: the offer window, the fenced
 * claim, the payload handover rule (the desktop's inbox becomes the only copy
 * once it acks), the cloud fallback and the exact Durable Object calls it
 * makes, cancellation on both placements, and what a lapsed lease is allowed
 * to do — reroute before acceptance, reconcile after it.
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

const snapshotWith = (keys: DeviceKey[], paired: string[] = []) =>
  sampleOwnerSnapshot({
    devices: keys.map((key) => ({
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      remoteExecutionEnabled: true,
    })),
    pairedDevices: paired.map((desktopDeviceId) => ({
      mobileDeviceId: "phone-1",
      desktopDeviceId,
      mobilePublicKey: "pair-key",
    })),
  });

let keyCounter = 0;
const submitBody = (
  overrides: Partial<DispatchSubmitRequest> = {},
): DispatchSubmitRequest => ({
  protocol: PLACEMENT_PROTOCOL,
  idempotencyKey: `idem-${(keyCounter += 1).toString().padStart(8, "0")}`,
  kind: "chat",
  ingress: "mobile",
  subject: "portable",
  requestingDeviceId: "phone-1",
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

const lastFrame = (socket: { sent: Array<{ type: string }> }, type: string) =>
  [...socket.sent].reverse().find((frame) => frame.type === type);

describe("dispatch submission", () => {
  test("offers mobile work to the paired desktop with the payload and its hash", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));

    const result = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    expect(result.ok).toBe(true);
    const dispatch = result.response.dispatch;
    expect(dispatch).toMatchObject({
      state: "offering",
      ingress: "mobile",
      subject: "portable",
      fallbackReason: "paired-computer-preferred",
      revision: 1,
    });
    expect(result.response.replayed).toBe(false);

    const offer = lastFrame(socket, "offer") as {
      payloadJson: string;
      payloadHash: string;
      offerExpiresAt: number;
    };
    expect(offer.offerExpiresAt).toBe(NOW + DISPATCH_OFFER_WINDOW_MS);
    expect(JSON.parse(offer.payloadJson)).toMatchObject({
      prompt: "Summarize my notes",
      clientMsgId: "client-msg-0001",
    });
    expect(offer.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.forwarded).toHaveLength(0);
  });

  test("an unpaired phone goes straight to cloud without changing its subject", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const result = await withNow(NOW, () =>
      harness.instance.submit({
        // No pairing was proven, so neither side of a grant is present.
        request: submitBody({ requestingDeviceId: undefined }),
        now: NOW,
      }),
    );
    expect(result.response.dispatch).toMatchObject({
      state: "cloud_running",
      placement: "cloud",
      subject: "portable",
      fallbackReason: "no-eligible-paired-computer",
      cloudTurnId: "turn-conversation-1",
    });
  });

  test("an explicitly selected computer that is offline is blocked, never rerouted", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, { snapshot: snapshotWith([desk]) });
    const result = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "browser",
          subject: "cloud",
          targetMode: "device",
          targetDeviceId: "desk-1",
        }),
        now: NOW,
      }),
    );
    expect(result.response.dispatch).toMatchObject({
      state: "blocked",
      errorCode: "SELECTED_DEVICE_UNAVAILABLE",
      fallbackReason: "selected-device-unavailable",
    });
    expect(harness.forwarded).toHaveLength(0);
  });

  test("desktop ingress commits to the requesting device and drops the payload", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, { snapshot: snapshotWith([desk]) });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const result = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "desktop",
          subject: "computer",
          requestingDeviceId: "desk-1",
        }),
        now: NOW,
      }),
    );
    expect(result.response.dispatch).toMatchObject({
      state: "computer_accepted",
      placement: "computer",
      executorDeviceId: "desk-1",
      fallbackReason: "desktop-ingress",
    });
    // No offer was made; the desktop is simply told what it now owns.
    expect(lastFrame(socket, "offer")).toBeUndefined();
    expect(lastFrame(socket, "dispatch")).toBeDefined();
    // The slot it occupies is accounted for immediately.
    expect(
      (await harness.instance.devices(NOW)).devices[0].availability.chatSlots,
    ).toBe(0);
  });

  test("a desktop dispatch with no requesting device is a bad request", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const result = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "desktop",
          subject: "computer",
          requestingDeviceId: undefined,
        }),
        now: NOW,
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "bad_request",
        message: "A desktop dispatch must name the device that will run it.",
        retryable: false,
      },
    });
    // The refused submission gave its gate slot back.
    expect((await harness.instance.status(NOW)).running).toHaveLength(0);
  });

  test("replays an identical key and conflicts on different routing facts", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const request = submitBody({ ingress: "browser", subject: "cloud" });
    const first = await withNow(NOW, () =>
      harness.instance.submit({ request, now: NOW }),
    );
    const replay = await withNow(NOW, () =>
      harness.instance.submit({ request, now: NOW }),
    );
    expect(replay.response.replayed).toBe(true);
    expect(replay.response.dispatch.dispatchId).toBe(
      first.response.dispatch.dispatchId,
    );
    // Exactly one cloud start, not two.
    expect(harness.forwarded).toHaveLength(1);

    const conflicting = await withNow(NOW, () =>
      harness.instance.submit({
        request: {
          ...request,
          payload: { ...request.payload, prompt: "something else" },
        },
        now: NOW,
      }),
    );
    expect(conflicting).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  const agentBody = (overrides: Partial<DispatchSubmitRequest> = {}) =>
    submitBody({
      kind: "agent",
      ingress: "browser",
      subject: "cloud",
      requestingDeviceId: undefined,
      requiredCapabilities: [],
      payload: {
        schemaVersion: 1,
        prompt: "Rename the screenshots",
        conversationId: "conversation-1",
        clientMsgId: "client-msg-0001",
        description: "Rename screenshots",
      },
      ...overrides,
    });

  test("an agent dispatch registers once and exact replay stays idempotent", async () => {
    const harness = open(OwnerGate);
    const request = agentBody();
    const admitted = await withNow(NOW, () =>
      harness.instance.submit({ request, now: NOW }),
    );
    expect(admitted.ok).toBe(true);
    // The gate holds one running row under the dispatch id the build session
    // was told to adopt.
    const status = await harness.instance.status(NOW);
    expect(status.running.map((run: { turnId: string }) => run.turnId)).toEqual(
      [admitted.response.dispatch.dispatchId],
    );

    const replayed = await withNow(NOW, () =>
      harness.instance.submit({ request, now: NOW }),
    );
    expect(replayed.ok).toBe(true);
    expect((await harness.instance.status(NOW)).running).toHaveLength(1);
  });

  test("a chat dispatch takes no admission here: the conversation object owns it", async () => {
    const harness = open(OwnerGate);
    for (let index = 0; index < 3; index += 1) {
      const result = await withNow(NOW, () =>
        harness.instance.submit({
          request: submitBody({
            ingress: "browser",
            subject: "cloud",
            requestingDeviceId: undefined,
          }),
          now: NOW,
        }),
      );
      expect(result.response.dispatch.state).toBe("cloud_running");
    }
    expect(harness.forwarded).toHaveLength(3);
    const status = await harness.instance.status(NOW);
    expect(status.running).toHaveLength(0);
  });

  test("a chat run placed on the owner's own computer costs the cloud windows nothing", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, { snapshot: snapshotWith([desk]) });
    await withNow(NOW, () => harness.connect(desk));
    const placed = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "desktop",
          subject: "computer",
          requestingDeviceId: "desk-1",
        }),
        now: NOW,
      }),
    );
    expect(placed.response.dispatch.state).toBe("computer_accepted");
    const status = await harness.instance.status(NOW);
    expect(status.running).toHaveLength(0);
    expect(harness.forwarded).toHaveLength(0);
  });

  test("refuses a stale owner generation from a service caller", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const refused = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "schedule", subject: "cloud" }),
        expectedGeneration: "generation-0",
        now: NOW,
      }),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "generation_stale" },
    });
  });
});

describe("claim, ack, and completion", () => {
  const offered = async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const result = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    return {
      harness,
      socket,
      dispatchId: result.response.dispatch.dispatchId as string,
    };
  };

  test("a claim fences the dispatch, withdraws the other offers, and leases", async () => {
    const desk1 = await generateDeviceKey("desk-1");
    const desk2 = await generateDeviceKey("desk-2");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk1, desk2], ["desk-1", "desk-2"]),
    });
    const first = await withNow(NOW, () => harness.connect(desk1));
    const second = await withNow(NOW, () => harness.connect(desk2));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    // The proof binds one desktop, so only the granted one is offered.
    expect(lastFrame(second.socket, "offer")).toBeUndefined();

    const dispatchId = submitted.response.dispatch.dispatchId;
    await withNow(NOW + 100, () =>
      harness.sendFrame(first.socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    expect(lastFrame(first.socket, "claimed")).toEqual({
      type: "claimed",
      dispatchId,
      claimExpiresAt: NOW + 100 + DISPATCH_CLAIM_LEASE_MS,
      replayed: false,
    });
    const status = await harness.instance.dispatchStatus(dispatchId);
    expect(status.response.dispatch).toMatchObject({
      state: "computer_claimed",
      executorDeviceId: "desk-1",
      executorPresenceSessionId: "session-desk-1",
    });
    // A repeat of the same claim is answered, not re-fenced.
    await withNow(NOW + 200, () =>
      harness.sendFrame(first.socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    expect(lastFrame(first.socket, "claimed")).toMatchObject({
      replayed: true,
    });
  });

  test("a device that was not offered the work cannot claim it", async () => {
    const desk1 = await generateDeviceKey("desk-1");
    const desk2 = await generateDeviceKey("desk-2");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk1, desk2], ["desk-1"]),
    });
    await withNow(NOW, () => harness.connect(desk1));
    const other = await withNow(NOW, () => harness.connect(desk2));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    await withNow(NOW + 100, () =>
      harness.sendFrame(other.socket, {
        type: "claim",
        dispatchId: submitted.response.dispatch.dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    expect(lastFrame(other.socket, "error")).toMatchObject({
      code: "forbidden",
    });
  });

  test("an ack accepts durably and deletes the payload for good", async () => {
    const { harness, socket, dispatchId } = await offered();
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    const status = await harness.instance.dispatchStatus(dispatchId);
    expect(status.response.dispatch).toMatchObject({
      state: "computer_accepted",
      placement: "computer",
    });
    // The desktop's own inbox is now the only copy: even a lease that lapses
    // must not put those bytes back on the wire.
    await withNow(NOW + 200 + DISPATCH_ACCEPTED_LEASE_MS + 1, () =>
      harness.instance.alarm(),
    );
    const reconciling = await harness.instance.dispatchStatus(dispatchId);
    expect(reconciling.response.dispatch.state).toBe("reconciliation_required");
    // Exactly one `offer` frame ever carried those bytes.
    expect(socket.sent.filter((frame) => frame.type === "offer")).toHaveLength(
      1,
    );
  });

  test("running, renew, and complete walk the dispatch to a terminal state", async () => {
    const { harness, socket, dispatchId } = await offered();
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    await withNow(NOW + 300, () =>
      harness.sendFrame(socket, { type: "running", dispatchId }),
    );
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch
        .state,
    ).toBe("computer_running");
    await withNow(NOW + 400, () =>
      harness.sendFrame(socket, { type: "renew", dispatchId }),
    );
    await withNow(NOW + 500, () =>
      harness.sendFrame(socket, {
        type: "complete",
        dispatchId,
        outcome: "completed",
      }),
    );
    const done = await harness.instance.dispatchStatus(dispatchId);
    expect(done.response.dispatch.state).toBe("completed");
    // The slot and the owner-gate admission both came back.
    expect(
      (await harness.instance.devices(NOW + 500)).devices[0].availability
        .chatSlots,
    ).toBe(1);
    expect((await harness.instance.status(NOW + 500)).running).toHaveLength(0);
  });

  test("another session cannot move work it does not own", async () => {
    const { harness, socket, dispatchId } = await offered();
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    // Reconnect: same device, new presence session, no claim of its own.
    const desk = await generateDeviceKey("desk-1");
    const reconnected = await withNow(NOW + 300, () =>
      harness.connect(
        { ...desk, deviceId: "desk-1" },
        { presenceSessionId: "session-new" },
      ),
    );
    // The new socket cannot prove itself (a fresh key), so it is closed.
    expect(reconnected.socket.closes[0]!.code).toBe(4403);
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch
        .state,
    ).toBe("computer_accepted");
  });

  test("a release before acceptance takes the policy's fallback immediately", async () => {
    const { harness, socket, dispatchId } = await offered();
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    // Still inside the offer window: the only candidate has declined, so the
    // dispatch does not sit and wait for a deadline it cannot beat.
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, {
        type: "release",
        dispatchId,
        reason: "busy",
      }),
    );
    const status = await harness.instance.dispatchStatus(dispatchId);
    expect(status.response.dispatch).toMatchObject({
      state: "cloud_running",
      placement: "cloud",
      cloudTurnId: "turn-conversation-1",
    });
    expect(status.response.dispatch.fallbackReason).toContain(
      "computer-claim-released:busy",
    );
    expect(
      (await harness.instance.devices(NOW)).devices[0].availability.chatSlots,
    ).toBe(1);
  });

  test("a release cannot reroute work the computer already accepted", async () => {
    const { harness, socket, dispatchId } = await offered();
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    await withNow(NOW + 300, () =>
      harness.sendFrame(socket, { type: "release", dispatchId }),
    );
    expect(lastFrame(socket, "error")).toMatchObject({ code: "conflict" });
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch
        .state,
    ).toBe("computer_accepted");
  });
});

describe("the cloud branch", () => {
  test("a chat fallback sends the exact orchestrator turn the contract names", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          payload: {
            schemaVersion: 1,
            prompt: "Summarize my notes",
            conversationId: "conversation-1",
            clientMsgId: "client-msg-0001",
            locale: "es",
            attachments: ["Photos/a.png"],
          },
        }),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    expect(harness.forwarded).toHaveLength(0);

    await withNow(NOW + DISPATCH_OFFER_WINDOW_MS + 1, () =>
      harness.instance.alarm(),
    );
    expect(harness.forwarded).toHaveLength(1);
    const call = harness.forwarded[0]!;
    expect(call.namespace).toBe("orchestrator");
    expect(call.name).toBe("conversation-1");
    expect(call.url).toBe("https://orchestrator-session/turn");
    expect(call.headers).toMatchObject({
      "x-stella-owner": "owner-1",
      "x-stella-turn-auth": "service",
      "x-stella-conversation-id": "conversation-1",
      "x-stella-owner-generation": "generation-1",
    });
    expect(call.body).toEqual({
      protocol: 1,
      clientMsgId: dispatchId,
      prompt: "Summarize my notes",
      lane: "chat",
      source: "placement",
      locale: "es",
      attachments: ["Photos/a.png"],
    });
    const status = await harness.instance.dispatchStatus(dispatchId);
    expect(status.response.dispatch).toMatchObject({
      state: "cloud_running",
      placement: "cloud",
      cloudTurnId: "turn-conversation-1",
      fallbackReason: "computer-offer-expired-unaccepted",
    });
  });

  test("a schedule ingress names itself as the source", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "schedule", subject: "cloud" }),
        expectedGeneration: "generation-1",
        now: NOW,
      }),
    );
    expect((harness.forwarded[0]!.body as { source: string }).source).toBe(
      "schedule",
    );
  });

  test("an agent dispatch starts a fresh build session with the gate marker", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          kind: "agent",
          ingress: "browser",
          subject: "cloud",
          requiredCapabilities: [],
          parentTurnId: "parent-turn-1",
          payload: {
            schemaVersion: 1,
            prompt: "Rename the screenshots",
            conversationId: "conversation-1",
            clientMsgId: "client-msg-0001",
            description: "Rename screenshots",
          },
        }),
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    const call = harness.forwarded[0]!;
    expect(call.namespace).toBe("build");
    expect(call.url).toBe("https://build-session/turn");
    expect(call.headers["x-stella-gate-admitted"]).toBe("1");
    expect(call.name).toMatch(/^thr-/);
    expect(call.body).toEqual({
      protocol: 1,
      kind: "agent",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      threadId: call.name,
      agentDepth: 1,
      attemptGeneration: 1,
      turnId: dispatchId,
      prompt: "Rename the screenshots",
      description: "Rename screenshots",
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      },
      audience: "pro",
      budgetMicroCents: 250_000_000,
      source: "placement",
      clientMsgId: dispatchId,
      parentTurnId: "parent-turn-1",
    });
    expect(submitted.response.dispatch).toMatchObject({
      state: "cloud_running",
      cloudThreadId: call.name,
    });
  });

  test("a refused cloud start fails the dispatch with the builder's own code", async () => {
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([]),
      respond: () =>
        Response.json(
          {
            error: {
              code: "owner_purged",
              message: "This account's cloud data is no longer available.",
              retryable: false,
            },
          },
          { status: 410 },
        ),
    });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "browser", subject: "cloud" }),
        now: NOW,
      }),
    );
    expect(submitted.response.dispatch).toMatchObject({
      state: "failed",
      errorCode: "owner_purged",
      errorMessage: "This account's cloud data is no longer available.",
    });
    expect((await harness.instance.status(NOW)).running).toHaveLength(0);
  });

  test("the chat start carries no gate-admitted marker: it is admitted there", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "browser",
          subject: "cloud",
          requestingDeviceId: undefined,
        }),
        now: NOW,
      }),
    );
    expect(harness.forwarded[0]!.headers).not.toHaveProperty(
      "x-stella-gate-admitted",
    );
  });

  test("each refusal the orchestrator returns becomes the dispatch's own error", async () => {
    for (const [status, code] of [
      [410, "owner_purged"],
      [409, "idempotency_conflict"],
      [403, "generation_stale"],
    ] as const) {
      const harness = open(OwnerGate, {
        snapshot: snapshotWith([]),
        respond: () =>
          Response.json(
            { error: { code, message: `refused: ${code}`, retryable: false } },
            { status },
          ),
      });
      const submitted = await withNow(NOW, () =>
        harness.instance.submit({
          request: submitBody({
            ingress: "browser",
            subject: "cloud",
            requestingDeviceId: undefined,
          }),
          now: NOW,
        }),
      );
      expect(submitted.response.dispatch).toMatchObject({
        state: "failed",
        errorCode: code,
        errorMessage: `refused: ${code}`,
      });
      // One attempt only: a refusal is an answer, not a lost message.
      expect(harness.forwarded).toHaveLength(1);
    }
  });

  test("an unavailable builder is retried once and then fails", async () => {
    let attempts = 0;
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([]),
      respond: () => {
        attempts += 1;
        return Response.json(
          {
            error: {
              code: "internal",
              message: "Stella can't start turns right now.",
              retryable: true,
            },
          },
          { status: 503 },
        );
      },
    });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "browser",
          subject: "cloud",
          requestingDeviceId: undefined,
        }),
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    expect(submitted.response.dispatch.state).toBe("cloud_committed");
    expect(attempts).toBe(1);

    await withNow(NOW + DISPATCH_CLOUD_RETRY_DELAY_MS, () =>
      harness.instance.alarm(),
    );
    expect(attempts).toBe(2);
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch,
    ).toMatchObject({ state: "failed", errorCode: "internal" });
  });

  test("a retry that succeeds clears the refusal that preceded it", async () => {
    let attempts = 0;
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([]),
      respond: (call) => {
        attempts += 1;
        return attempts === 1
          ? Response.json(
              { error: { code: "internal", message: "busy", retryable: true } },
              { status: 503 },
            )
          : Response.json(
              {
                protocol: 1,
                conversationId: call.name,
                turnId: "turn-retried",
                accepted: true,
                replayed: false,
                createdConversation: false,
              },
              { status: 202 },
            );
      },
    });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "browser",
          subject: "cloud",
          requestingDeviceId: undefined,
        }),
        now: NOW,
      }),
    );
    await withNow(NOW + DISPATCH_CLOUD_RETRY_DELAY_MS, () =>
      harness.instance.alarm(),
    );
    const dispatch = (
      await harness.instance.dispatchStatus(
        submitted.response.dispatch.dispatchId,
      )
    ).response.dispatch;
    expect(dispatch).toMatchObject({
      state: "cloud_running",
      cloudTurnId: "turn-retried",
    });
    expect(dispatch.errorCode).toBeUndefined();
  });

  test("work needing a local capability fails rather than pretending the cloud has it", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          ingress: "browser",
          subject: "cloud",
          requestingDeviceId: undefined,
          requiredCapabilities: ["chat", "local-files"],
        }),
        now: NOW,
      }),
    );
    expect(submitted.response.dispatch).toMatchObject({
      state: "failed",
      errorCode: "CLOUD_CAPABILITY_UNAVAILABLE",
    });
    expect(harness.forwarded).toHaveLength(0);
  });

  test("an ambiguous transport failure leaves the dispatch to reconcile", async () => {
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([]),
      respond: () => {
        throw new Error("connection reset");
      },
    });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "browser", subject: "cloud" }),
        now: NOW,
      }),
    );
    expect(submitted.response.dispatch.state).toBe("cloud_committed");
    await withNow(NOW + DISPATCH_ACCEPTED_LEASE_MS + 1, () =>
      harness.instance.alarm(),
    );
    expect(
      (
        await harness.instance.dispatchStatus(
          submitted.response.dispatch.dispatchId,
        )
      ).response.dispatch.state,
    ).toBe("reconciliation_required");
  });
});

describe("cancellation", () => {
  test("cancels an unclaimed offer outright and withdraws it", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    const canceled = await harness.instance.cancelDispatch({
      dispatchId,
      cancelRequestId: "cancel-1",
      reason: "user stopped",
      now: NOW + 100,
    });
    expect(canceled.response.dispatch).toMatchObject({
      state: "canceled",
      cancelRequestId: "cancel-1",
      cancelReason: "user stopped",
    });
    expect(lastFrame(socket, "offer.withdrawn")).toMatchObject({
      dispatchId,
      reason: "canceled",
    });
    expect(harness.forwarded).toHaveLength(0);
  });

  test("a device-placed run gets a cancel frame and stays pending until its terminal", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    const canceled = await harness.instance.cancelDispatch({
      dispatchId,
      cancelRequestId: "cancel-1",
      now: NOW + 300,
    });
    expect(canceled.response.dispatch.state).toBe("cancel_pending");
    expect(lastFrame(socket, "cancel")).toEqual({
      type: "cancel",
      dispatchId,
      cancelRequestId: "cancel-1",
      reason: "The turn was stopped.",
    });
    await withNow(NOW + 400, () =>
      harness.sendFrame(socket, {
        type: "complete",
        dispatchId,
        outcome: "canceled",
      }),
    );
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch
        .state,
    ).toBe("canceled");
  });

  test("a cloud-placed chat run is stopped by an exact turn cancellation", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "browser", subject: "cloud" }),
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    const canceled = await harness.instance.cancelDispatch({
      dispatchId,
      cancelRequestId: "cancel-1",
      reason: "user stopped",
      now: NOW + 100,
    });
    expect(canceled.response.dispatch.state).toBe("cancel_pending");
    const call = harness.forwarded.at(-1)!;
    expect(call.url).toBe("https://orchestrator-session/cancel");
    expect(call.body).toEqual({
      turnId: "turn-conversation-1",
      cancelRequestId: "cancel-1",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      reason: "user stopped",
    });
  });

  test("a cloud-placed agent run is stopped on its build session with an attempt", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({
          kind: "agent",
          ingress: "browser",
          subject: "cloud",
          requiredCapabilities: [],
          payload: {
            schemaVersion: 1,
            prompt: "Rename the screenshots",
            conversationId: "conversation-1",
            clientMsgId: "client-msg-0001",
            description: "Rename screenshots",
          },
        }),
        now: NOW,
      }),
    );
    const threadId = harness.forwarded[0]!.name;
    await harness.instance.cancelDispatch({
      dispatchId: submitted.response.dispatch.dispatchId,
      cancelRequestId: "cancel-1",
      now: NOW + 100,
    });
    const call = harness.forwarded.at(-1)!;
    expect(call.namespace).toBe("build");
    expect(call.name).toBe(threadId);
    expect(call.url).toBe("https://build-session/cancel");
    expect(call.body).toMatchObject({ attemptGeneration: 1 });
  });

  test("a second cancellation request cannot take over the dispatch", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody({ ingress: "browser", subject: "cloud" }),
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    await harness.instance.cancelDispatch({
      dispatchId,
      cancelRequestId: "cancel-1",
      now: NOW + 100,
    });
    expect(
      await harness.instance.cancelDispatch({
        dispatchId,
        cancelRequestId: "cancel-2",
        now: NOW + 200,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  test("an unknown dispatch id is not found", async () => {
    const harness = open(OwnerGate, { snapshot: snapshotWith([]) });
    expect(await harness.instance.dispatchStatus("dsp:missing")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("leases and projections", () => {
  test("a claim that is never acked returns the dispatch to the fallback", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 100 + DISPATCH_CLAIM_LEASE_MS + 1, () =>
      harness.instance.alarm(),
    );
    const status = await harness.instance.dispatchStatus(dispatchId);
    expect(status.response.dispatch).toMatchObject({
      state: "cloud_running",
      fallbackReason: "computer-claim-expired",
    });
  });

  test("every transition bumps the revision and projects it exactly once", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    for (const [at, frame] of [
      [NOW + 100, { type: "claim", dispatchId, claimRequestId: "claim-1" }],
      [NOW + 200, { type: "ack", dispatchId }],
      [NOW + 300, { type: "running", dispatchId }],
      [NOW + 400, { type: "complete", dispatchId, outcome: "completed" }],
    ] as const) {
      await withNow(at, () => harness.sendFrame(socket, frame as never));
    }
    const projections = harness.outbox.filter(
      (event) => event.kind === "dispatch.updated",
    ) as Array<{
      key: string;
      ownerId: string;
      ownerGeneration: string;
      dispatchId: string;
      dispatch: { revision: number; state: string };
    }>;
    expect(projections.map((event) => event.dispatch.state)).toEqual([
      "offering",
      "computer_claimed",
      "computer_accepted",
      "computer_running",
      "completed",
    ]);
    expect(projections.map((event) => event.dispatch.revision)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(projections.map((event) => event.key)).toEqual(
      [1, 2, 3, 4, 5].map((revision) => `${dispatchId}:${revision}`),
    );
    expect(new Set(projections.map((event) => event.ownerId))).toEqual(
      new Set(["owner-1"]),
    );
    expect(new Set(projections.map((event) => event.ownerGeneration))).toEqual(
      new Set(["generation-1"]),
    );
  });

  test("the payload's own ttl clears the bytes without moving the dispatch", async () => {
    const desk = await generateDeviceKey("desk-1");
    const harness = open(OwnerGate, {
      snapshot: snapshotWith([desk], ["desk-1"]),
    });
    const { socket } = await withNow(NOW, () => harness.connect(desk));
    const submitted = await withNow(NOW, () =>
      harness.instance.submit({
        request: submitBody(),
        pairGrantDeviceId: "desk-1",
        now: NOW,
      }),
    );
    const dispatchId = submitted.response.dispatch.dispatchId;
    await withNow(NOW + 100, () =>
      harness.sendFrame(socket, {
        type: "claim",
        dispatchId,
        claimRequestId: "claim-1",
      }),
    );
    await withNow(NOW + 200, () =>
      harness.sendFrame(socket, { type: "ack", dispatchId }),
    );
    await withNow(NOW + 300, () =>
      harness.sendFrame(socket, { type: "running", dispatchId }),
    );
    // Renew keeps it alive well past the payload ttl.
    await withNow(NOW + 900_000, () =>
      harness.sendFrame(socket, { type: "renew", dispatchId }),
    );
    await withNow(NOW + 900_100, () => harness.instance.alarm());
    expect(
      (await harness.instance.dispatchStatus(dispatchId)).response.dispatch
        .state,
    ).toBe("computer_running");
  });
});
