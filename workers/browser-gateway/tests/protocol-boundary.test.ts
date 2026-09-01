import { describe, expect, test } from "bun:test";
import {
  MAX_REQUEST_BYTES,
  PROFILE_ID,
  parseInteraction,
  parseOwnerPurge,
  parseTurnCommand,
  profileObjectName,
} from "../src/protocol.js";
import { readJsonBody } from "../src/request-body.js";
import { GatewayError } from "../src/errors.js";
import { suspensionAlarmDeadline } from "../src/suspension-alarm.js";
import { AUTHORITY, uuid } from "./fixtures.js";

describe("private protocol boundary", () => {
  test("accepts the exact Builder authority envelope and gateway-owned profile", () => {
    const parsed = parseTurnCommand({
      schemaVersion: 1,
      authority: AUTHORITY,
      command: {
        schemaVersion: 1,
        requestId: uuid(1),
        action: "browser.observe",
        params: {},
      },
    });
    expect(parsed.command.action).toBe("browser.observe");
    expect("profileId" in parsed.command).toBe(false);
    expect(PROFILE_ID).toBe("default");
  });

  test("rejects legacy caller-owned epochs, extra fields, and unknown actions", () => {
    expect(() =>
      parseTurnCommand({
        schemaVersion: 1,
        authority: AUTHORITY,
        command: {
          schemaVersion: 1,
          requestId: uuid(1),
          profileId: "default",
          profileEpoch: 1,
          action: "browser.observe",
          params: {},
        },
      }),
    ).toThrow();
    expect(() =>
      parseTurnCommand({
        schemaVersion: 1,
        authority: AUTHORITY,
        command: {
          schemaVersion: 1,
          requestId: uuid(1),
          action: "browser.evaluate",
          params: {},
        },
      }),
    ).toThrow();
  });

  test("owner purge is generation-independent and DO names reveal no owner", async () => {
    const parsed = parseOwnerPurge({
      schemaVersion: 1,
      ownerId: AUTHORITY.ownerId,
      requestId: uuid(2),
    });
    expect(parsed).toEqual({
      schemaVersion: 1,
      ownerId: AUTHORITY.ownerId,
      requestId: uuid(2),
    });
    const name = await profileObjectName(AUTHORITY.ownerId, "default");
    expect(name).toMatch(/^[a-f0-9]{64}$/);
    expect(name).not.toContain("user-1");
  });

  test("schedules the durable expiry alarm for both suspension kinds", () => {
    for (const interactionKind of ["login_takeover", "device_code"] as const) {
      expect(
        suspensionAlarmDeadline({
          outcome: "suspended",
          suspension: { interactionKind, expiresAt: 301_000 },
        }),
      ).toBe(301_000);
    }
    expect(
      suspensionAlarmDeadline({
        outcome: "completed",
        suspension: { interactionKind: "device_code", expiresAt: 301_000 },
      }),
    ).toBeUndefined();
    expect(
      suspensionAlarmDeadline({
        outcome: "suspended",
        suspension: { interactionKind: "unknown", expiresAt: 301_000 },
      }),
    ).toBeUndefined();
  });

  test("stops reading a chunked request as soon as it exceeds the JSON limit", async () => {
    let pulls = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(32 * 1024));
          if (pulls === 100) controller.close();
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://browser-profile/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request)).rejects.toMatchObject<
      Partial<GatewayError>
    >({ status: 413 });
    expect(canceled).toBe(true);
    expect(pulls).toBe(3);
  });

  test("accepts bounded JSON when transfer size is not declared", async () => {
    const request = new Request("https://browser-profile/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          controller.enqueue(new TextEncoder().encode("true}"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await readJsonBody(request)).toEqual({ ok: true });
  });

  test("accepts a transfer on the endpoint that requires one", () => {
    const parsed = parseInteraction(
      {
        schemaVersion: 1,
        authority: AUTHORITY,
        profileId: "default",
        profileEpoch: 1,
        interactionId: uuid(70),
        interactionRevision: 1,
        sessionTransfer: {
          schemaVersion: 1,
          algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1",
          capabilityId: uuid(71),
          clientPublicKey: "A".repeat(43),
          iv: "B".repeat(16),
          ciphertext: "C".repeat(64),
        },
      },
      { requireSessionTransfer: true },
    );

    expect(parsed.sessionTransfer?.capabilityId).toBe(uuid(71));
  });

  test("rejects an oversized declared body before consuming its stream", async () => {
    let pulls = 0;
    const request = new Request("https://browser-profile/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BYTES + 1),
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array([123, 125]));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readJsonBody(request)).rejects.toMatchObject<
      Partial<GatewayError>
    >({ status: 413 });
    expect(pulls).toBe(0);
  });
});
