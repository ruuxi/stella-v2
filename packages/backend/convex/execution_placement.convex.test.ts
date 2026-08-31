/// <reference types="vite/client" />

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|placement-owner";
const ownerGeneration = "legacy";
const deviceId = "desktop-placement-test";
const mobileDeviceId = "mobile-placement-test";
const protocolVersion = 1;

const refs = {
  identity: makeFunctionReference<"query">(
    "execution_placement:getMyExecutionPlacementIdentity",
  ),
  register: makeFunctionReference<"mutation">(
    "execution_placement:registerMyExecutionPresence",
  ),
  heartbeat: makeFunctionReference<"mutation">(
    "execution_placement:heartbeatMyExecutionPresence",
  ),
  connectSocket: makeFunctionReference<"mutation">(
    "execution_placement:connectMyExecutionPresenceSocket",
  ),
  socketCurrent: makeFunctionReference<"query">(
    "execution_placement:isExecutionPresenceSocketCurrentInternal",
  ),
  confirmSocket: makeFunctionReference<"mutation">(
    "execution_placement:confirmExecutionPresenceSocketInternal",
  ),
  disconnectSocket: makeFunctionReference<"mutation">(
    "execution_placement:disconnectExecutionPresenceSocketInternal",
  ),
  clear: makeFunctionReference<"mutation">(
    "execution_placement:clearMyExecutionPresence",
  ),
  offers: makeFunctionReference<"query">(
    "execution_placement:listMyExecutionOffers",
  ),
  accepted: makeFunctionReference<"query">(
    "execution_placement:listMyAcceptedExecutionDispatches",
  ),
  claim: makeFunctionReference<"mutation">(
    "execution_placement:claimMyExecutionOffer",
  ),
  release: makeFunctionReference<"mutation">(
    "execution_placement:releaseMyExecutionClaim",
  ),
  ack: makeFunctionReference<"mutation">(
    "execution_placement:ackMyExecutionClaim",
  ),
  complete: makeFunctionReference<"mutation">(
    "execution_placement:completeMyExecutionDispatch",
  ),
  status: makeFunctionReference<"query">(
    "execution_placement:getMyExecutionDispatchStatus",
  ),
  submitBrowser: makeFunctionReference<"mutation">(
    "execution_placement:submitMyBrowserExecution",
  ),
  submitDesktop: makeFunctionReference<"mutation">(
    "execution_placement:submitMyDesktopExecution",
  ),
  destinations: makeFunctionReference<"query">(
    "execution_placement:listMyExecutionDestinations",
  ),
  setRemoteEnabled: makeFunctionReference<"mutation">(
    "execution_placement:setMyExecutionDeviceRemoteEnabled",
  ),
  submitInternal: makeFunctionReference<"mutation">(
    "execution_placement:submitExecutionDispatchInternal",
  ),
  resolveDeadline: makeFunctionReference<"mutation">(
    "execution_placement:resolveOfferDeadlineInternal",
  ),
  reconcile: makeFunctionReference<"mutation">(
    "execution_placement:reconcileExecutionPlacementInternal",
  ),
  markCloudAttempted: makeFunctionReference<"mutation">(
    "execution_placement:markCloudExecutionAttemptedInternal",
  ),
  markCloudStarted: makeFunctionReference<"mutation">(
    "execution_placement:markCloudExecutionStartedInternal",
  ),
  markCloudFailed: makeFunctionReference<"mutation">(
    "execution_placement:markCloudExecutionFailedInternal",
  ),
  startCloudChat: makeFunctionReference<"mutation">(
    "cloud_apps:startCloudChatTurnInternal",
  ),
  startCloudComposer: makeFunctionReference<"mutation">(
    "cloud_apps:startCloudComposerTurnInternal",
  ),
  executeCloud: makeFunctionReference<"action">(
    "execution_placement:executeCloudCommittedDispatchInternal",
  ),
  resolveCanceledCloudAdmission: makeFunctionReference<"mutation">(
    "cloud_apps:resolveCanceledExecutionPlacementAdmissionInternal",
  ),
  cancel: makeFunctionReference<"mutation">(
    "execution_placement:cancelMyExecutionDispatch",
  ),
  beginOwnerPurge: makeFunctionReference<"mutation">(
    "owner_lifecycle:beginOwnerDataPurgeInternal",
  ),
  quiesceOwnerPlacement: makeFunctionReference<"mutation">(
    "execution_placement:quiesceOwnerExecutionPlacementForPurgeInternal",
  ),
  quiesceOwnerPlacementMigration: makeFunctionReference<"mutation">(
    "execution_placement:quiesceOwnerExecutionPlacementForMigrationInternal",
  ),
  cloudCancellationInput: makeFunctionReference<"query">(
    "execution_placement:getCloudCancellationInputInternal",
  ),
  spawnCloudAgent: makeFunctionReference<"mutation">(
    "cloud_apps:spawnCloudAgentInternal",
  ),
  cancelCloudAgent: makeFunctionReference<"action">(
    "cloud_apps:cancelMyCloudAgentThread",
  ),
  cancelCloudDispatch: makeFunctionReference<"action">(
    "execution_placement:cancelCloudExecutionDispatchInternal",
  ),
};

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hashBody = (parts: readonly unknown[]) => sha256(JSON.stringify(parts));

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
type TestHarness = ReturnType<typeof createTest>;

const asOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "placement-owner",
    tokenIdentifier: ownerId,
    iat: 1_000,
  });

const asOtherOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "placement-other",
    tokenIdentifier: "https://issuer.test|placement-other",
    iat: 1_000,
  });

const anonymousOwnerId = "https://issuer.test|placement-anonymous";
const asAnonymousOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "placement-anonymous",
    tokenIdentifier: anonymousOwnerId,
    isAnonymous: true,
    iat: 1_000,
  });

type ProofOperation =
  | "presence-register"
  | "presence-heartbeat"
  | "presence-socket-connect"
  | "presence-clear"
  | "execution-submit"
  | "claim"
  | "claim-release"
  | "claim-ack"
  | "complete";

const createDeviceProofs = (proofDeviceId = deviceId) => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  let sequence = 0;
  const presenceSessionId = `presence-${crypto.randomUUID()}`;
  const proof = (operation: ProofOperation, bodyHash: string) => {
    sequence += 1;
    const message = JSON.stringify([
      "stella-execution-placement",
      protocolVersion,
      operation,
      ownerGeneration,
      proofDeviceId,
      presenceSessionId,
      sequence,
      bodyHash,
    ]);
    return {
      sequence,
      bodyHash,
      signature: sign(null, Buffer.from(message), pair.privateKey).toString(
        "base64url",
      ),
    };
  };
  return { deviceId: proofDeviceId, publicKey, presenceSessionId, proof };
};

const seedConversation = async (
  t: TestHarness,
  conversationId = "conv-placement",
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_conversations", {
      conversationId,
      ownerId,
      title: "Placement",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return conversationId;
};

const registerReadyDesktop = async (
  t: TestHarness,
  options: {
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    pairMobile?: boolean;
    extraCapabilities?: readonly string[];
    presenceTransport?: "socket";
  } = {},
) => {
  const registeredDeviceId = options.deviceId ?? deviceId;
  const signer = createDeviceProofs(registeredDeviceId);
  const capabilities = [
    ...new Set([
      "agent",
      "chat",
      "computer-use",
      "local-apps",
      "local-files",
      ...(options.extraCapabilities ?? []),
    ]),
  ].sort();
  const body = hashBody([
    signer.publicKey,
    protocolVersion,
    "test",
    capabilities,
    "ready",
    1,
    1,
    1,
    1,
    ...(options.presenceTransport ? [options.presenceTransport] : []),
    ...(options.deviceName || options.platform
      ? [options.deviceName ?? null, options.platform ?? null]
      : []),
  ]);
  await asOwner(t).mutation(refs.register, {
    ownerGeneration,
    deviceId: registeredDeviceId,
    devicePublicKey: signer.publicKey,
    presenceSessionId: signer.presenceSessionId,
    protocolVersion,
    appVersion: "test",
    ...(options.deviceName ? { deviceName: options.deviceName } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.presenceTransport
      ? { presenceTransport: options.presenceTransport }
      : {}),
    capabilities,
    status: "ready",
    chatSlotCapacity: 1,
    agentSlotCapacity: 1,
    availableChatSlots: 1,
    availableAgentSlots: 1,
    ...signer.proof("presence-register", body),
  });
  if (options.pairMobile !== false) {
    await t.run(async (ctx) => {
      await ctx.db.insert("paired_mobile_devices", {
        ownerId,
        desktopDeviceId: registeredDeviceId,
        mobileDeviceId,
        pairSecretHash: "pair-proof-is-verified-at-http-boundary",
        approvedAt: 1,
        lastSeenAt: 1,
      });
    });
  }
  return signer;
};

const submitMobile = async (
  t: TestHarness,
  args: {
    conversationId: string;
    idempotencyKey: string;
    prompt?: string;
    subject?: "portable" | "computer" | "cloud";
    attachments?: readonly string[];
    requiredCapabilities?: readonly string[];
  },
) => {
  const payloadJson = JSON.stringify({
    prompt: args.prompt ?? "hello",
    ...(args.attachments ? { attachments: args.attachments } : {}),
  });
  return await t.mutation(refs.submitInternal, {
    ownerId,
    ownerGeneration,
    idempotencyKey: args.idempotencyKey,
    payloadJson,
    payloadHash: sha256(payloadJson),
    kind: "chat",
    ingress: "mobile",
    subject: args.subject ?? "portable",
    conversationId: args.conversationId,
    requestingDeviceId: mobileDeviceId,
    pairGrantDeviceId: deviceId,
    requiredCapabilities: args.requiredCapabilities ?? [],
    now: Date.now(),
  });
};

const submitUnpairedMobile = async (
  t: TestHarness,
  args: {
    conversationId: string;
    idempotencyKey: string;
    subject?: "portable" | "computer" | "cloud";
  },
) => {
  const payloadJson = JSON.stringify({ prompt: "hello without a pair" });
  return await t.mutation(refs.submitInternal, {
    ownerId,
    ownerGeneration,
    idempotencyKey: args.idempotencyKey,
    payloadJson,
    payloadHash: sha256(payloadJson),
    kind: "chat",
    ingress: "mobile",
    subject: args.subject ?? "portable",
    conversationId: args.conversationId,
    requiredCapabilities: [],
    now: Date.now(),
  });
};

