import { describe, expect, test } from "bun:test";
import { GatewayError } from "../src/errors.js";
import type { DeviceCodeFixtureClient } from "../src/device-code-fixture-client.js";
import { BrowserProfileSessionCore } from "../src/profile-session-core.js";
import { MemoryProfileStore } from "../src/profile-store.js";
import {
  AUTHORITY,
  FakeBrowser,
  MemoryR2,
  TEST_KEK,
  uuid,
} from "./fixtures.js";
import { encryptAsClient } from "./session-transfer-crypto.test.js";

const command = (
  requestId: string,
  action: string,
  params: Record<string, unknown>,
) =>
  ({
    schemaVersion: 1,
    authority: AUTHORITY,
    command: { schemaVersion: 1, requestId, action, params },
  }) as never;

const interactionRequest = (
  interactionId: string,
  interactionRevision: number,
  decision?: "done" | "cancel",
) =>
  ({
    schemaVersion: 1,
    authority: AUTHORITY,
    profileId: "default",
    profileEpoch: 1,
    interactionId,
    interactionRevision,
    ...(decision ? { decision } : {}),
  }) as never;

describe("browser profile session core", () => {
  test("imports an encrypted local session without consuming the remote fallback", async () => {
    const store = new MemoryProfileStore();
    const bucket = new MemoryR2();
    const browser = new FakeBrowser();
    let nextUuid = 1_100;
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: bucket.asBucket(),
      kekV1: TEST_KEK,
      now: () => 2_000_000,
      randomUuid: () => uuid(nextUuid++),
    });
    await core.turn(
      command(uuid(1_001), "browser.open", {
        allowedOrigins: ["https://app.example"],
        startUrl: "https://app.example/login",
      }),
    );
    const suspended = (await core.turn(
      command(uuid(1_002), "browser.login_takeover", {
        allowedOrigins: ["https://app.example"],
        displayOrigin: "https://app.example",
        startUrl: "https://app.example/login",
        verification: {
          expectedOrigin: "https://app.example",
          authenticatedSelector: "#authenticated",
          loggedOutSelector: "#login",
          resumeUrl: "https://app.example/account",
        },
      }),
    )) as any;
    const interactionId = suspended.suspension.interactionId as string;
    const request = interactionRequest(interactionId, 1);
    const capability = (await core.sessionTransferCapability(request)) as any;
    const payload = {
      cookies: [
        {
          name: "session",
          value: "local-session-secret",
          domain: "app.example",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    const transfer = await encryptAsClient({
      publicKey: capability.publicKey,
      binding: {
        capabilityId: capability.capabilityId,
        interactionId,
        interactionRevision: 1,
        displayOrigin: "https://app.example",
      },
      payload,
    });
    const imported = await core.importSessionTransfer({
      ...request,
      sessionTransfer: transfer,
    });
    expect(imported).toEqual({
      schemaVersion: 1,
      interactionId,
      revision: 1,
      verified: true,
    });
    expect(store.interactions.get(interactionId)).toMatchObject({
      revision: 1,
      state: "human_control",
      verification: { localImportVerified: true },
    });
    expect(store.state).toMatchObject({
      phase: "HUMAN_CONTROL",
      activeInteractionId: interactionId,
    });
    expect(browser.closeCount).toBe(0);
    expect(bucket.objects.size).toBe(1);
    for (const object of bucket.objects.values()) {
      expect(new TextDecoder().decode(object.bytes)).not.toContain(
        "local-session-secret",
      );
    }

    const decision = (await core.decide(
      interactionRequest(interactionId, 1, "done"),
    )) as any;
    expect(decision.receipt.result).toBe("approved");
    expect(browser.completeHandoffCalls).toContain(false);
    expect(store.state?.phase).toBe("AGENT_CONTROL");
  });

  test("fences automation, mints JIT Live View, encrypts, and verifies a fresh restore", async () => {
    const store = new MemoryProfileStore();
    const bucket = new MemoryR2();
    const browser = new FakeBrowser();
    let nextUuid = 100;
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: bucket.asBucket(),
      kekV1: TEST_KEK,
      now: () => 1_000_000,
      randomUuid: () => uuid(nextUuid++),
    });

    await core.turn(
      command(uuid(1), "browser.open", {
        allowedOrigins: ["https://app.example"],
        startUrl: "https://app.example/login?opaque=one",
      }),
    );
    const suspension = (await core.turn(
      command(uuid(2), "browser.login_takeover", {
        allowedOrigins: ["https://app.example"],
        displayOrigin: "https://app.example",
        startUrl: "https://app.example/login",
        verification: {
          expectedOrigin: "https://app.example",
          authenticatedSelector: "#authenticated",
          loggedOutSelector: "#login",
          resumeUrl: "https://app.example/account",
        },
      }),
    )) as any;
    expect(suspension.outcome).toBe("suspended");
    expect(JSON.stringify(suspension)).not.toContain("live.browser.run");
    expect(store.state?.phase).toBe("HUMAN_CONTROL");

    await expect(
      core.turn(command(uuid(3), "browser.observe", {})),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "human_control_active",
    });

    const interactionId = suspension.suspension.interactionId as string;
    const capability = (await core.liveView(
      interactionRequest(interactionId, 1),
    )) as any;
    expect(capability.url).toBe("https://live.browser.run/jit-capability");
    expect(capability.revision).toBe(1);

    const decision = (await core.decide(
      interactionRequest(interactionId, 1, "done"),
    )) as any;
    expect(decision.receipt.result).toBe("approved");
    expect(decision.receipt.interactionRevision).toBe(1);
    await expect(
      core.decide(interactionRequest(interactionId, 1, "done")),
    ).resolves.toEqual(decision);
    expect(browser.verificationStates).toEqual([
      "logged_out",
      "authenticated",
      "authenticated",
    ]);
    expect(browser.closeCount).toBe(1);
    expect(browser.ensureCount).toBeGreaterThanOrEqual(2);
    expect(browser.restoredStates).toHaveLength(1);
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(store.state?.activeInteractionId).toBeUndefined();
    expect(bucket.objects.size).toBe(1);
    for (const object of bucket.objects.values()) {
      expect(new TextDecoder().decode(object.bytes)).not.toContain(
        browser.storageMarker,
      );
      expect(Object.keys(object.customMetadata ?? {}).sort()).toEqual([
        "keyVersion",
        "objectSha256",
        "schema",
      ]);
    }

    const reset = (await core.reset({
      schemaVersion: 1,
      authority: {
        ownerId: AUTHORITY.ownerId,
        ownerGeneration: AUTHORITY.ownerGeneration,
      },
      requestId: uuid(4),
      profileId: "default",
    })) as any;
    const replay = (await core.reset({
      schemaVersion: 1,
      authority: {
        ownerId: AUTHORITY.ownerId,
        ownerGeneration: AUTHORITY.ownerGeneration,
      },
      requestId: uuid(4),
      profileId: "default",
    })) as any;
    expect(reset.profileEpoch).toBe(2);
    expect(replay.profileEpoch).toBe(2);
    expect(bucket.objects.size).toBe(0);
    await expect(
      core.interactionStatus(interactionRequest(interactionId, 3)),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "stale_interaction",
    });
  });

  test("releases the human-control lock at its durable alarm boundary", async () => {
    const store = new MemoryProfileStore();
    const browser = new FakeBrowser();
    let now = 3_000_000;
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => now,
      randomUuid: () => uuid(500),
    });
    await core.turn(
      command(uuid(20), "browser.open", {
        allowedOrigins: ["https://app.example"],
        startUrl: "https://app.example/login",
      }),
    );
    await core.turn(
      command(uuid(21), "browser.login_takeover", {
        allowedOrigins: ["https://app.example"],
        displayOrigin: "https://app.example",
        expiresInMs: 60_000,
        verification: {
          expectedOrigin: "https://app.example",
          authenticatedSelector: "#logout",
          loggedOutSelector: "#login",
          resumeUrl: "https://app.example/account",
        },
      }),
    );
    expect(store.state?.phase).toBe("HUMAN_CONTROL");
    now += 60_001;
    await core.expireActive();
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(store.state?.activeInteractionId).toBeUndefined();
    expect(browser.closeCount).toBe(1);
  });

  test("an old decision cannot clear a newer interaction's human-control lock", async () => {
    const store = new MemoryProfileStore();
    const browser = new FakeBrowser();
    let nextUuid = 600;
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => 3_250_000,
      randomUuid: () => uuid(nextUuid++),
    });
    const takeover = async (requestId: string) =>
      (await core.turn(
        command(requestId, "browser.login_takeover", {
          allowedOrigins: ["https://app.example"],
          displayOrigin: "https://app.example",
          verification: {
            expectedOrigin: "https://app.example",
            authenticatedSelector: "#logout",
            loggedOutSelector: "#login",
            resumeUrl: "https://app.example/account",
          },
        }),
      )) as any;

    const first = await takeover(uuid(40));
    const firstInteractionId = first.suspension.interactionId as string;
    store.putState({
      ...store.state!,
      phase: "AGENT_CONTROL",
      activeInteractionId: undefined,
    });
    const second = await takeover(uuid(41));
    const secondInteractionId = second.suspension.interactionId as string;

    await expect(
      core.decide(interactionRequest(firstInteractionId, 1, "cancel")),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "stale_interaction",
    });
    expect(store.interactions.get(firstInteractionId)).toMatchObject({
      state: "human_control",
      revision: 1,
    });
    expect(store.interactions.get(secondInteractionId)).toMatchObject({
      state: "human_control",
      revision: 1,
    });
    expect(store.state).toMatchObject({
      phase: "HUMAN_CONTROL",
      activeInteractionId: secondInteractionId,
    });
  });

  test("retries teardown when expiry is terminal but still owns human control", async () => {
    const store = new MemoryProfileStore();
    const browser = new FakeBrowser();
    let now = 3_500_000;
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => now,
      randomUuid: () => uuid(510),
    });
    await core.turn(
      command(uuid(30), "browser.open", {
        allowedOrigins: ["https://app.example"],
        startUrl: "https://app.example/login",
      }),
    );
    const suspended = (await core.turn(
      command(uuid(31), "browser.login_takeover", {
        allowedOrigins: ["https://app.example"],
        displayOrigin: "https://app.example",
        expiresInMs: 60_000,
        verification: {
          expectedOrigin: "https://app.example",
          authenticatedSelector: "#logout",
          loggedOutSelector: "#login",
          resumeUrl: "https://app.example/account",
        },
      }),
    )) as any;
    const interactionId = suspended.suspension.interactionId as string;
    browser.closeFailuresRemaining = 1;
    now += 60_001;

    await expect(core.expireActive()).rejects.toThrow(
      "injected remote browser close failure",
    );
    expect(store.interactions.get(interactionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.state).toMatchObject({
      phase: "HUMAN_CONTROL",
      activeInteractionId: interactionId,
    });
    expect(core.hasActiveCleanupDebt()).toBe(true);

    await core.expireActive();
    expect(store.interactions.get(interactionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(store.state?.activeInteractionId).toBeUndefined();
    expect(store.state?.browserSessionId).toBeUndefined();
    expect(browser.closeCount).toBe(1);
    expect(core.hasActiveCleanupDebt()).toBe(false);
  });

  test("device-code fixture encrypts its private grant and consumes approval exactly once", async () => {
    const store = new MemoryProfileStore();
    const browser = new FakeBrowser();
    const privateDeviceCode = "Z".repeat(43);
    let providerStatus:
      | "authorization_pending"
      | "approved"
      | "access_denied"
      | "expired_token"
      | "already_consumed"
      | "invalid_grant" = "authorization_pending";
    let consumeCalls = 0;
    const deviceCodeFixture: DeviceCodeFixtureClient = {
      authorize: async () => ({
        schemaVersion: 1,
        deviceCode: privateDeviceCode,
        userCode: "BCDF-2345",
        verificationUri: "https://device.example/activate",
        verificationUriComplete:
          "https://device.example/activate?user_code=BCDF-2345",
        expiresAt: 2_300_000,
        intervalSeconds: 2,
      }),
      status: async (grant) => {
        expect(grant).toEqual({
          userCode: "BCDF-2345",
          deviceCode: privateDeviceCode,
        });
        return { schemaVersion: 1, status: providerStatus };
      },
      consume: async (grant, consumerId) => {
        consumeCalls += 1;
        expect(grant).toEqual({
          userCode: "BCDF-2345",
          deviceCode: privateDeviceCode,
        });
        expect(consumerId).toBe(uuid(201));
        return { schemaVersion: 1, outcome: "approved" };
      },
    };
    const core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => 2_000_000,
      randomUuid: () => uuid(201),
      deviceCodeFixture,
    });
    const suspended = (await core.turn(
      command(uuid(10), "device_code.fixture_start", {}),
    )) as any;
    const interactionId = suspended.suspension.interactionId as string;
    expect(suspended.suspension.interactionKind).toBe("device_code");
    expect(suspended.suspension.toolCallId).toBe(uuid(10));
    expect(browser.ensureCount).toBe(0);
    expect(store.state?.phase).toBe("HUMAN_CONTROL");
    expect(store.state?.activeInteractionId).toBe(interactionId);
    await expect(
      core.turn(command(uuid(11), "browser.observe", {})),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "human_control_active",
    });

    const status = (await core.interactionStatus(
      interactionRequest(interactionId, 1),
    )) as any;
    expect(status.interaction.verificationUri).toBe(
      "https://device.example/activate",
    );
    expect(status.interaction.verificationUriComplete).toBe(
      "https://device.example/activate?user_code=BCDF-2345",
    );
    expect(status.interaction.userCode).toBe("BCDF-2345");
    const publicBoundary = JSON.stringify({ suspended, status });
    expect(publicBoundary).not.toContain(privateDeviceCode);
    expect(JSON.stringify([...store.interactions.values()])).not.toContain(
      privateDeviceCode,
    );

    await expect(
      core.decide(interactionRequest(interactionId, 1, "done")),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "verification_failed",
    });
    providerStatus = "approved";
    const decision = (await core.decide(
      interactionRequest(interactionId, 1, "done"),
    )) as any;
    expect(decision.receipt.result).toBe("approved");
    expect(decision.receipt).toEqual({
      schemaVersion: 1,
      interactionId,
      interactionRevision: 1,
      profileId: "default",
      profileEpoch: 1,
      toolCallId: uuid(10),
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      result: "approved",
      safeMessage: "Browser access is ready.",
    });
    await expect(
      core.decide(interactionRequest(interactionId, 1, "done")),
    ).resolves.toEqual(decision);
    expect(consumeCalls).toBe(1);
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(store.state?.activeInteractionId).toBeUndefined();
    expect(store.interactions.get(interactionId)?.verification).toBeUndefined();
    expect(JSON.stringify([...store.interactions.values()])).not.toContain(
      privateDeviceCode,
    );
  });

  test("recovers an exact consume replay after the fixture success response is lost", async () => {
    const store = new MemoryProfileStore();
    const privateDeviceCode = "R".repeat(43);
    let consumedBy: string | undefined;
    let consumeCalls = 0;
    const core = new BrowserProfileSessionCore({
      store,
      browser: new FakeBrowser(),
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => 2_000_000,
      randomUuid: () => uuid(220),
      deviceCodeFixture: {
        authorize: async () => ({
          schemaVersion: 1,
          deviceCode: privateDeviceCode,
          userCode: "BCDF-2345",
          verificationUri: "https://device.example/activate",
          verificationUriComplete:
            "https://device.example/activate?user_code=BCDF-2345",
          expiresAt: 2_300_000,
          intervalSeconds: 2,
        }),
        status: async () => ({
          schemaVersion: 1,
          status: consumedBy ? "already_consumed" : "approved",
        }),
        consume: async (_grant, consumerId) => {
          consumeCalls += 1;
          if (consumedBy === undefined) {
            consumedBy = consumerId;
            throw new Error("lost service-binding response");
          }
          return {
            schemaVersion: 1,
            outcome:
              consumedBy === consumerId ? "approved" : "already_consumed",
          };
        },
      },
    });
    const suspended = (await core.turn(
      command(uuid(219), "device_code.fixture_start", {}),
    )) as any;
    const request = interactionRequest(
      suspended.suspension.interactionId,
      1,
      "done",
    );

    await expect(core.decide(request)).rejects.toThrow(
      "lost service-binding response",
    );
    const recovered = (await core.decide(request)) as any;
    expect(recovered.receipt.result).toBe("approved");
    expect(consumedBy).toBe(suspended.suspension.interactionId);
    expect(consumeCalls).toBe(2);
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(
      store.interactions.get(suspended.suspension.interactionId)?.verification,
    ).toBeUndefined();
  });

  test("expires an abandoned device-code interaction and removes its encrypted grant", async () => {
    const store = new MemoryProfileStore();
    let now = 4_000_000;
    const core = new BrowserProfileSessionCore({
      store,
      browser: new FakeBrowser(),
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      now: () => now,
      randomUuid: () => uuid(230),
      deviceCodeFixture: {
        authorize: async () => ({
          schemaVersion: 1,
          deviceCode: "E".repeat(43),
          userCode: "BCDF-2345",
          verificationUri: "https://device.example/activate",
          verificationUriComplete:
            "https://device.example/activate?user_code=BCDF-2345",
          expiresAt: 4_300_000,
          intervalSeconds: 2,
        }),
        status: async () => ({
          schemaVersion: 1,
          status: "authorization_pending",
        }),
        consume: async () => ({
          schemaVersion: 1,
          outcome: "authorization_pending",
        }),
      },
    });
    const suspended = (await core.turn(
      command(uuid(229), "device_code.fixture_start", {}),
    )) as any;
    const interactionId = suspended.suspension.interactionId as string;
    expect(store.interactions.get(interactionId)?.verification).toBeDefined();
    expect(store.state?.activeInteractionId).toBe(interactionId);

    now = 4_300_001;
    await core.expireActive();

    expect(store.interactions.get(interactionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.interactions.get(interactionId)?.verification).toBeUndefined();
    expect(store.state?.phase).toBe("AGENT_CONTROL");
    expect(store.state?.activeInteractionId).toBeUndefined();
  });

  test("device-code denial, expiry, consumed, and invalid grants fail closed", async () => {
    const outcomes = [
      ["access_denied", "canceled"],
      ["expired_token", "expired"],
      ["already_consumed", "failed"],
      ["invalid_grant", "failed"],
    ] as const;
    for (const [providerStatus, expectedResult] of outcomes) {
      let consumeCalls = 0;
      const core = new BrowserProfileSessionCore({
        store: new MemoryProfileStore(),
        browser: new FakeBrowser(),
        bucket: new MemoryR2().asBucket(),
        kekV1: TEST_KEK,
        now: () => 3_000_000,
        randomUuid: () => uuid(250),
        deviceCodeFixture: {
          authorize: async () => ({
            schemaVersion: 1,
            deviceCode: "Y".repeat(43),
            userCode: "BCDF-2345",
            verificationUri: "https://device.example/activate",
            verificationUriComplete:
              "https://device.example/activate?user_code=BCDF-2345",
            expiresAt: 3_300_000,
            intervalSeconds: 2,
          }),
          status: async () => ({ schemaVersion: 1, status: providerStatus }),
          consume: async () => {
            consumeCalls += 1;
            return {
              schemaVersion: 1,
              outcome:
                providerStatus === "already_consumed"
                  ? "already_consumed"
                  : "approved",
            };
          },
        },
      });
      const suspended = (await core.turn(
        command(uuid(251), "device_code.fixture_start", {}),
      )) as any;
      const decision = (await core.decide(
        interactionRequest(suspended.suspension.interactionId, 1, "done"),
      )) as any;
      expect(decision.receipt.result).toBe(expectedResult);
      expect(consumeCalls).toBe(providerStatus === "already_consumed" ? 1 : 0);
    }
  });

  test("rejects selector oracles and caller-supplied tool identities", async () => {
    const browser = new FakeBrowser();
    const core = new BrowserProfileSessionCore({
      store: new MemoryProfileStore(),
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      randomUuid: () => uuid(900),
    });
    await core.turn(
      command(uuid(901), "browser.open", {
        allowedOrigins: ["https://app.example"],
        startUrl: "https://app.example/",
      }),
    );

    for (const selector of [
      '[value^="a"]',
      "text=secret",
      ".card:has(#secret)",
      "input",
      "#one, #two",
      "#one #two",
    ]) {
      await expect(
        core.turn(command(crypto.randomUUID(), "browser.wait", { selector })),
      ).rejects.toMatchObject<Partial<GatewayError>>({ code: "bad_request" });
    }

    await expect(
      core.turn(
        command(uuid(902), "device_code.fixture_start", {
          toolCallId: "model-supplied",
        }),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({ code: "bad_request" });
    await expect(
      core.turn(
        command(uuid(904), "device_code.fixture_start", {
          expiresInMs: 10 * 60_000,
        }),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({ code: "bad_request" });
    await expect(
      core.turn(
        command(uuid(903), "browser.login_takeover", {
          allowedOrigins: ["https://app.example"],
          displayOrigin: "https://app.example",
          toolCallId: "model-supplied",
          verification: {
            expectedOrigin: "https://app.example",
            authenticatedSelector: "#logout",
            loggedOutSelector: "#login",
            resumeUrl: "https://app.example/",
          },
        }),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({ code: "bad_request" });
  });

  test("aborts before handoff when the displayed, navigated, or resume origin differs", async () => {
    const create = (browser = new FakeBrowser()) => ({
      browser,
      core: new BrowserProfileSessionCore({
        store: new MemoryProfileStore(),
        browser,
        bucket: new MemoryR2().asBucket(),
        kekV1: TEST_KEK,
        randomUuid: () => uuid(950),
      }),
    });
    const verification = {
      expectedOrigin: "https://app.example",
      authenticatedSelector: "#logout",
      loggedOutSelector: "#login",
      resumeUrl: "https://app.example/account",
    };

    {
      const { core, browser } = create();
      await expect(
        core.turn(
          command(uuid(951), "browser.login_takeover", {
            allowedOrigins: ["https://app.example", "https://evil.example"],
            displayOrigin: "https://app.example",
            startUrl: "https://evil.example/phish",
            verification,
          }),
        ),
      ).rejects.toMatchObject<Partial<GatewayError>>({
        code: "navigation_denied",
      });
      expect(browser.handoffCount).toBe(0);
    }

    {
      const { core, browser } = create();
      await expect(
        core.turn(
          command(uuid(952), "browser.login_takeover", {
            allowedOrigins: ["https://app.example"],
            displayOrigin: "https://app.example",
            startUrl: "https://app.example/login",
            verification: {
              ...verification,
              resumeUrl: "https://evil.example/account",
            },
          }),
        ),
      ).rejects.toMatchObject<Partial<GatewayError>>({
        code: "navigation_denied",
      });
      expect(browser.handoffCount).toBe(0);
    }

    {
      const redirecting = new FakeBrowser();
      redirecting.navigate = async () => ({
        url: "https://evil.example/phish",
        title: "Sign in",
        text: "",
      });
      const { core, browser } = create(redirecting);
      await expect(
        core.turn(
          command(uuid(953), "browser.login_takeover", {
            allowedOrigins: ["https://app.example"],
            displayOrigin: "https://app.example",
            startUrl: "https://app.example/login",
            verification,
          }),
        ),
      ).rejects.toMatchObject<Partial<GatewayError>>({
        code: "navigation_denied",
      });
      expect(browser.closeCount).toBe(1);
      expect(browser.handoffCount).toBe(0);
    }
  });

  test("requires a logged-out baseline before exposing Live View", async () => {
    const browser = new FakeBrowser();
    browser.verificationResult = false;
    const core = new BrowserProfileSessionCore({
      store: new MemoryProfileStore(),
      browser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      randomUuid: () => uuid(980),
    });
    await expect(
      core.turn(
        command(uuid(981), "browser.login_takeover", {
          allowedOrigins: ["https://app.example"],
          displayOrigin: "https://app.example",
          startUrl: "https://app.example/login",
          verification: {
            expectedOrigin: "https://app.example",
            authenticatedSelector: "#logout",
            loggedOutSelector: "#login",
            resumeUrl: "https://app.example/account",
          },
        }),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: "verification_failed",
    });
    expect(browser.verificationStates).toEqual(["logged_out"]);
    expect(browser.closeCount).toBe(1);
    expect(browser.handoffCount).toBe(0);
  });
});
