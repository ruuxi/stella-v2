/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { executionDeviceRegistration } from "@stella/contracts/turn-plane/placement";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ownerId = "https://issuer.test|devices-owner";
const otherOwnerId = "https://issuer.test|devices-other";
const BUILDER_URL = "https://builder.test";

const refs = {
  identity: makeFunctionReference<"query">(
    "execution_placement:getMyExecutionPlacementIdentity",
  ),
  register: makeFunctionReference<"mutation">(
    "execution_placement:registerMyExecutionDevice",
  ),
  setRemoteEnabled: makeFunctionReference<"mutation">(
    "execution_placement:setMyExecutionDeviceRemoteEnabled",
  ),
  remove: makeFunctionReference<"mutation">(
    "execution_placement:removeMyExecutionDevice",
  ),
  activity: makeFunctionReference<"query">(
    "execution_placement:listMyExecutionActivity",
  ),
};

beforeAll(() => {
  process.env.CLOUD_BUILDER_URL = BUILDER_URL;
});

afterEach(() => {
  process.env.CLOUD_BUILDER_URL = BUILDER_URL;
});

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
type TestHarness = ReturnType<typeof createTest>;

const asOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "devices-owner",
    tokenIdentifier: ownerId,
    iat: 1_000,
  });

const asAnonymous = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "devices-anon",
    tokenIdentifier: "https://issuer.test|devices-anon",
    isAnonymous: true,
    iat: 1_000,
  });

const snapshotPushes = (t: TestHarness) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((entry) => entry.name.includes("notifyOwnerSnapshotChanged"))
      .map((entry) => (entry.args[0] as { ownerId: string; reason: string })),
  );

const devices = (t: TestHarness) =>
  t.run(async (ctx) => await ctx.db.query("devices").collect());

describe("execution device identity", () => {
  it("hands the desktop its owner fence and the owner gate's origin", async () => {
    const t = createTest();
    const identity = (await asOwner(t).query(refs.identity, {})) as {
      ownerId: string;
      ownerGeneration: string;
      deviceId?: string;
      builderOrigin?: string;
    };
    expect(identity).toEqual({
      ownerId,
      ownerGeneration: "legacy",
      builderOrigin: BUILDER_URL,
    });
  });

  it("resolves a retired device id to its successor", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("device_identity_successors", {
        ownerId,
        previousDeviceId: "old-desktop",
        deviceId: "new-desktop",
        rotatedAt: 1,
      });
    });
    const identity = (await asOwner(t).query(refs.identity, {
      deviceId: "old-desktop",
    })) as { deviceId?: string };
    expect(identity.deviceId).toBe("new-desktop");
  });

  it("omits the origin when the builder is not configured", async () => {
    const t = createTest();
    delete process.env.CLOUD_BUILDER_URL;
    const identity = (await asOwner(t).query(refs.identity, {})) as {
      builderOrigin?: string;
    };
    expect(identity.builderOrigin).toBeUndefined();
  });

  it("refuses anonymous callers", async () => {
    const t = createTest();
    await expect(asAnonymous(t).query(refs.identity, {})).rejects.toThrow(
      /Sign in with an account/,
    );
  });
});

describe("registerMyExecutionDevice", () => {
  it("accepts exactly the payload the desktop placement bridge sends", async () => {
    // The bridge builds its registration through the shared contract; this is
    // the argument validator's side of that contract. The desktop advertises
    // every capability a Mac or Windows host can carry.
    const t = createTest();
    const registration = executionDeviceRegistration({
      deviceId: "23ea5501-2d2e-46c3-b16c-625a5e4f07c0",
      devicePublicKey: "MCowBQYDK2VwAyEA",
      deviceName: "Studio MacBook",
      platform: "darwin",
      capabilities: [
        "chat",
        "agent",
        "local-files",
        "attachments",
        "computer-use",
        "local-apps",
      ],
    });
    expect(Object.keys(registration).sort()).toEqual([
      "capabilities",
      "deviceId",
      "deviceName",
      "devicePublicKey",
      "platform",
    ]);
    const result = await asOwner(t).mutation(refs.register, registration);
    expect(result).toMatchObject({
      deviceId: registration.deviceId,
      remoteExecutionEnabled: true,
      rotated: false,
    });
    const rows = await devices(t);
    expect(rows[0]).toMatchObject({
      devicePublicKey: "MCowBQYDK2VwAyEA",
      deviceName: "Studio MacBook",
      platform: "darwin",
      executionCapabilities: [
        "agent",
        "attachments",
        "chat",
        "computer-use",
        "local-apps",
        "local-files",
      ],
    });
  });

  it("rejects the pre-contract bridge payload instead of registering half a device", async () => {
    const t = createTest();
    await expect(
      asOwner(t).mutation(refs.register, {
        deviceId: "desktop-legacy",
        publicKey: "key-a",
        label: "Studio",
        capabilities: ["chat"],
      }),
    ).rejects.toThrow();
    expect(await devices(t)).toHaveLength(0);
  });

  it("binds the key, label and capabilities without any presence lease", async () => {
    const t = createTest();
    const result = await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
      deviceName: "Studio",
      platform: "darwin",
      capabilities: ["local-files", "chat", "chat"],
    });
    expect(result).toEqual({
      deviceId: "desktop-1",
      ownerGeneration: "legacy",
      remoteExecutionEnabled: true,
      rotated: false,
    });
    const rows = await devices(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId,
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
      deviceName: "Studio",
      platform: "darwin",
      // Deduplicated and ordered so the snapshot is stable across re-registers.
      executionCapabilities: ["chat", "local-files"],
    });
    expect(rows[0]?.executionRegisteredAt).toBeGreaterThan(0);
    expect(await snapshotPushes(t)).toEqual([{ ownerId, reason: "device" }]);
  });

  it("rotates the key in place and pushes the snapshot again", async () => {
    const t = createTest();
    await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
      deviceName: "Studio",
    });
    const rotated = await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-b",
      deviceName: "Studio",
    });
    expect(rotated).toMatchObject({ rotated: true });
    const rows = await devices(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.devicePublicKey).toBe("key-b");
    expect(await snapshotPushes(t)).toHaveLength(2);
  });

  it("does not re-announce an unchanged re-registration", async () => {
    const t = createTest();
    await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
      deviceName: "Studio",
    });
    await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
      deviceName: "Studio",
    });
    expect(await snapshotPushes(t)).toHaveLength(1);
  });

  it("rejects an empty key and refuses anonymous callers", async () => {
    const t = createTest();
    await expect(
      asOwner(t).mutation(refs.register, {
        deviceId: "desktop-1",
        devicePublicKey: "   ",
      }),
    ).rejects.toThrow(/devicePublicKey is required/);
    await expect(
      asAnonymous(t).mutation(refs.register, {
        deviceId: "desktop-1",
        devicePublicKey: "key-a",
      }),
    ).rejects.toThrow(/Sign in with an account/);
  });
});

