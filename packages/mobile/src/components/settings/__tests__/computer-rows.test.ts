import { describe, expect, test } from "bun:test";

import { buildComputerRows, type ComputerRow } from "../computer-rows";
import type { ExecutionDeviceDestination } from "../../../lib/execution-placement";
import type { StoredPhoneAccess } from "../../../lib/phone-access";

const device = (
  overrides: Partial<ExecutionDeviceDestination> & { deviceId: string },
): ExecutionDeviceDestination => ({
  remoteExecutionEnabled: overrides.remoteExecution === "enabled",
  remoteExecution: "unconfigured",
  online: false,
  ...overrides,
});

const access = (desktopDeviceId: string): StoredPhoneAccess => ({
  desktopDeviceId,
  mobileDeviceId: "phone-1",
  pairSecret: "pair-secret",
  approvedAt: 1,
});

const rowFor = (rows: ComputerRow[], deviceId: string) => {
  const row = rows.find((candidate) => candidate.deviceId === deviceId);
  if (!row) throw new Error(`no row for ${deviceId}`);
  return row;
};

describe("Settings' computer list", () => {
  test("lists a computer this phone has never paired with", () => {
    // The whole point of the change: signing in is enough to be listed, so a
    // desktop with no stored pair secret on this phone still appears.
    const rows = buildComputerRows({
      devices: [
        device({
          deviceId: "desktop-fresh",
          label: "Studio iMac",
          online: true,
          remoteExecution: "unconfigured",
        }),
      ],
      stored: [],
    });
    expect(rows.map((row) => row.deviceId)).toEqual(["desktop-fresh"]);
    const row = rowFor(rows, "desktop-fresh");
    expect(row.label).toBe("Studio iMac");
    expect(row.access).toBeNull();
    expect(row.listed).toBe(true);
    // Listed is not willing: it says which state it is and offers the way in.
    expect(row.statusKind).toBe("notEnabled");
    expect(row.available).toBe(false);
    expect(row.canEnable).toBe(true);
  });

  test("joins stored access onto the account's device list", () => {
    const rows = buildComputerRows({
      devices: [
        device({
          deviceId: "desktop-known",
          online: true,
          remoteExecution: "enabled",
          availability: { ready: true, capabilities: ["chat"] },
        }),
      ],
      stored: [access("desktop-known")],
    });
    const row = rowFor(rows, "desktop-known");
    expect(row.access?.pairSecret).toBe("pair-secret");
    expect(row.statusKind).toBe("online");
    expect(row.available).toBe(true);
    // Already consented: nothing to enable.
    expect(row.canEnable).toBe(false);
  });

  test("keeps the selectability rule: online, consented and ready", () => {
    const rows = buildComputerRows({
      devices: [
        device({
          deviceId: "offline-enabled",
          remoteExecution: "enabled",
          availability: { ready: true, capabilities: ["chat"] },
        }),
        device({
          deviceId: "online-not-ready",
          online: true,
          remoteExecution: "enabled",
          availability: { ready: false, capabilities: [] },
        }),
        device({
          deviceId: "online-unconsented",
          online: true,
          remoteExecution: "unconfigured",
          availability: { ready: true, capabilities: ["chat"] },
        }),
      ],
      stored: [],
    });
    expect(rowFor(rows, "offline-enabled").available).toBe(false);
    expect(rowFor(rows, "offline-enabled").statusKind).toBe("offline");
    expect(rowFor(rows, "online-not-ready").available).toBe(false);
    expect(rowFor(rows, "online-not-ready").statusKind).toBe("notReady");
    // Ready and online, but it has not agreed: still not a choice.
    expect(rowFor(rows, "online-unconsented").available).toBe(false);
    expect(rowFor(rows, "online-unconsented").statusKind).toBe("notEnabled");
  });

  test("names the consent state rather than one blanket 'unavailable'", () => {
    const rows = buildComputerRows({
      devices: [
        device({ deviceId: "asking", online: true, remoteExecution: "asking" }),
        device({
          deviceId: "declined",
          online: true,
          remoteExecution: "declined",
        }),
      ],
      stored: [],
    });
    expect(rowFor(rows, "asking").statusKind).toBe("awaitingConsent");
    expect(rowFor(rows, "asking").canEnable).toBe(true);
    expect(rowFor(rows, "declined").statusKind).toBe("declined");
    // Declined is an answer, but the owner may still change it from here.
    expect(rowFor(rows, "declined").canEnable).toBe(true);
  });

  test("reads a backend that only knows the boolean as enabled", () => {
    const legacy = {
      deviceId: "desktop-legacy",
      remoteExecutionEnabled: true,
      online: true,
      availability: { ready: true, capabilities: ["chat"] },
    } as ExecutionDeviceDestination;
    const row = rowFor(
      buildComputerRows({ devices: [legacy], stored: [] }),
      "desktop-legacy",
    );
    expect(row.statusKind).toBe("online");
    expect(row.available).toBe(true);
    expect(row.canEnable).toBe(false);
  });

  test("keeps a stored pairing whose desktop the device list no longer knows", () => {
    const rows = buildComputerRows({
      devices: [device({ deviceId: "desktop-current", online: true })],
      stored: [access("desktop-gone"), access("desktop-current")],
      activeDeviceId: "desktop-gone",
    });
    expect(rows.map((row) => row.deviceId)).toEqual([
      "desktop-current",
      "desktop-gone",
    ]);
    const gone = rowFor(rows, "desktop-gone");
    expect(gone.statusKind).toBe("offline");
    expect(gone.listed).toBe(false);
    // Nothing to enable on a desktop the account does not list.
    expect(gone.canEnable).toBe(false);
    // The chat's own status copy ("Asleep", "Waking up…") is better here.
    expect(gone.preferActiveStatusLabel).toBe(true);
    expect(rowFor(rows, "desktop-current").preferActiveStatusLabel).toBe(false);
  });

  test("shows the account's computers before the device list has loaded", () => {
    const rows = buildComputerRows({
      devices: undefined,
      stored: [access("desktop-stored")],
    });
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, "desktop-stored").statusKind).toBe("offline");
    expect(rowFor(rows, "desktop-stored").canEnable).toBe(false);
  });
});