const desktopSubmitArgs = (
  signer: ReturnType<typeof createDeviceProofs>,
  args: {
    conversationId: string;
    idempotencyKey: string;
    payloadJson: string;
    requestedTargetMode: "cloud" | "device";
    requestedExecutorDeviceId?: string;
    requiredCapabilities?: readonly string[];
  },
) => {
  const payloadHash = sha256(args.payloadJson);
  const requiredCapabilities = [
    ...new Set(["chat", ...(args.requiredCapabilities ?? [])]),
  ].sort();
  const proof = signer.proof(
    "execution-submit",
    hashBody([
      args.idempotencyKey,
      payloadHash,
      "chat",
      "portable",
      args.conversationId,
      null,
      null,
      args.requestedTargetMode,
      args.requestedExecutorDeviceId ?? null,
      requiredCapabilities,
    ]),
  );
  return {
    idempotencyKey: args.idempotencyKey,
    expectedOwnerGeneration: ownerGeneration,
    ownerGeneration,
    deviceId: signer.deviceId,
    presenceSessionId: signer.presenceSessionId,
    requestedTargetMode: args.requestedTargetMode,
    ...(args.requestedExecutorDeviceId
      ? { requestedExecutorDeviceId: args.requestedExecutorDeviceId }
      : {}),
    payloadJson: args.payloadJson,
    payloadHash,
    kind: "chat",
    subject: "portable",
    conversationId: args.conversationId,
    requiredCapabilities: args.requiredCapabilities ?? ["chat"],
    ...proof,
  };
};

const submitDesktop = async (
  t: TestHarness,
  signer: ReturnType<typeof createDeviceProofs>,
  args: Parameters<typeof desktopSubmitArgs>[1],
) => {
  return await asOwner(t).mutation(
    refs.submitDesktop,
    desktopSubmitArgs(signer, args),
  );
};