describe("execution device settings", () => {
  it("toggles remote execution once and announces it", async () => {
    const t = createTest();
    await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
    });
    await asOwner(t).mutation(refs.setRemoteEnabled, {
      deviceId: "desktop-1",
      enabled: false,
    });
    // Already disabled: nothing changed, so nothing is pushed.
    await asOwner(t).mutation(refs.setRemoteEnabled, {
      deviceId: "desktop-1",
      enabled: false,
    });
    expect((await devices(t))[0]?.remoteExecutionEnabled).toBe(false);
    expect(await snapshotPushes(t)).toEqual([
      { ownerId, reason: "device" },
      { ownerId, reason: "device" },
    ]);
  });

  it("refuses a device the caller does not own", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("devices", {
        ownerId: otherOwnerId,
        deviceId: "desktop-other",
        devicePublicKey: "key-other",
      });
    });
    await expect(
      asOwner(t).mutation(refs.setRemoteEnabled, {
        deviceId: "desktop-other",
        enabled: false,
      }),
    ).rejects.toThrow(/Execution device not found/);
  });

  it("removes a device and announces it", async () => {
    const t = createTest();
    await asOwner(t).mutation(refs.register, {
      deviceId: "desktop-1",
      devicePublicKey: "key-a",
    });
    await asOwner(t).mutation(refs.remove, { deviceId: "desktop-1" });
    expect(await devices(t)).toEqual([]);
    expect(await snapshotPushes(t)).toHaveLength(2);
    // Removing what is already gone announces nothing.
    await asOwner(t).mutation(refs.remove, { deviceId: "desktop-1" });
    expect(await snapshotPushes(t)).toHaveLength(2);
  });
});

describe("listMyExecutionActivity", () => {
  const seedDispatch = (
    t: TestHarness,
    fields: {
      dispatchId: string;
      ownerId?: string;
      updatedAt: number;
      placement?: "computer" | "cloud";
    },
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("cloud_dispatches", {
        dispatchId: fields.dispatchId,
        ownerId: fields.ownerId ?? ownerId,
        ownerGeneration: "legacy",
        idempotencyKey: `idem-${fields.dispatchId}`,
        kind: "chat",
        ingress: "desktop",
        subject: "portable",
        conversationId: "conv-1",
        state: "completed",
        ...(fields.placement ? { placement: fields.placement } : {}),
        revision: 1,
        createdAt: 1,
        updatedAt: fields.updatedAt,
      });
    });

  it("returns the owner's dispatches newest first with a placement label", async () => {
    const t = createTest();
    await seedDispatch(t, { dispatchId: "d-old", updatedAt: 10 });
    await seedDispatch(t, {
      dispatchId: "d-new",
      updatedAt: 20,
      placement: "computer",
    });
    await seedDispatch(t, {
      dispatchId: "d-foreign",
      ownerId: otherOwnerId,
      updatedAt: 30,
    });
    const activity = (await asOwner(t).query(refs.activity, {})) as Array<{
      dispatch: { dispatchId: string };
      placementLabel: string;
    }>;
    expect(activity.map((entry) => entry.dispatch.dispatchId)).toEqual([
      "d-new",
      "d-old",
    ]);
    expect(activity.map((entry) => entry.placementLabel)).toEqual([
      "computer",
      "routing",
    ]);
  });

  it("clamps the requested limit", async () => {
    const t = createTest();
    for (let index = 0; index < 4; index += 1) {
      await seedDispatch(t, { dispatchId: `d-${index}`, updatedAt: index });
    }
    const activity = (await asOwner(t).query(refs.activity, {
      limit: 0,
    })) as unknown[];
    expect(activity).toHaveLength(1);
  });
});
