import { describe, expect, test } from "bun:test";
import {
  DEVICE_PRESENCE_STALE_AFTER_MS,
  PLACEMENT_PROTOCOL,
  type ExecutionIngress,
  type ExecutionSubject,
  type ExecutionTargetMode,
} from "@stella/contracts/turn-plane/placement";
import {
  cloudUnsupportedCapabilities,
  decideDispatchPlacement,
  dispatchErrorResponse,
  isEligibleDevice,
  mayFallbackToCloud,
  parseDispatchSubmitRequest,
  type DevicePresenceState,
  type DeviceRegistration,
} from "../src/dispatch-policy.js";

/**
 * The routing matrix ported from Convex's `decideServerExecutionPlacement`,
 * case for case. Reachability deliberately never appears here: an
 * `offer` decision is resolved later by a fenced claim, so this table stays
 * true whether or not a computer is online.
 */

const NOW = 1_800_000_000_000;

const decide = (
  ingress: ExecutionIngress,
  subject: ExecutionSubject,
  targetMode?: ExecutionTargetMode,
) => decideDispatchPlacement({ ingress, subject, targetMode });

describe("decideDispatchPlacement", () => {
  test("an explicit cloud choice wins over every other signal", () => {
    for (const ingress of [
      "desktop",
      "mobile",
      "browser",
      "cloud",
      "schedule",
    ] as const) {
      for (const subject of ["portable", "computer", "cloud"] as const) {
        expect(decide(ingress, subject, "cloud")).toEqual({
          kind: "commit",
          placement: "cloud",
          reason: "explicit-cloud",
        });
      }
    }
  });

  test("an explicit device choice offers and never falls back", () => {
    expect(decide("browser", "cloud", "device")).toEqual({
      kind: "offer",
      onNoEligibleComputer: "blocked",
      reason: "explicit-device",
    });
    expect(decide("desktop", "portable", "device")).toEqual({
      kind: "offer",
      onNoEligibleComputer: "blocked",
      reason: "explicit-device",
    });
  });

  test("a hosted subject commits to cloud before ingress is consulted", () => {
    expect(decide("desktop", "cloud")).toEqual({
      kind: "commit",
      placement: "cloud",
      reason: "hosted-subject",
    });
    expect(decide("mobile", "cloud", "automatic")).toEqual({
      kind: "commit",
      placement: "cloud",
      reason: "hosted-subject",
    });
  });

  test("desktop ingress keeps its own work", () => {
    expect(decide("desktop", "portable")).toEqual({
      kind: "commit",
      placement: "computer",
      reason: "desktop-ingress",
    });
    expect(decide("desktop", "computer")).toEqual({
      kind: "commit",
      placement: "computer",
      reason: "desktop-ingress",
    });
  });

  test("mobile prefers a paired computer and falls back to cloud", () => {
    expect(decide("mobile", "portable")).toEqual({
      kind: "offer",
      onNoEligibleComputer: "cloud",
      reason: "paired-computer-preferred",
    });
    expect(decide("mobile", "computer")).toEqual({
      kind: "offer",
      onNoEligibleComputer: "cloud",
      reason: "paired-computer-preferred-for-computer-work",
    });
  });

  test("a deviceless ingress that still names computer work is blocked", () => {
    for (const ingress of ["browser", "cloud", "schedule"] as const) {
      expect(decide(ingress, "computer")).toEqual({
        kind: "blocked",
        reason: "computer-unavailable-for-ingress",
      });
    }
  });

  test("everything else is ordinary cloud work, labelled by its ingress", () => {
    expect(decide("browser", "portable")).toEqual({
      kind: "commit",
      placement: "cloud",
      reason: "browser-ingress",
    });
    expect(decide("schedule", "portable")).toEqual({
      kind: "commit",
      placement: "cloud",
      reason: "schedule-ingress",
    });
  });
});

