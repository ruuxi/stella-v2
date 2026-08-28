import { describe, expect, test } from "bun:test";
import {
  PROFILE_ID,
  parseOwnerPurge,
  parseTurnCommand,
  profileObjectName,
} from "../src/protocol.js";
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
});