const claim = async (
  t: TestHarness,
  signer: ReturnType<typeof createDeviceProofs>,
  dispatchId: string,
) => {
  const claimToken = `claim-token-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const claimRequestId = `claim:${crypto.randomUUID()}`;
  const tokenHash = sha256(claimToken);
  const proof = signer.proof(
    "claim",
    hashBody([dispatchId, claimRequestId, tokenHash]),
  );
  const result = await asOwner(t).mutation(refs.claim, {
    ownerGeneration,
    deviceId: signer.deviceId,
    presenceSessionId: signer.presenceSessionId,
    dispatchId,
    claimRequestId,
    claimToken,
    ...proof,
  });
  return { claimToken, tokenHash, result };
};

describe("automatic execution placement", () => {
  it("advertises socket presence only after the coordinated rollout switch", async () => {
    const t = createTest();
    const previousUrl = process.env.CLOUD_BUILDER_URL;
    const previousEnabled = process.env.EXECUTION_PRESENCE_SOCKET_ENABLED;
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    delete process.env.EXECUTION_PRESENCE_SOCKET_ENABLED;
    try {
      expect(await asOwner(t).query(refs.identity, {})).not.toHaveProperty(
        "presenceSocketBaseUrl",
      );
      process.env.EXECUTION_PRESENCE_SOCKET_ENABLED = "1";
      expect(await asOwner(t).query(refs.identity, {})).toMatchObject({
        presenceSocketBaseUrl: "wss://builder.example.test/execution-devices",
      });
    } finally {
      if (previousUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = previousUrl;
      if (previousEnabled === undefined) {
        delete process.env.EXECUTION_PRESENCE_SOCKET_ENABLED;
      } else {
        process.env.EXECUTION_PRESENCE_SOCKET_ENABLED = previousEnabled;
      }
    }
  });

  it("uses exact socket connection state instead of the legacy lease", async () => {
    const t = createTest();
    const signer = await registerReadyDesktop(t, {
      deviceId: "desktop-socket-presence",
      pairMobile: false,
      presenceTransport: "socket",
    });
    const destinationBefore = await asOwner(t).query(refs.destinations, {});
    expect(destinationBefore).toEqual([
      expect.objectContaining({
        deviceId: signer.deviceId,
        online: false,
        ready: false,
      }),
    ]);

    const connectionId = "presence-connection-1";
    const nonce = "presence-challenge-1";
    const connectBody = hashBody([connectionId, nonce]);
    await asOwner(t).mutation(refs.connectSocket, {
      ownerGeneration,
      deviceId: signer.deviceId,
      presenceSessionId: signer.presenceSessionId,
      connectionId,
      nonce,
      ...signer.proof("presence-socket-connect", connectBody),
    });
    const provisionalLeaseExpiresAt = await t.run(async (ctx) => {
      const presence = await ctx.db
        .query("desktop_execution_presence")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", signer.deviceId),
        )
        .unique();
      return presence!.socketLeaseExpiresAt!;
    });
    const authExpiresAtMs = Date.now() + 60_000;
    expect(
      await t.mutation(refs.confirmSocket, {
        ownerId,
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
        connectionId,
        authExpiresAtMs,
      }),
    ).toBe(true);
    expect(
      await t.mutation(refs.disconnectSocket, {
        ownerId,
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
        connectionId,
        now: provisionalLeaseExpiresAt,
        expectedLeaseExpiresAt: provisionalLeaseExpiresAt,
      }),
    ).toEqual({ disconnected: false });
    expect(
      await t.query(refs.socketCurrent, {
        ownerId,
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
        connectionId,
      }),
    ).toBe(true);
    expect(await asOwner(t).query(refs.destinations, {})).toEqual([
      expect.objectContaining({
        deviceId: signer.deviceId,
        online: true,
        ready: true,
      }),
    ]);

    expect(
      await t.mutation(refs.disconnectSocket, {
        ownerId,
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
        connectionId: "replaced-connection",
        now: Date.now(),
      }),
    ).toEqual({ disconnected: false });
    expect(
      await t.mutation(refs.disconnectSocket, {
        ownerId,
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
        connectionId,
        now: Date.now(),
      }),
    ).toEqual({ disconnected: true });
    expect(await asOwner(t).query(refs.destinations, {})).toEqual([
      expect.objectContaining({
        deviceId: signer.deviceId,
        online: false,
        ready: false,
      }),
    ]);
  });
  it("offers an explicit desktop request to exactly one selected live computer", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-desktop-exact-device",
    );
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-source",
      deviceName: "MacBook",
      platform: "darwin",
      pairMobile: false,
    });
    const unselected = await registerReadyDesktop(t, {
      deviceId: "desktop-linux",
      deviceName: "Linux PC",
      platform: "linux",
      pairMobile: false,
    });
    const selected = await registerReadyDesktop(t, {
      deviceId: "desktop-windows",
      deviceName: "Windows PC",
      platform: "win32",
      pairMobile: false,
    });

    expect(await asOwner(t).query(refs.destinations, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "desktop-windows",
          name: "Windows PC",
          online: true,
          ready: true,
          busy: false,
        }),
      ]),
    );

    const idempotencyKey = "desktop:exact-windows";
    const payloadJson = JSON.stringify({
      prompt: "Run only on Windows",
      expectedOwnerGeneration: ownerGeneration,
      conversationId,
      clientMsgId: idempotencyKey,
    });
    const dispatch = await submitDesktop(t, source, {
      idempotencyKey,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: "desktop-windows",
      payloadJson,
      conversationId,
      requiredCapabilities: ["chat"],
    });
    expect(dispatch).toMatchObject({
      state: "offering",
      requestedTargetMode: "device",
      requestedExecutorDeviceId: "desktop-windows",
    });

    const offerIds = async (signer: ReturnType<typeof createDeviceProofs>) =>
      (
        await asOwner(t).query(refs.offers, {
          deviceId: signer.deviceId,
          presenceSessionId: signer.presenceSessionId,
        })
      ).map(
        (row: { dispatch: { dispatchId: string } }) => row.dispatch.dispatchId,
      );
    expect(await offerIds(unselected)).not.toContain(dispatch.dispatchId);
    expect(await offerIds(selected)).toContain(dispatch.dispatchId);

    const claimed = await claim(t, selected, dispatch.dispatchId);
    const accepted = await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId: selected.deviceId,
      presenceSessionId: selected.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...selected.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    expect(accepted).toMatchObject({
      state: "computer_accepted",
      placement: "computer",
      executorDeviceId: "desktop-windows",
    });
  });

  it("fails an unavailable explicit computer without falling back to cloud", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-desktop-offline-device",
    );
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-source",
      pairMobile: false,
    });
    const idempotencyKey = "desktop:offline-windows";
    const payloadJson = JSON.stringify({
      prompt: "Do not run anywhere else",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await submitDesktop(t, source, {
      idempotencyKey,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: "desktop-offline",
      payloadJson,
      conversationId,
      requiredCapabilities: ["chat"],
    });
    expect(dispatch).toMatchObject({
      state: "failed",
      fallbackReason: "selected-device-unavailable",
      errorCode: "SELECTED_DEVICE_UNAVAILABLE",
    });
    expect(dispatch.placement).toBeUndefined();
  });

  it("commits an explicit desktop cloud choice directly to cloud", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-desktop-exact-cloud",
    );
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-source",
      pairMobile: false,
    });
    const idempotencyKey = "desktop:exact-cloud";
    const payloadJson = JSON.stringify({
      prompt: "Run in cloud",
      expectedOwnerGeneration: ownerGeneration,
      clientMsgId: idempotencyKey,
    });
    const dispatch = await submitDesktop(t, source, {
      idempotencyKey,
      requestedTargetMode: "cloud",
      payloadJson,
      conversationId,
      requiredCapabilities: ["chat"],
    });
    expect(dispatch).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
      requestedTargetMode: "cloud",
      fallbackReason: "explicit-cloud",
    });
  });

  it("requires a live signed desktop proof and accepts only exact replay", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-signed-desktop");
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-signed-source",
      pairMobile: false,
    });
    const idempotencyKey = "desktop:signed-cloud";
    const payloadJson = JSON.stringify({
      prompt: "Signed desktop request",
      expectedOwnerGeneration: ownerGeneration,
      clientMsgId: idempotencyKey,
    });
    const signed = desktopSubmitArgs(source, {
      conversationId,
      idempotencyKey,
      payloadJson,
      requestedTargetMode: "cloud",
    });
    const { signature: _signature, ...unsigned } = signed;
    await expect(
      asOwner(t).mutation(refs.submitDesktop, unsigned),
    ).rejects.toThrow();

    const imposter = createDeviceProofs(source.deviceId);
    imposter.proof("execution-submit", "0".repeat(64));
    const forged = imposter.proof("execution-submit", signed.bodyHash);
    await expect(
      asOwner(t).mutation(refs.submitDesktop, {
        ...signed,
        ...forged,
        presenceSessionId: source.presenceSessionId,
      }),
    ).rejects.toThrow(/signature verification failed/i);

    const first = await asOwner(t).mutation(refs.submitDesktop, signed);
    const replay = await asOwner(t).mutation(refs.submitDesktop, signed);
    expect(replay.dispatchId).toBe(first.dispatchId);
    expect(replay).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
    });

    await expect(
      asOwner(t).mutation(refs.submitDesktop, {
        ...signed,
        requestedTargetMode: "device",
        requestedExecutorDeviceId: "desktop-mutated-target",
      }),
    ).rejects.toThrow(/proof body does not match/i);
    await expect(
      asOwner(t).mutation(refs.submitDesktop, {
        ...signed,
        payloadJson: JSON.stringify({
          prompt: "Mutated after signing",
          expectedOwnerGeneration: ownerGeneration,
        }),
      }),
    ).rejects.toThrow(/payload hash does not match/i);
  });

  it("rejects a signed desktop submission after its presence lease expires", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-expired-source");
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-expired-source",
      pairMobile: false,
    });
    await t.run(async (ctx) => {
      const presence = await ctx.db
        .query("desktop_execution_presence")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", source.deviceId),
        )
        .unique();
      await ctx.db.patch(presence!._id, { leaseExpiresAt: Date.now() - 1 });
    });
    const payloadJson = JSON.stringify({
      prompt: "Too late",
      expectedOwnerGeneration: ownerGeneration,
    });
    await expect(
      submitDesktop(t, source, {
        conversationId,
        idempotencyKey: "desktop:expired-source",
        payloadJson,
        requestedTargetMode: "cloud",
      }),
    ).rejects.toThrow(/presence is no longer live/i);
  });

  it("rechecks remote execution permission when a selected device claims", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-disable-before-claim",
    );
    const source = await registerReadyDesktop(t, {
      deviceId: "desktop-disable-source",
      pairMobile: false,
    });
    const target = await registerReadyDesktop(t, {
      deviceId: "desktop-disable-target",
      pairMobile: false,
    });
    const payloadJson = JSON.stringify({
      prompt: "Do not claim after disable",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await submitDesktop(t, source, {
      conversationId,
      idempotencyKey: "desktop:disable-before-claim",
      payloadJson,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: target.deviceId,
    });
    await asOwner(t).mutation(refs.setRemoteEnabled, {
      deviceId: target.deviceId,
      enabled: false,
    });
    await expect(claim(t, target, dispatch.dispatchId)).rejects.toThrow(
      /remote execution is disabled/i,
    );
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "offering" });
  });

  it("binds presence to the registered device key and rejects forged updates", async () => {
    const t = createTest();
    const signer = await registerReadyDesktop(t);
    const body = hashBody(["ready", 1, 1, 1, 1]);
    const forged = createDeviceProofs().proof("presence-heartbeat", body);
    await expect(
      asOwner(t).mutation(refs.heartbeat, {
        ownerGeneration,
        deviceId,
        presenceSessionId: signer.presenceSessionId,
        status: "ready",
        chatSlotCapacity: 1,
        agentSlotCapacity: 1,
        availableChatSlots: 1,
        availableAgentSlots: 1,
        sequence: 2,
        bodyHash: body,
        signature: forged.signature,
      }),
    ).rejects.toThrow("signature verification failed");
  });

  it("uses exact request bytes for idempotency and conflicts on reuse", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    await registerReadyDesktop(t);
    const first = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:exact-request",
    });
    const replay = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:exact-request",
    });
    expect(replay.dispatchId).toBe(first.dispatchId);
    await expect(
      submitMobile(t, {
        conversationId,
        idempotencyKey: "mobile:exact-request",
        prompt: "different bytes",
      }),
    ).rejects.toThrow("already used for different execution bytes");
  });

  it("reveals payload only to the fenced claimant and deletes it after durable ack", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:claim-ack",
    });
    const offered = await asOwner(t).query(refs.offers, {
      deviceId,
      presenceSessionId: signer.presenceSessionId,
    });
    expect(
      offered.map(
        (row: { dispatch: { dispatchId: string } }) => row.dispatch.dispatchId,
      ),
    ).toContain(dispatch.dispatchId);

    const claimed = await claim(t, signer, dispatch.dispatchId);
    expect(claimed.result.payloadJson).toBe('{"prompt":"hello"}');
    const ackBody = hashBody([
      dispatch.dispatchId,
      claimed.tokenHash,
      claimed.result.payloadHash,
    ]);
    const accepted = await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof("claim-ack", ackBody),
    });
    expect(accepted).toMatchObject({
      state: "computer_accepted",
      placement: "computer",
      executorDeviceId: deviceId,
    });
    await t.run(async (ctx) => {
      const payload = await ctx.db
        .query("execution_dispatch_payloads")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(payload).toBeNull();
    });

    // Even a far-future offer callback cannot reinterpret accepted work as a
    // cloud retry.
    await t.mutation(refs.resolveDeadline, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      now: Date.now() + 60_000,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "computer_accepted", placement: "computer" });
  });

  it("allows explicit release only before acceptance", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:claim-release",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    const reason = "local inbox transaction failed";
    const released = await asOwner(t).mutation(refs.release, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      reason,
      ...signer.proof(
        "claim-release",
        hashBody([dispatch.dispatchId, claimed.tokenHash, reason]),
      ),
    });
    expect(released).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
    });
  });

  it("lets Stop win an accepted-local completion race", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-stop-wins-local");
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:stop-wins-local",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    expect(
      await asOwner(t).mutation(refs.cancel, {
        dispatchId: dispatch.dispatchId,
        cancelRequestId: "cancel:stop-wins-local",
      }),
    ).toMatchObject({ state: "cancel_pending", placement: "computer" });

    const lateResult = '{"finalText":"too late"}';
    await expect(
      asOwner(t).mutation(refs.complete, {
        ownerGeneration,
        deviceId,
        presenceSessionId: signer.presenceSessionId,
        dispatchId: dispatch.dispatchId,
        claimToken: claimed.claimToken,
        outcome: "completed",
        resultJson: lateResult,
        ...signer.proof(
          "complete",
          hashBody([
            dispatch.dispatchId,
            claimed.tokenHash,
            "completed",
            sha256(lateResult),
            "",
            "",
          ]),
        ),
      }),
    ).rejects.toThrow("accepts only a signed cancellation acknowledgement");
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "cancel_pending", placement: "computer" });

    const canceled = await asOwner(t).mutation(refs.complete, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      outcome: "canceled",
      errorMessage: "Canceled by the user.",
      ...signer.proof(
        "complete",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          "canceled",
          "",
          "",
          "Canceled by the user.",
        ]),
      ),
    });
    expect(canceled).toMatchObject({
      state: "canceled",
      placement: "computer",
    });
  });

  it("offers computer-classified phone work to its reachable paired desktop", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-paired-computer-work",
    );
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:paired-computer-work",
      subject: "computer",
    });
    expect(dispatch).toMatchObject({
      state: "offering",
      subject: "computer",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    const accepted = await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    expect(accepted).toMatchObject({
      state: "computer_accepted",
      placement: "computer",
      subject: "computer",
    });
  });

  it("falls computer-classified phone work back to cloud without changing its subject", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:computer-only",
      subject: "computer",
    });
    expect(dispatch).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
      subject: "computer",
      fallbackReason: "no-eligible-paired-computer",
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
        )
        .collect();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        source: "execution-placement:mobile:computer",
      });
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(
        scheduled.find((entry) =>
          entry.name.includes("runOrchestratorTurnInternal"),
        )?.args[0],
      ).toMatchObject({
        source: "execution-placement:mobile:computer",
      });
    });
  });

  it("commits an authenticated unpaired phone to cloud for portable work", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-unpaired-cloud");
    const dispatch = await submitUnpairedMobile(t, {
      conversationId,
      idempotencyKey: "mobile:unpaired-cloud",
    });
    expect(dispatch).toMatchObject({
      ingress: "mobile",
      subject: "portable",
      state: "cloud_committed",
      placement: "cloud",
      fallbackReason: "no-eligible-paired-computer",
    });
  });

  it("commits computer-classified work from an unpaired phone to cloud", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-unpaired-computer");
    const dispatch = await submitUnpairedMobile(t, {
      conversationId,
      idempotencyKey: "mobile:unpaired-computer",
      subject: "computer",
    });
    expect(dispatch).toMatchObject({
      ingress: "mobile",
      subject: "computer",
      state: "cloud_committed",
      placement: "cloud",
      fallbackReason: "no-eligible-paired-computer",
    });
  });

  it("fails an unavailable device capability in the cloud attempt instead of silently reinterpreting it", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-device-capability-cloud-fail",
    );
    const payloadJson = JSON.stringify({
      prompt: "read my local desktop file",
    });
    const dispatch = await t.mutation(refs.submitInternal, {
      ownerId,
      ownerGeneration,
      idempotencyKey: "mobile:device-capability-cloud-fail",
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      ingress: "mobile",
      subject: "computer",
      conversationId,
      requiredCapabilities: ["local-files"],
      now: Date.now(),
    });
    expect(dispatch).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
      subject: "computer",
    });

    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "failed",
      placement: "cloud",
      subject: "computer",
      errorCode: "CLOUD_CAPABILITY_UNAVAILABLE",
      errorMessage:
        "The cloud sandbox cannot provide the required device capability: local-files.",
    });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("agent_turns")
          .withIndex("by_ownerId_and_clientMsgId", (q) =>
            q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
          )
          .collect(),
      ).toHaveLength(0);
    });
  });

  it("derives browser ingress and commits work directly to cloud", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-browser");
    const payloadJson = JSON.stringify({
      prompt: "browser work",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:cloud-only",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    expect(dispatch).toMatchObject({
      ingress: "browser",
      state: "cloud_committed",
      placement: "cloud",
    });
  });

  it("offers an explicitly selected owned desktop from browser ingress and never falls back", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-browser-device");
    const signer = await registerReadyDesktop(t, { pairMobile: false });
    const payloadJson = JSON.stringify({
      prompt: "browser work on my desktop",
      expectedOwnerGeneration: ownerGeneration,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: deviceId,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:selected-device",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: deviceId,
      requiredCapabilities: ["chat"],
    });
    expect(dispatch).toMatchObject({
      ingress: "browser",
      state: "offering",
      requestedTargetMode: "device",
    });
    expect(
      await asOwner(t).query(refs.offers, {
        deviceId: signer.deviceId,
        presenceSessionId: signer.presenceSessionId,
      }),
    ).toHaveLength(1);

    const unavailablePayload = JSON.stringify({
      prompt: "do not silently move this",
      expectedOwnerGeneration: ownerGeneration,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: "missing-owned-device",
    });
    const unavailable = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:selected-device-missing",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson: unavailablePayload,
      payloadHash: sha256(unavailablePayload),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requestedTargetMode: "device",
      requestedExecutorDeviceId: "missing-owned-device",
      requiredCapabilities: ["chat"],
    });
    expect(unavailable).toMatchObject({
      state: "failed",
      errorCode: "SELECTED_DEVICE_UNAVAILABLE",
    });
    expect(unavailable).not.toHaveProperty("placement", "cloud");
  });

  it("rejects browser routing metadata that differs from the immutable payload", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-browser-routing-fence",
    );
    const payloadJson = JSON.stringify({
      prompt: "keep routing immutable",
      expectedOwnerGeneration: ownerGeneration,
      requestedTargetMode: "automatic",
    });
    await expect(
      asOwner(t).mutation(refs.submitBrowser, {
        idempotencyKey: "browser:routing-mismatch",
        expectedOwnerGeneration: ownerGeneration,
        payloadJson,
        payloadHash: sha256(payloadJson),
        kind: "chat",
        subject: "cloud",
        conversationId,
        requestedTargetMode: "device",
        requestedExecutorDeviceId: deviceId,
        requiredCapabilities: ["chat"],
      }),
    ).rejects.toThrow(/payload routing does not match/i);
  });

  it("rejects an offline browser replay after reset before dispatch, turn, schedule, or billing work", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-browser-stale-generation",
    );
    const staleGeneration = "generation-before-reset";
    const currentGeneration = "generation-after-reset";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: currentGeneration,
        state: "open",
        createdAt: 1,
        updatedAt: 2,
      });
    });
    const idempotencyKey = "browser:offline-before-reset";
    const payloadJson = JSON.stringify({
      schemaVersion: 1,
      prompt: "deliver only in the generation that created this outbox row",
      expectedOwnerGeneration: staleGeneration,
      conversationId,
      clientMsgId: idempotencyKey,
      locale: null,
      attachments: [],
      execution: null,
    });
    const submission = {
      idempotencyKey,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat" as const,
      subject: "cloud" as const,
      conversationId,
      requiredCapabilities: ["chat"] as const,
    };

    await expect(
      asOwner(t).mutation(refs.submitBrowser, {
        ...submission,
        expectedOwnerGeneration: staleGeneration,
      }),
    ).rejects.toThrow("started before the account data was reset");
    await expect(
      asOwner(t).mutation(refs.submitBrowser, {
        ...submission,
        expectedOwnerGeneration: currentGeneration,
      }),
    ).rejects.toThrow(
      "payload generation does not match its admission authority",
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.query("execution_dispatches").collect()).toHaveLength(
        0,
      );
      expect(
        await ctx.db.query("execution_dispatch_payloads").collect(),
      ).toHaveLength(0);
      expect(await ctx.db.query("agent_turns").collect()).toHaveLength(0);
      expect(
        await ctx.db.query("billing_managed_request_bindings").collect(),
      ).toHaveLength(0);
      expect(await ctx.db.query("usage_logs").collect()).toHaveLength(0);
      expect(
        await ctx.db.system.query("_scheduled_functions").collect(),
      ).toHaveLength(0);
    });
  });

  it("routes an anonymous Better Auth browser owner only through ordinary cloud chat", async () => {
    const t = createTest();
    const conversationId = "conv-browser-anonymous";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId,
        ownerId: anonymousOwnerId,
        title: "Anonymous browser chat",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const idempotencyKey = "browser:anonymous-chat";
    const payloadJson = JSON.stringify({
      schemaVersion: 1,
      prompt: "anonymous browser work",
      expectedOwnerGeneration: ownerGeneration,
      conversationId,
      clientMsgId: idempotencyKey,
      locale: null,
      attachments: [],
      execution: null,
    });
    const dispatch = await asAnonymousOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey,
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: ["chat"],
    });
    expect(dispatch).toMatchObject({
      ingress: "browser",
      kind: "chat",
      subject: "cloud",
      state: "cloud_committed",
      placement: "cloud",
    });
    expect(
      await asAnonymousOwner(t).query(refs.status, {
        dispatchId: dispatch.dispatchId,
      }),
    ).toMatchObject({
      dispatchId: dispatch.dispatchId,
      state: "cloud_committed",
    });
    expect(
      await asAnonymousOwner(t).mutation(refs.cancel, {
        dispatchId: dispatch.dispatchId,
        cancelRequestId: `cancel:${dispatch.dispatchId}`,
      }),
    ).toMatchObject({ state: "canceled", placement: "cloud" });

    await expect(
      asAnonymousOwner(t).mutation(refs.submitBrowser, {
        idempotencyKey: "browser:anonymous-agent",
        expectedOwnerGeneration: ownerGeneration,
        payloadJson: JSON.stringify({
          prompt: "spawn an agent",
          description: "not ordinary chat",
          expectedOwnerGeneration: ownerGeneration,
        }),
        payloadHash: sha256(
          JSON.stringify({
            prompt: "spawn an agent",
            description: "not ordinary chat",
            expectedOwnerGeneration: ownerGeneration,
          }),
        ),
        kind: "agent",
        subject: "cloud",
        conversationId,
        requiredCapabilities: ["agent"],
      }),
    ).rejects.toThrow("limited to ordinary cloud chat");
  });

  it("preserves frozen browser chat metadata through placement admission", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-browser-payload");
    const idempotencyKey = "browser:frozen-payload";
    const execution = {
      engine: "stella" as const,
      provider: "stella" as const,
      model: "stella/standard",
      reasoningEffort: "high" as const,
    };
    const payloadJson = JSON.stringify({
      schemaVersion: 1,
      prompt: "explain this image in French",
      expectedOwnerGeneration: ownerGeneration,
      conversationId,
      clientMsgId: idempotencyKey,
      locale: "fr",
      attachments: ["images/input.png"],
      execution,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey,
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: ["chat"],
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
        )
        .collect();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        conversationId,
        prompt: "explain this image in French",
        kind: "chat",
        lane: "chat",
        execution,
      });
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      const orchestrator = scheduled.find((entry) =>
        entry.name.includes("runOrchestratorTurnInternal"),
      );
      expect(orchestrator?.args[0]).toMatchObject({
        conversationId,
        prompt: "explain this image in French",
        clientMsgId: dispatch.dispatchId,
        locale: "fr",
        attachments: ["images/input.png"],
        execution,
      });
    });
  });

  it("reuses composer app-operation inference for browser placement", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-browser-app-route");
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_apps", {
        appId: "app-orbit-browser",
        ownerId,
        slug: "orbit-browser",
        title: "Orbit",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_app_operations", {
        appId: "app-orbit-browser",
        ownerId,
        manifestJson: JSON.stringify({ operations: [] }),
        sizeBytes: 17,
        updatedAt: 1,
      });
    });
    const idempotencyKey = "browser:app-route";
    const payloadJson = JSON.stringify({
      schemaVersion: 1,
      prompt: "Update Orbit with a calmer header",
      expectedOwnerGeneration: ownerGeneration,
      conversationId,
      clientMsgId: idempotencyKey,
      locale: null,
      attachments: [],
      execution: null,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey,
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: ["chat"],
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
        )
        .collect();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        appId: "app-orbit-browser",
        conversationId,
        lane: "auto",
        kind: "build",
      });
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(
        scheduled.some((entry) =>
          entry.name.includes("routeCloudTurnInternal"),
        ),
      ).toBe(true);
    });
  });

  it("refuses a deviceless ingress that claims a local subject", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-subject-spoof");
    const payloadJson = JSON.stringify({
      prompt: "spoof placement",
      expectedOwnerGeneration: ownerGeneration,
    });
    const base = {
      ownerId,
      ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat" as const,
      conversationId,
      requiredCapabilities: [] as const,
      now: Date.now(),
    };

    for (const ingress of ["browser", "cloud", "schedule"] as const) {
      for (const subject of ["computer", "portable"] as const) {
        await expect(
          t.mutation(refs.submitInternal, {
            ...base,
            idempotencyKey: `${ingress}:spoof-${subject}`,
            ingress,
            subject,
          }),
        ).rejects.toThrow("may only submit hosted execution");
      }
    }
    await expect(
      asOwner(t).mutation(refs.submitBrowser, {
        idempotencyKey: "browser:spoof-portable-public",
        expectedOwnerGeneration: ownerGeneration,
        payloadJson,
        payloadHash: sha256(payloadJson),
        kind: "chat",
        subject: "portable",
        conversationId,
        requiredCapabilities: [],
      }),
    ).rejects.toThrow("may only submit hosted execution");
  });

  it("uses a durable thread's placement as subject authority", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-thread-placement");
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_agent_threads", {
        threadId: "thread-placement-authority",
        ownerId,
        conversationId,
        description: "Placement authority",
        placement: "cloud",
        agentType: "general",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const payloadJson = JSON.stringify({ prompt: "retarget thread" });
    await expect(
      t.mutation(refs.submitInternal, {
        ownerId,
        ownerGeneration,
        idempotencyKey: "mobile:retarget-thread",
        payloadJson,
        payloadHash: sha256(payloadJson),
        kind: "agent",
        ingress: "mobile",
        subject: "computer",
        conversationId,
        threadId: "thread-placement-authority",
        requiredCapabilities: ["agent"],
        now: Date.now(),
      }),
    ).rejects.toThrow("does not match the durable thread");
  });

  it("fences concurrent cloud delivery attempts and projects the terminal turn", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-cloud-terminal");
    const payloadJson = JSON.stringify({
      prompt: "browser work",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:terminal-projection",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    const now = Date.now();
    expect(
      await t.mutation(refs.markCloudAttempted, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-one",
        expectedAttemptGeneration: 1,
        now,
      }),
    ).toBe(true);
    expect(
      await t.mutation(refs.markCloudAttempted, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-two",
        expectedAttemptGeneration: 1,
        now: now + 1,
      }),
    ).toBe(false);
    const turnId = "turn-placement-cloud";
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_turns", {
        turnId,
        sessionId: conversationId,
        ownerId,
        ownerGeneration,
        conversationId,
        prompt: "browser work",
        status: "completed",
        terminalKind: "completed",
        resultJson: JSON.stringify({ finalText: "done" }),
        lane: "chat",
        kind: "chat",
        clientMsgId: dispatch.dispatchId,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(refs.markCloudStarted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-one",
      attemptGeneration: 2,
      cloudTurnId: turnId,
      now: now + 2,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "completed",
      placement: "cloud",
      cloudTurnId: turnId,
      resultJson: JSON.stringify({ finalText: "done" }),
    });
    await t.mutation(refs.reconcile, { now: now + 3 });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "completed",
      placement: "cloud",
      cloudTurnId: turnId,
      resultJson: JSON.stringify({ finalText: "done" }),
    });
  });

  it("fences stale cloud attempt callbacks after an expired-lease takeover", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-cloud-attempt-aba");
    const payloadJson = JSON.stringify({
      prompt: "fence stale callbacks",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:attempt-aba",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    const now = Date.now();
    expect(
      await t.mutation(refs.markCloudAttempted, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-a",
        expectedAttemptGeneration: 1,
        now,
      }),
    ).toBe(true);
    expect(
      await t.mutation(refs.markCloudAttempted, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-b",
        expectedAttemptGeneration: 2,
        now: now + 30_001,
      }),
    ).toBe(true);

    await t.mutation(refs.markCloudStarted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-a",
      attemptGeneration: 2,
      cloudTurnId: "turn-from-stale-attempt",
      now: now + 30_002,
    });
    await t.mutation(refs.markCloudFailed, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-a",
      attemptGeneration: 2,
      errorCode: "STALE_ATTEMPT",
      errorMessage: "The expired attempt completed late.",
      now: now + 30_003,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "cloud_committed", placement: "cloud" });
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(stored).toMatchObject({
        cloudAttemptId: "attempt-b",
        attemptGeneration: 3,
      });
    });

    await expect(
      t.mutation(refs.startCloudChat, {
        ownerId,
        ownerGeneration,
        conversationId,
        prompt: "fence stale callbacks",
        source: "browser",
        clientMsgId: dispatch.dispatchId,
        placementAttempt: {
          dispatchId: dispatch.dispatchId,
          attemptId: "attempt-a",
          attemptGeneration: 2,
        },
        now: now + 30_004,
      }),
    ).rejects.toThrow("no longer owns cloud admission");
    const admitted = await t.mutation(refs.startCloudChat, {
      ownerId,
      ownerGeneration,
      conversationId,
      prompt: "fence stale callbacks",
      source: "browser",
      clientMsgId: dispatch.dispatchId,
      placementAttempt: {
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-b",
        attemptGeneration: 3,
      },
      now: now + 30_005,
    });
    await t.mutation(refs.markCloudStarted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-b",
      attemptGeneration: 3,
      cloudTurnId: admitted.turnId,
      now: now + 30_006,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "cloud_running",
      cloudTurnId: admitted.turnId,
    });
  });

  it("replays a cloud-agent delivery before creating or scheduling twice", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-agent-replay");
    const clientMsgId = "exec:agent-replay-fence";
    const parentTurnId = "turn-agent-replay-parent";
    const parentTurnToken = "turn-agent-replay-parent-token";
    await t.run(async (ctx) => {
      const tokenNow = Date.now();
      await ctx.db.insert("agent_turns", {
        turnId: parentTurnId,
        sessionId: conversationId,
        ownerId,
        ownerGeneration,
        conversationId,
        prompt: "Start replay-safe child work.",
        status: "running",
        kind: "chat",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_turn_tokens", {
        tokenHash: sha256(parentTurnToken),
        ownerId,
        ownerGeneration,
        turnId: parentTurnId,
        agentType: "orchestrator",
        createdAt: tokenNow,
        expiresAt: tokenNow + 60_000,
      });
    });
    const args = {
      ownerId,
      ownerGeneration,
      conversationId,
      parentTurnId,
      description: "Replay-safe placement agent",
      prompt: "perform the replay-safe work",
      clientMsgId,
      model: "stella/default:low",
      now: Date.now(),
    };
    const first = await t.mutation(refs.spawnCloudAgent, args);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const replay = await t.mutation(refs.spawnCloudAgent, {
      ...args,
      now: args.now + 1,
    });
    expect(replay).toEqual(first);
    const equivalentExplicitReplay = await t.mutation(refs.spawnCloudAgent, {
      ...args,
      model: undefined,
      execution: {
        engine: "stella" as const,
        provider: "stella" as const,
        model: "stella/default",
        reasoningEffort: "low" as const,
      },
      now: args.now + 2,
    });
    expect(equivalentExplicitReplay).toEqual(first);

    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", clientMsgId),
        )
        .collect();
      const threads = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .collect();
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(turns).toHaveLength(1);
      expect(turns[0]?.spawnIntentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(threads).toHaveLength(1);
      const agentStarts = scheduled.filter(
        (entry) =>
          entry.name.includes("runCloudAgentTurnInternal") &&
          entry.state.kind !== "canceled" &&
          typeof entry.args[0] === "object" &&
          entry.args[0] !== null &&
          (
            entry.args[0] as {
              turnId?: unknown;
              dispatchAttempt?: unknown;
            }
          ).turnId === first.turnId &&
          (entry.args[0] as { dispatchAttempt?: unknown }).dispatchAttempt ===
            undefined,
      );
      expect(agentStarts).toHaveLength(1);
    });

    const previousServiceSecret = process.env.BUILDER_SERVICE_SECRET;
    process.env.BUILDER_SERVICE_SECRET = "spawn-replay-test-secret";
    const spawnRequest = (description: string) =>
      new Request("https://convex.test/api/cloud/spawn", {
        method: "POST",
        headers: {
          authorization: "Bearer spawn-replay-test-secret",
          "content-type": "application/json",
          "x-stella-turn-token": parentTurnToken,
        },
        body: JSON.stringify({
          action: "spawn",
          ownerId,
          ownerGeneration,
          conversationId,
          parentTurnId,
          description,
          prompt: args.prompt,
          clientMsgId,
          model: args.model,
        }),
      });
    try {
      const httpReplay = await t.fetch(
        "/api/cloud/spawn",
        spawnRequest(args.description),
      );
      expect(httpReplay.status).toBe(200);
      await expect(httpReplay.json()).resolves.toEqual(first);

      const httpConflict = await t.fetch(
        "/api/cloud/spawn",
        spawnRequest("HTTP delivery changed description"),
      );
      expect(httpConflict.status).toBe(409);
      await expect(httpConflict.json()).resolves.toMatchObject({
        ok: false,
        error: "That cloud agent request id was already used differently.",
      });
    } finally {
      if (previousServiceSecret === undefined) {
        delete process.env.BUILDER_SERVICE_SECRET;
      } else {
        process.env.BUILDER_SERVICE_SECRET = previousServiceSecret;
      }
    }

    const expectConflict = async (
      changed: Partial<typeof args> & {
        source?: string;
        execution?: {
          engine: "stella" | "anthropic" | "openai-codex";
          provider: "stella" | "anthropic" | "openai-codex";
          model: string;
          reasoningEffort:
            | "default"
            | "none"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh";
        };
      },
      now: number,
    ) => {
      expect(
        await t.mutation(refs.spawnCloudAgent, {
          ...args,
          ...changed,
          now,
        }),
      ).toMatchObject({
        ok: false,
        error: "That cloud agent request id was already used differently.",
      });
    };

    await expectConflict(
      { description: "Different description with the same delivery id" },
      args.now + 3,
    );
    await expectConflict({ source: "execution-placement" }, args.now + 4);
    await expectConflict({ model: "stella/another-model:low" }, args.now + 5);
    await expectConflict(
      {
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "high",
        },
      },
      args.now + 6,
    );
    await expectConflict(
      {
        execution: {
          engine: "openai-codex",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "low",
        },
      },
      args.now + 7,
    );
    await expectConflict(
      { prompt: "different work with the same delivery id" },
      args.now + 8,
    );

    await t.run(async (ctx) => {
      const [turn] = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", clientMsgId),
        )
        .collect();
      expect(turn).toBeDefined();
      await ctx.db.patch(turn!._id, { spawnIntentFingerprint: undefined });
    });
    expect(
      await t.mutation(refs.spawnCloudAgent, {
        ...args,
        now: args.now + 9,
      }),
    ).toMatchObject({
      ok: false,
      error: "That cloud agent request id was already used differently.",
    });
  });

  it("fences and replays placement-owned cloud-agent admission", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-agent-placement");
    const payloadJson = JSON.stringify({
      prompt: "run the placed agent",
      description: "Placement-owned agent",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:agent-placement-fence",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "agent",
      subject: "cloud",
      conversationId,
      requiredCapabilities: ["agent"],
    });
    const now = Date.now();
    await t.mutation(refs.markCloudAttempted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-agent-placement",
      expectedAttemptGeneration: 1,
      now,
    });
    const admission = {
      ownerId,
      ownerGeneration,
      conversationId,
      description: "Placement-owned agent",
      prompt: "run the placed agent",
      source: "execution-placement",
      clientMsgId: dispatch.dispatchId,
      placementAttempt: {
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-agent-placement",
        attemptGeneration: 2,
      },
      now: now + 1,
    };
    const first = await t.mutation(refs.spawnCloudAgent, admission);
    expect(first).toMatchObject({ ok: true });
    expect(
      await t.mutation(refs.spawnCloudAgent, { ...admission, now: now + 2 }),
    ).toEqual(first);
    await asOwner(t).mutation(refs.cancel, {
      dispatchId: dispatch.dispatchId,
      cancelRequestId: "cancel:agent-after-admission",
    });
    expect(
      await t.mutation(refs.resolveCanceledCloudAdmission, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-agent-placement",
        attemptGeneration: 2,
        now: now + 3,
      }),
    ).toEqual({
      status: "turn",
      kind: "agent",
      conversationId,
      threadId: first.threadId,
      turnId: first.turnId,
      attemptGeneration: first.attemptGeneration,
    });

    const priorUrl = process.env.CLOUD_BUILDER_URL;
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    const priorFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ canceled: true });
    });
    try {
      await t.action(refs.cancelCloudDispatch, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
      });
    } finally {
      globalThis.fetch = priorFetch;
      if (priorUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = priorUrl;
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
    }
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const request of requests) {
      expect(request).toEqual({
        url: `https://builder.example.test/sessions/${first.threadId}/cancel`,
        body: {
          ownerId,
          ownerGeneration,
          turnId: first.turnId,
          attemptGeneration: first.attemptGeneration,
          cancelRequestId: "cancel:agent-after-admission",
          reason: "Canceled by the user.",
        },
      });
    }

    // A restart can expose duplicate indexed residue from an ABA successor.
    // Even though one row still names the old target exactly, cancellation
    // must not pick either row or terminalize the placement as "no turn".
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_turns", {
        turnId: "turn:agent-placement-aba-successor",
        sessionId: "thread:agent-placement-aba-successor",
        ownerId,
        ownerGeneration,
        conversationId,
        prompt: "newer ABA attempt",
        status: "running",
        lane: "agent",
        kind: "agent",
        placement: "cloud",
        threadId: "thread:agent-placement-aba-successor",
        attemptGeneration: first.attemptGeneration! + 1,
        clientMsgId: dispatch.dispatchId,
        createdAt: now + 10,
        updatedAt: now + 10,
      });
    });
    expect(
      await t.mutation(refs.resolveCanceledCloudAdmission, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-agent-placement",
        attemptGeneration: 2,
        now: now + 11,
      }),
    ).toBeNull();
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(stored?.state).toBe("cancel_pending");
    });
  });

  it("manual cloud-agent pause carries one exact identity and cannot cancel an ABA successor", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-agent-pause");
    const now = Date.now();
    const first = await t.mutation(refs.spawnCloudAgent, {
      ownerId,
      ownerGeneration,
      conversationId,
      description: "Pause target",
      prompt: "run until paused",
      source: "desktop",
      originDeviceId: deviceId,
      originConversationId: "local-conv-pause",
      now,
    });
    expect(first).toMatchObject({ ok: true });
    expect(first.threadId).toBeTruthy();
    expect(first.turnId).toBeTruthy();

    const priorUrl = process.env.CLOUD_BUILDER_URL;
    const priorSecret = process.env.BUILDER_SERVICE_SECRET;
    const priorFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({
        canceled: true,
        turnId: first.turnId,
        joined: true,
      });
    });
    const controlRequestId = "pause:exact-request";
    try {
      const pauseRequest = {
        ownerGeneration,
        threadId: first.threadId!,
        expectedAttemptGeneration: first.attemptGeneration!,
        expectedThreadUpdatedAt: first.threadUpdatedAt!,
        originDeviceId: deviceId,
        originConversationId: "local-conv-pause",
        controlRequestId,
      };
      const paused = await asOwner(t).action(
        refs.cancelCloudAgent,
        pauseRequest,
      );
      expect(paused).toMatchObject({
        canceled: true,
        status: "canceled",
        threadId: first.threadId,
        attemptGeneration: first.attemptGeneration,
      });
      expect(
        requests.filter(
          (entry) => entry.body.cancelRequestId === controlRequestId,
        ),
      ).toEqual([
        {
          url: `https://builder.example.test/sessions/${first.threadId}/cancel`,
          body: {
            ownerId,
            ownerGeneration,
            turnId: first.turnId,
            attemptGeneration: first.attemptGeneration,
            cancelRequestId: controlRequestId,
            reason: "Paused by orchestrator.",
          },
        },
      ]);

      const successor = await t.mutation(refs.spawnCloudAgent, {
        ownerId,
        ownerGeneration,
        conversationId,
        threadId: first.threadId,
        expectedAttemptGeneration: paused.attemptGeneration,
        expectedTerminalUpdatedAt: paused.threadUpdatedAt,
        description: "Successor",
        prompt: "continue with newer work",
        source: "agent-thread",
        clientMsgId: "pause-successor",
        now: paused.threadUpdatedAt + 1,
      });
      expect(successor).toMatchObject({ ok: true, threadId: first.threadId });
      expect(successor.turnId).not.toBe(first.turnId);

      // A network retry of the old pause resolves through the stable control
      // receipt and never sends another teardown request for the successor.
      expect(
        await asOwner(t).action(refs.cancelCloudAgent, pauseRequest),
      ).toMatchObject({ canceled: true });
      expect(
        requests.filter(
          (entry) => entry.body.cancelRequestId === controlRequestId,
        ),
      ).toHaveLength(1);
      await t.run(async (ctx) => {
        const storedSuccessor = await ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", successor.turnId!))
          .unique();
        expect(storedSuccessor?.status).toBe("running");
      });
    } finally {
      globalThis.fetch = priorFetch;
      if (priorUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
      else process.env.CLOUD_BUILDER_URL = priorUrl;
      if (priorSecret === undefined) delete process.env.BUILDER_SERVICE_SECRET;
      else process.env.BUILDER_SERVICE_SECRET = priorSecret;
    }
  });

  it("cancels an unattempted cloud commit without starting it", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-cloud-cancel");
    const payloadJson = JSON.stringify({
      prompt: "cancel me",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:cancel-before-attempt",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    const canceled = await asOwner(t).mutation(refs.cancel, {
      dispatchId: dispatch.dispatchId,
      cancelRequestId: "cancel:browser-before-attempt",
    });
    expect(canceled).toMatchObject({
      state: "canceled",
      placement: "cloud",
    });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("execution_dispatch_payloads")
          .withIndex("by_dispatchId", (q) =>
            q.eq("dispatchId", dispatch.dispatchId),
          )
          .unique(),
      ).toBeNull();
    });
  });

  it("atomically closes cloud admission when cancellation wins the race", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-cancel-wins");
    const payloadJson = JSON.stringify({
      prompt: "must not resurrect",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:cancel-wins-admission-race",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    const now = Date.now();
    expect(
      await t.mutation(refs.markCloudAttempted, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-cancel-wins",
        expectedAttemptGeneration: 1,
        now,
      }),
    ).toBe(true);
    expect(
      await asOwner(t).mutation(refs.cancel, {
        dispatchId: dispatch.dispatchId,
        cancelRequestId: "cancel:admission-race",
      }),
    ).toMatchObject({ state: "cancel_pending", placement: "cloud" });

    await expect(
      t.mutation(refs.startCloudChat, {
        ownerId,
        ownerGeneration,
        conversationId,
        prompt: "must not resurrect",
        source: "browser",
        clientMsgId: dispatch.dispatchId,
        placementAttempt: {
          dispatchId: dispatch.dispatchId,
          attemptId: "attempt-cancel-wins",
          attemptGeneration: 2,
        },
        now: now + 1,
      }),
    ).rejects.toThrow("no longer owns cloud admission");
    expect(
      await t.mutation(refs.resolveCanceledCloudAdmission, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-cancel-wins",
        attemptGeneration: 2,
        now: now + 2,
      }),
    ).toEqual({ status: "canceled" });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "canceled", placement: "cloud" });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("agent_turns")
          .withIndex("by_ownerId_and_clientMsgId", (q) =>
            q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
          )
          .take(2),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("execution_dispatch_payloads")
          .withIndex("by_dispatchId", (q) =>
            q.eq("dispatchId", dispatch.dispatchId),
          )
          .unique(),
      ).toBeNull();
    });
  });

  it("replays one admitted cloud turn when admission wins before cancellation", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-admission-wins");
    const payloadJson = JSON.stringify({
      prompt: "admit exactly once",
      expectedOwnerGeneration: ownerGeneration,
    });
    const dispatch = await asOwner(t).mutation(refs.submitBrowser, {
      idempotencyKey: "browser:admission-wins-cancel-race",
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash: sha256(payloadJson),
      kind: "chat",
      subject: "cloud",
      conversationId,
      requiredCapabilities: [],
    });
    const now = Date.now();
    await t.mutation(refs.markCloudAttempted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-admission-wins",
      expectedAttemptGeneration: 1,
      now,
    });
    const admission = {
      ownerId,
      ownerGeneration,
      conversationId,
      prompt: "admit exactly once",
      source: "browser",
      clientMsgId: dispatch.dispatchId,
      placementAttempt: {
        dispatchId: dispatch.dispatchId,
        attemptId: "attempt-admission-wins",
        attemptGeneration: 2,
      },
      now: now + 1,
    };
    const first = await t.mutation(refs.startCloudChat, admission);
    expect(
      await t.mutation(refs.startCloudChat, { ...admission, now: now + 2 }),
    ).toEqual(first);
    await t.mutation(refs.markCloudStarted, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      attemptId: "attempt-admission-wins",
      attemptGeneration: 2,
      cloudTurnId: first.turnId,
      now: now + 3,
    });
    await asOwner(t).mutation(refs.cancel, {
      dispatchId: dispatch.dispatchId,
      cancelRequestId: "cancel:after-admission",
    });
    expect(
      await t.query(refs.cloudCancellationInput, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
      }),
    ).toMatchObject({
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
      cancelRequestId: "cancel:after-admission",
      attemptGeneration: 2,
      kind: "chat",
      conversationId,
      turnId: first.turnId,
    });
    expect(
      await t.mutation(refs.startCloudChat, { ...admission, now: now + 4 }),
    ).toEqual(first);
    expect(
      await t.mutation(refs.resolveCanceledCloudAdmission, {
        ownerId,
        ownerGeneration,
        dispatchId: dispatch.dispatchId,
        attemptGeneration: 2,
        now: now + 5,
      }),
    ).toEqual({
      status: "turn",
      kind: "chat",
      conversationId,
      turnId: first.turnId,
    });
    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
        )
        .take(2);
      expect(turns).toHaveLength(1);
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(stored?.state).toBe("cancel_pending");
    });
  });

  it("expires accepted computer leases into reconciliation, never fallback", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:accepted-expiry",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    await t.mutation(refs.reconcile, { now: Date.now() + 5 * 60_000 });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "reconciliation_required",
      placement: "computer",
      errorCode: "COMPUTER_LEASE_EXPIRED",
    });
  });

  it("keeps dispatch status and claim authority isolated by owner and session", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:isolation",
    });
    expect(
      await asOtherOwner(t).query(refs.status, {
        dispatchId: dispatch.dispatchId,
      }),
    ).toBeNull();
    const token = `claim-token-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const requestId = `claim:${crypto.randomUUID()}`;
    const tokenHash = sha256(token);
    const proof = signer.proof(
      "claim",
      hashBody([dispatch.dispatchId, requestId, tokenHash]),
    );
    await expect(
      asOwner(t).mutation(refs.claim, {
        ownerGeneration,
        deviceId,
        presenceSessionId: "different-presence-session",
        dispatchId: dispatch.dispatchId,
        claimRequestId: requestId,
        claimToken: token,
        ...proof,
      }),
    ).rejects.toThrow("presence session is not current");
  });

  it("clears unaccepted claims but never silently reroutes accepted work", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t);
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:clear-accepted",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    await asOwner(t).mutation(refs.clear, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      ...signer.proof("presence-clear", hashBody([])),
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "reconciliation_required",
      placement: "computer",
      errorCode: "COMPUTER_PRESENCE_CLEARED",
    });
  });

  it("fences new claims and quiesces pre-accept work before owner purge drains keys", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-purge-unaccepted");
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:purge-unaccepted",
    });
    const operationId = "purge:placement-unaccepted";
    const purge = await t.mutation(refs.beginOwnerPurge, {
      ownerId,
      operationId,
      mode: "reset",
      now: Date.now(),
    });

    const claimToken = `claim-token-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const claimRequestId = `claim:${crypto.randomUUID()}`;
    const claimTokenHash = sha256(claimToken);
    await expect(
      asOwner(t).mutation(refs.claim, {
        ownerGeneration,
        deviceId,
        presenceSessionId: signer.presenceSessionId,
        dispatchId: dispatch.dispatchId,
        claimRequestId,
        claimToken,
        ...signer.proof(
          "claim",
          hashBody([dispatch.dispatchId, claimRequestId, claimTokenHash]),
        ),
      }),
    ).rejects.toThrow("being reset");

    const result = await t.mutation(refs.quiesceOwnerPlacement, {
      ownerId,
      operationId,
      generation: purge.generation,
      now: Date.now(),
    });
    expect(result).toMatchObject({
      ready: true,
      pendingDispatches: 0,
      terminalizedDispatches: 1,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "canceled" });
    await t.run(async (ctx) => {
      const presence = await ctx.db
        .query("desktop_execution_presence")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", deviceId),
        )
        .unique();
      expect(presence).toMatchObject({
        status: "draining",
        availableChatSlots: 0,
        availableAgentSlots: 0,
        purgeOperationId: operationId,
      });
      expect(
        await ctx.db
          .query("execution_offers")
          .withIndex("by_dispatchId_and_status", (q) =>
            q.eq("dispatchId", dispatch.dispatchId).eq("status", "open"),
          )
          .collect(),
      ).toHaveLength(0);
    });
  });

  it.each(["tombstone", "retained-dependency"] as const)(
    "lets an exact source-owner delete purge quiesce placement behind a migration %s",
    async (sourceFence) => {
      const t = createTest();
      const conversationId = await seedConversation(
        t,
        `conv-source-purge-${sourceFence}`,
      );
      await registerReadyDesktop(t);
      const dispatch = await submitMobile(t, {
        conversationId,
        idempotencyKey: `mobile:source-purge-${sourceFence}`,
      });
      const operationId = `migrated-source-auth-delete:${sourceFence}`;
      const purge = await t.mutation(refs.beginOwnerPurge, {
        ownerId,
        operationId,
        mode: "delete",
        now: Date.now(),
      });

      await t.run(async (ctx) => {
        if (sourceFence === "tombstone") {
          await ctx.db.insert("auth_owner_migration_tombstones", {
            sourceOwnerDigest: await ownershipMigrationSourceDigest(ownerId),
          });
          return;
        }
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: ownerId,
          toOwnerId: "https://issuer.test|placement-destination",
          status: "failed",
          sourcePurgeDependency: {
            sourceOperationId: operationId,
            sourceGeneration: purge.generation,
            destinationOperationId: "delete:placement-destination",
            destinationGeneration: "destination-generation",
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      await expect(
        t.mutation(refs.quiesceOwnerPlacement, {
          ownerId,
          operationId,
          generation: purge.generation,
          now: Date.now(),
        }),
      ).resolves.toMatchObject({
        ready: true,
        pendingDispatches: 0,
        terminalizedDispatches: 1,
      });
      await t.run(async (ctx) => {
        const [storedDispatch, presence] = await Promise.all([
          ctx.db
            .query("execution_dispatches")
            .withIndex("by_dispatchId", (q) =>
              q.eq("dispatchId", dispatch.dispatchId),
            )
            .unique(),
          ctx.db
            .query("desktop_execution_presence")
            .withIndex("by_ownerId_and_deviceId", (q) =>
              q.eq("ownerId", ownerId).eq("deviceId", deviceId),
            )
            .unique(),
        ]);
        expect(storedDispatch).toMatchObject({
          state: "canceled",
          purgeOperationId: operationId,
          purgeGeneration: purge.generation,
        });
        expect(presence).toMatchObject({
          status: "draining",
          purgeOperationId: operationId,
          purgeGeneration: purge.generation,
        });
      });
    },
  );

  it("retains accepted control until a signed purge cancellation ACK", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-purge-accepted");
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:purge-accepted",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    const operationId = "purge:placement-accepted";
    const purge = await t.mutation(refs.beginOwnerPurge, {
      ownerId,
      operationId,
      mode: "delete",
      now: Date.now(),
    });
    const first = await t.mutation(refs.quiesceOwnerPlacement, {
      ownerId,
      operationId,
      generation: purge.generation,
      now: Date.now(),
    });
    expect(first).toMatchObject({
      ready: false,
      pendingDispatches: 1,
      cancellationSignals: 1,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "cancel_pending",
      placement: "computer",
    });
    expect(
      await asOwner(t).query(refs.accepted, {
        deviceId,
        presenceSessionId: signer.presenceSessionId,
      }),
    ).toEqual([
      expect.objectContaining({
        dispatchId: dispatch.dispatchId,
        state: "cancel_pending",
      }),
    ]);
    await expect(
      asOwner(t).query(refs.offers, {
        deviceId,
        presenceSessionId: signer.presenceSessionId,
      }),
    ).rejects.toThrow("being deleted");

    const errorMessage = "Canceled by owner purge.";
    const completed = await asOwner(t).mutation(refs.complete, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      outcome: "canceled",
      errorMessage,
      ...signer.proof(
        "complete",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          "canceled",
          "",
          "",
          errorMessage,
        ]),
      ),
    });
    expect(completed).toMatchObject({ state: "canceled" });

    expect(
      await t.mutation(refs.quiesceOwnerPlacement, {
        ownerId,
        operationId,
        generation: purge.generation,
        now: Date.now(),
      }),
    ).toMatchObject({ ready: true, pendingDispatches: 0 });
  });

  it("terminally reconciles a lost accepted executor only after its purge lease bound", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-purge-timeout");
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:purge-timeout",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    const operationId = "purge:placement-timeout";
    const now = Date.now();
    const purge = await t.mutation(refs.beginOwnerPurge, {
      ownerId,
      operationId,
      mode: "reset",
      now,
    });
    await t.mutation(refs.quiesceOwnerPlacement, {
      ownerId,
      operationId,
      generation: purge.generation,
      now,
    });
    const deadline = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      return row?.purgeCancelDeadlineAt;
    });
    expect(typeof deadline).toBe("number");
    const reconciled = await t.mutation(refs.quiesceOwnerPlacement, {
      ownerId,
      operationId,
      generation: purge.generation,
      now: deadline! + 1,
    });
    expect(reconciled).toMatchObject({
      ready: true,
      pendingDispatches: 0,
      terminalizedDispatches: 1,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "canceled",
      errorCode: "OWNER_PURGE_CANCEL_TIMEOUT",
    });
  });

  it("batches presence invalidation instead of imposing an unenforced device cap", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 65; index += 1) {
        await ctx.db.insert("desktop_execution_presence", {
          ownerId,
          ownerGeneration,
          deviceId: `desktop-purge-batch-${index}`,
          devicePublicKey: `key-${index}`,
          deviceKeyFingerprint: `fingerprint-${index}`,
          presenceSessionId: `presence-purge-batch-${index}`,
          protocolVersion,
          appVersion: "test",
          capabilities: ["chat"],
          status: index % 2 === 0 ? "ready" : "draining",
          heartbeatSeq: 1,
          proofSeq: 1,
          lastProofOperation: "presence-register",
          lastProofBodyHash: "body",
          chatSlotCapacity: 1,
          agentSlotCapacity: 0,
          availableChatSlots: 1,
          availableAgentSlots: 0,
          leaseExpiresAt: 10_000,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const operationId = "purge:placement-presence-batch";
    const purge = await t.mutation(refs.beginOwnerPurge, {
      ownerId,
      operationId,
      mode: "reset",
      now: 2,
    });
    expect(
      await t.mutation(refs.quiesceOwnerPlacement, {
        ownerId,
        operationId,
        generation: purge.generation,
        now: 3,
      }),
    ).toMatchObject({ ready: false, hasMore: true });
    expect(
      await t.mutation(refs.quiesceOwnerPlacement, {
        ownerId,
        operationId,
        generation: purge.generation,
        now: 4,
      }),
    ).toMatchObject({ ready: true, hasMore: false });
  });

  it("keeps account-link control rows until an exact signed cancellation ACK", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-migration-accepted-ack",
    );
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:migration-accepted-ack",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    const toOwnerId = "https://issuer.test|placement-destination";
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: ownerId,
          toOwnerId,
          status: "pending",
          fromOwnerGeneration: ownerGeneration,
          toOwnerGeneration: ownerGeneration,
          planRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
    );

    expect(
      await t.mutation(refs.quiesceOwnerPlacementMigration, {
        migrationId,
        ownerId,
        now: Date.now(),
      }),
    ).toMatchObject({
      ready: false,
      pendingDispatches: 1,
      cancellationSignals: 1,
    });
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(stored).toMatchObject({
        state: "cancel_pending",
        migrationId,
        migrationOwnerGeneration: ownerGeneration,
      });
      const presence = await ctx.db
        .query("desktop_execution_presence")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", deviceId),
        )
        .unique();
      expect(presence).toMatchObject({
        status: "draining",
        migrationId,
      });
    });
    expect(
      await asOwner(t).query(refs.accepted, {
        deviceId,
        presenceSessionId: signer.presenceSessionId,
      }),
    ).toEqual([
      expect.objectContaining({
        dispatchId: dispatch.dispatchId,
        state: "cancel_pending",
      }),
    ]);

    const errorMessage = "Canceled by account linking.";
    expect(
      await asOwner(t).mutation(refs.complete, {
        ownerGeneration,
        deviceId,
        presenceSessionId: signer.presenceSessionId,
        dispatchId: dispatch.dispatchId,
        claimToken: claimed.claimToken,
        outcome: "canceled",
        errorMessage,
        ...signer.proof(
          "complete",
          hashBody([
            dispatch.dispatchId,
            claimed.tokenHash,
            "canceled",
            "",
            "",
            errorMessage,
          ]),
        ),
      }),
    ).toMatchObject({ state: "canceled" });
    expect(
      await t.mutation(refs.quiesceOwnerPlacementMigration, {
        migrationId,
        ownerId,
        now: Date.now(),
      }),
    ).toMatchObject({ ready: true, pendingDispatches: 0 });
    expect(
      await t.mutation(refs.quiesceOwnerPlacementMigration, {
        migrationId,
        ownerId: toOwnerId,
        now: Date.now(),
      }),
    ).toMatchObject({ ready: true, pendingDispatches: 0 });
  });

  it("retires an account-link executor only after its exact lease plus grace", async () => {
    const t = createTest();
    const conversationId = await seedConversation(
      t,
      "conv-migration-accepted-timeout",
    );
    const signer = await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:migration-accepted-timeout",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    await asOwner(t).mutation(refs.ack, {
      ownerGeneration,
      deviceId,
      presenceSessionId: signer.presenceSessionId,
      dispatchId: dispatch.dispatchId,
      claimToken: claimed.claimToken,
      payloadHash: claimed.result.payloadHash,
      ...signer.proof(
        "claim-ack",
        hashBody([
          dispatch.dispatchId,
          claimed.tokenHash,
          claimed.result.payloadHash,
        ]),
      ),
    });
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: ownerId,
          toOwnerId: "https://issuer.test|placement-timeout-destination",
          status: "pending",
          fromOwnerGeneration: ownerGeneration,
          toOwnerGeneration: ownerGeneration,
          planRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const now = Date.now();
    expect(
      await t.mutation(refs.quiesceOwnerPlacementMigration, {
        migrationId,
        ownerId,
        now,
      }),
    ).toMatchObject({ ready: false, pendingDispatches: 1 });
    const deadline = await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      return stored?.migrationCancelDeadlineAt;
    });
    expect(deadline).toBeGreaterThan(now);
    expect(
      await t.mutation(refs.quiesceOwnerPlacementMigration, {
        migrationId,
        ownerId,
        now: deadline!,
      }),
    ).toMatchObject({ ready: true, pendingDispatches: 0 });
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatch.dispatchId),
        )
        .unique();
      expect(stored).toMatchObject({
        state: "canceled",
        migrationId,
        errorCode: "OWNER_MIGRATION_CANCEL_TIMEOUT",
      });
    });
  });

  it("fences concurrent owner migration races and every later placement writer", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-migration-race");
    const payloadJson = JSON.stringify({ prompt: "race-safe placement" });
    const submit = () =>
      t.mutation(refs.submitInternal, {
        ownerId,
        ownerGeneration,
        idempotencyKey: "mobile:migration-race",
        payloadJson,
        payloadHash: sha256(payloadJson),
        kind: "chat",
        ingress: "mobile",
        subject: "cloud",
        conversationId,
        requiredCapabilities: ["chat"],
        now: Date.now(),
      });

    // These two transactions are intentionally launched together. The
    // migration-index read in placement admission makes marker insertion an
    // OCC dependency: the writer either commits strictly before the marker or
    // retries and observes the permanent source fence.
    const [markerResult, writerResult] = await Promise.allSettled([
      t.run(async (ctx) => {
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: ownerId,
          toOwnerId: "https://issuer.test|placement-destination",
          status: "pending",
          fromOwnerGeneration: ownerGeneration,
          toOwnerGeneration: ownerGeneration,
          planRevision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }),
      submit(),
    ]);
    expect(markerResult.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(writerResult.status);

    const before = await t.run(async (ctx) => ({
      dispatches: (await ctx.db.query("execution_dispatches").collect()).length,
      payloads: (await ctx.db.query("execution_dispatch_payloads").collect())
        .length,
    }));
    await expect(submit()).rejects.toThrow(/linked to (?:an|another) account/);
    await expect(
      asOwner(t).query(refs.status, { dispatchId: "migration-stale-read" }),
    ).rejects.toThrow("linked to another account");

    const signer = createDeviceProofs();
    const capabilities = ["chat"] as const;
    const registerBody = hashBody([
      signer.publicKey,
      protocolVersion,
      "test",
      capabilities,
      "ready",
      1,
      0,
      1,
      0,
    ]);
    await expect(
      asOwner(t).mutation(refs.register, {
        ownerGeneration,
        deviceId,
        devicePublicKey: signer.publicKey,
        presenceSessionId: signer.presenceSessionId,
        protocolVersion,
        appVersion: "test",
        capabilities,
        status: "ready",
        chatSlotCapacity: 1,
        agentSlotCapacity: 0,
        availableChatSlots: 1,
        availableAgentSlots: 0,
        ...signer.proof("presence-register", registerBody),
      }),
    ).rejects.toThrow(/linked to (?:an|another) account/);

    const after = await t.run(async (ctx) => ({
      dispatches: (await ctx.db.query("execution_dispatches").collect()).length,
      payloads: (await ctx.db.query("execution_dispatch_payloads").collect())
        .length,
      presence: (await ctx.db.query("desktop_execution_presence").collect())
        .length,
    }));
    expect(after).toEqual({ ...before, presence: 0 });
  });
});