describe("mayFallbackToCloud", () => {
  test("only unaccepted local work may be rerouted", () => {
    expect(mayFallbackToCloud("offering")).toBe(true);
    expect(mayFallbackToCloud("computer_claimed")).toBe(true);
    for (const state of [
      "computer_accepted",
      "computer_running",
      "cloud_running",
      "reconciliation_required",
      "completed",
    ] as const) {
      expect(mayFallbackToCloud(state)).toBe(false);
    }
  });
});

describe("isEligibleDevice", () => {
  const presence = (
    overrides: Partial<DevicePresenceState> = {},
  ): DevicePresenceState => ({
    deviceId: "desk-1",
    presenceSessionId: "session-1",
    connected: true,
    ready: true,
    chatSlots: 1,
    agentSlots: 1,
    capabilities: ["chat", "agent", "attachments"],
    protocolVersion: 1,
    lastSeenAt: NOW,
    ...overrides,
  });
  const device = (
    overrides: Partial<DeviceRegistration> = {},
  ): DeviceRegistration => ({
    deviceId: "desk-1",
    publicKey: "key",
    remoteExecutionEnabled: true,
    ...overrides,
  });
  const eligible = (
    presenceOverrides: Partial<DevicePresenceState> = {},
    deviceOverrides: Partial<DeviceRegistration> | null = {},
    required: Parameters<typeof isEligibleDevice>[0]["requiredCapabilities"] = [
      "chat",
    ],
  ) =>
    isEligibleDevice({
      presence: presence(presenceOverrides),
      device: deviceOverrides === null ? undefined : device(deviceOverrides),
      kind: "chat",
      requiredCapabilities: required,
      now: NOW,
      staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
    });

  test("accepts an online, ready, capable device with a free slot", () => {
    expect(eligible()).toBe(true);
  });

  test("rejects every missing precondition on its own", () => {
    expect(eligible({ connected: false })).toBe(false);
    expect(eligible({ ready: false })).toBe(false);
    expect(eligible({ chatSlots: 0 })).toBe(false);
    expect(eligible({ protocolVersion: 2 })).toBe(false);
    expect(eligible({ lastSeenAt: NOW - DEVICE_PRESENCE_STALE_AFTER_MS })).toBe(
      false,
    );
    expect(eligible({}, { remoteExecutionEnabled: false })).toBe(false);
    expect(eligible({}, null)).toBe(false);
    expect(eligible({}, {}, ["chat", "local-files"])).toBe(false);
    expect(
      isEligibleDevice({
        presence: undefined,
        device: device(),
        kind: "chat",
        requiredCapabilities: [],
        now: NOW,
        staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  test("counts the slot of the kind being placed", () => {
    const args = {
      presence: presence({ chatSlots: 0, agentSlots: 2 }),
      device: device(),
      requiredCapabilities: [] as never[],
      now: NOW,
      staleAfterMs: DEVICE_PRESENCE_STALE_AFTER_MS,
    };
    expect(isEligibleDevice({ ...args, kind: "chat" })).toBe(false);
    expect(isEligibleDevice({ ...args, kind: "agent" })).toBe(true);
  });
});

describe("cloudUnsupportedCapabilities", () => {
  test("names only what a sandbox cannot provide", () => {
    expect(
      cloudUnsupportedCapabilities(["chat", "agent", "attachments"]),
    ).toEqual([]);
    expect(
      cloudUnsupportedCapabilities(["chat", "local-files", "computer-use"]),
    ).toEqual(["local-files", "computer-use"]);
  });
});

describe("parseDispatchSubmitRequest", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    protocol: PLACEMENT_PROTOCOL,
    idempotencyKey: "idem-0001-abcd",
    kind: "chat",
    ingress: "browser",
    subject: "cloud",
    conversationId: "conversation-1",
    requiredCapabilities: [],
    payload: {
      schemaVersion: 1,
      prompt: "Hello there",
      conversationId: "conversation-1",
      clientMsgId: "client-msg-0001",
    },
    ...overrides,
  });

  test("accepts a well-formed request and adds the kind as a capability", () => {
    const parsed = parseDispatchSubmitRequest(body());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.requiredCapabilities).toEqual(["chat"]);
    expect(parsed.request.payload.prompt).toBe("Hello there");
    expect(parsed.request.targetMode).toBeUndefined();
  });

  test("refuses a deviceless ingress that claims a local subject", () => {
    expect(
      parseDispatchSubmitRequest(
        body({ ingress: "browser", subject: "computer" }),
      ),
    ).toEqual({
      ok: false,
      message: "browser ingress cannot claim a local execution subject.",
    });
    expect(
      parseDispatchSubmitRequest(
        body({ ingress: "mobile", subject: "computer" }),
      ).ok,
    ).toBe(true);
  });

  test("requires exactly one device id for a device target", () => {
    expect(parseDispatchSubmitRequest(body({ targetMode: "device" })).ok).toBe(
      false,
    );
    expect(
      parseDispatchSubmitRequest(body({ targetDeviceId: "desk-1" })).ok,
    ).toBe(false);
    expect(
      parseDispatchSubmitRequest(
        body({ targetMode: "device", targetDeviceId: "desk-1" }),
      ).ok,
    ).toBe(true);
  });

  test("binds the payload's conversation to the dispatch's", () => {
    expect(
      parseDispatchSubmitRequest(
        body({
          payload: {
            schemaVersion: 1,
            prompt: "hi",
            conversationId: "other",
            clientMsgId: "client-msg-0001",
          },
        }),
      ),
    ).toEqual({
      ok: false,
      message: "payload.conversationId does not match the dispatch.",
    });
  });

  test("an agent dispatch needs a bounded description", () => {
    const agent = (description: unknown) =>
      parseDispatchSubmitRequest(
        body({
          kind: "agent",
          payload: {
            schemaVersion: 1,
            prompt: "do the thing",
            conversationId: "conversation-1",
            clientMsgId: "client-msg-0001",
            description,
          },
        }),
      );
    expect(agent("Rename the files").ok).toBe(true);
    expect(agent(undefined).ok).toBe(false);
    expect(agent("x".repeat(1_001)).ok).toBe(false);
  });

  test("rejects malformed protocol, keys, capabilities, and attachments", () => {
    expect(parseDispatchSubmitRequest(body({ protocol: 2 })).ok).toBe(false);
    expect(
      parseDispatchSubmitRequest(body({ idempotencyKey: "short" })).ok,
    ).toBe(false);
    expect(parseDispatchSubmitRequest(body({ kind: "app" })).ok).toBe(false);
    expect(
      parseDispatchSubmitRequest(body({ requiredCapabilities: ["teleport"] }))
        .ok,
    ).toBe(false);
    expect(
      parseDispatchSubmitRequest(
        body({
          payload: {
            schemaVersion: 1,
            prompt: "hi",
            conversationId: "conversation-1",
            clientMsgId: "client-msg-0001",
            attachments: ["a", "b", "c", "d", "e"],
          },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("dispatchErrorResponse", () => {
  test("maps each refusal to the status the contract promises", async () => {
    const status = (code: Parameters<typeof dispatchErrorResponse>[0]) =>
      dispatchErrorResponse(code, "nope", false).status;
    expect(status("unauthorized")).toBe(401);
    expect(status("forbidden")).toBe(403);
    expect(status("bad_request")).toBe(400);
    expect(status("conflict")).toBe(409);
    expect(status("not_found")).toBe(404);
    expect(status("owner_purged")).toBe(410);
    expect(status("generation_stale")).toBe(403);
    expect(status("capability_unavailable")).toBe(409);
    expect(status("internal")).toBe(503);

    const retryable = dispatchErrorResponse(
      "internal",
      "try again",
      true,
      4_500,
    );
    expect(retryable.headers.get("retry-after")).toBe("5");
    expect(await retryable.json()).toEqual({
      error: {
        code: "internal",
        message: "try again",
        retryable: true,
        retryAfterMs: 4_500,
      },
    });
  });
});