/**
 * Placement is invisible to the user, so a turn's attachments have to survive
 * both routes identically. These assert the envelope's own identity: the same
 * list reaches the desktop claimant's payload and the cloud turn's orchestrator
 * dispatch, and neither route may quietly shorten what the payload hash covers.
 */
describe("chat attachments across both placements", () => {
  const IMAGE = "uploads/2026-08-29/receipt.png";
  const DOCUMENT = "uploads/2026-08-29/lease.pdf";
  const attachments = [IMAGE, DOCUMENT];

  it("hands the desktop claimant the exact attachment list it was sent", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-attach-computer");
    const signer = await registerReadyDesktop(t, {
      extraCapabilities: ["attachments"],
    });
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-computer",
      prompt: "is this rent legal",
      subject: "computer",
      attachments,
      requiredCapabilities: ["chat", "attachments"],
    });
    expect(dispatch).toMatchObject({
      state: "offering",
      subject: "computer",
    });
    const claimed = await claim(t, signer, dispatch.dispatchId);
    expect(JSON.parse(claimed.result.payloadJson)).toEqual({
      prompt: "is this rent legal",
      attachments,
    });
    expect(claimed.result.payloadHash).toBe(sha256(claimed.result.payloadJson));
  });

  it("carries the same list into the cloud turn when no computer claims it", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-attach-cloud");
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-cloud",
      prompt: "is this rent legal",
      subject: "computer",
      attachments,
      requiredCapabilities: ["chat", "attachments"],
    });
    expect(dispatch).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
      fallbackReason: "no-eligible-paired-computer",
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    await t.run(async (ctx) => {
      const turns = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
        )
        .collect();
      expect(turns).toHaveLength(1);
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(
        scheduled.find((entry) =>
          entry.name.includes("runOrchestratorTurnInternal"),
        )?.args[0],
      ).toMatchObject({
        conversationId,
        turnId: turns[0]?.turnId,
        prompt: "is this rent legal",
        clientMsgId: dispatch.dispatchId,
        attachments,
      });
    });
  });

  it("still runs the turn on a desktop that predates attachment support, by using the cloud", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-attach-old-desktop");
    // A desktop registered without "attachments" is reachable and ready; it
    // simply cannot resolve a drive path. Gating the capability rather than
    // bumping the protocol version keeps it eligible for text-only turns.
    await registerReadyDesktop(t);
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-old-desktop",
      subject: "computer",
      attachments: [IMAGE],
      requiredCapabilities: ["chat", "attachments"],
    });
    expect(dispatch).toMatchObject({
      state: "cloud_committed",
      placement: "cloud",
      subject: "computer",
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({ state: "cloud_running" });

    const textOnly = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-old-desktop-text",
      subject: "computer",
    });
    expect(textOnly).toMatchObject({ state: "offering" });
  });

  it("fails the turn rather than truncating an over-budget list", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-attach-over-budget");
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-over-budget",
      subject: "portable",
      attachments: Array.from(
        { length: 5 },
        (_, index) => `uploads/2026-08-29/p${index}.png`,
      ),
    });
    expect(dispatch).toMatchObject({ state: "cloud_committed" });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "failed",
      errorMessage: "A chat turn may carry at most 4 attachments.",
    });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("agent_turns")
          .withIndex("by_ownerId_and_clientMsgId", (q) =>
            q.eq("ownerId", ownerId).eq("clientMsgId", dispatch.dispatchId),
          )
          .collect(),
      ).toHaveLength(0);
    });
  });

  it("fails a path that could never resolve to a drive row", async () => {
    const t = createTest();
    const conversationId = await seedConversation(t, "conv-attach-bad-path");
    const dispatch = await submitMobile(t, {
      conversationId,
      idempotencyKey: "mobile:attach-bad-path",
      subject: "portable",
      attachments: ["uploads/../../etc/passwd"],
    });
    await t.action(refs.executeCloud, {
      ownerId,
      ownerGeneration,
      dispatchId: dispatch.dispatchId,
    });
    expect(
      await asOwner(t).query(refs.status, { dispatchId: dispatch.dispatchId }),
    ).toMatchObject({
      state: "failed",
      errorMessage: "A chat attachment does not name a drive file.",
    });
  });
});
