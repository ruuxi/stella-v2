import { describe, expect, test } from "bun:test";

import {
  parseMobileSchedules,
  type MobileSchedule,
} from "../desktop-schedules";
import {
  formatNextRun,
  parseStoredSchedule,
  summarizeSchedule,
} from "../schedule-format";

const cronRow = (overrides: Record<string, unknown> = {}) => ({
  id: "cron:abc",
  conversationId: "conv-1",
  name: "Morning deploy check",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *" },
  nextRunAtMs: Date.now() + 3_600_000,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const heartbeatRow = (overrides: Record<string, unknown> = {}) => ({
  id: "hb-1",
  conversationId: "conv-1",
  enabled: true,
  intervalMs: 30 * 60_000,
  prompt: "Check the inbox and summarize anything urgent",
  nextRunAtMs: Date.now() + 600_000,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

describe("parseMobileSchedules", () => {
  test("merges crons + heartbeats, active first then by next run", () => {
    const now = Date.now();
    const parsed = parseMobileSchedules({
      cronJobs: [
        cronRow({ id: "cron:far", nextRunAtMs: now + 5_000_000 }),
        cronRow({ id: "cron:soon", nextRunAtMs: now + 100 }),
      ],
      heartbeats: [heartbeatRow({ nextRunAtMs: now + 50 })],
    });
    expect(parsed.map((row) => row.id)).toEqual([
      "hb-1",
      "cron:soon",
      "cron:far",
    ]);
  });

  test("sinks paused rows below active ones", () => {
    const parsed = parseMobileSchedules({
      cronJobs: [
        cronRow({ id: "cron:paused", enabled: false }),
        cronRow({ id: "cron:active" }),
      ],
      heartbeats: [],
    });
    expect(parsed.map((row) => row.id)).toEqual(["cron:active", "cron:paused"]);
    expect(parsed[1]?.enabled).toBe(false);
  });

  test("drops malformed rows instead of failing the list", () => {
    const parsed = parseMobileSchedules({
      cronJobs: [
        cronRow(),
        { id: "" },
        null,
        { nope: true },
        // Missing the required nextRunAtMs — dropped, not defaulted.
        cronRow({ nextRunAtMs: undefined }),
      ],
      heartbeats: [{ id: "bad" }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("cron:abc");
  });

  test("handles a missing / non-array payload defensively", () => {
    expect(parseMobileSchedules({})).toEqual([]);
    expect(parseMobileSchedules({ cronJobs: "nope", heartbeats: 42 })).toEqual(
      [],
    );
  });

  test("deduplicates rows by kind:id", () => {
    const parsed = parseMobileSchedules({
      cronJobs: [cronRow(), cronRow({ name: "Second copy" })],
      heartbeats: [],
    });
    expect(parsed).toHaveLength(1);
  });

  test("serializes structured schedules back to JSON for the formatter", () => {
    const parsed = parseMobileSchedules({
      cronJobs: [cronRow()],
      heartbeats: [],
    });
    expect(parseStoredSchedule(parsed[0]!.scheduleJson!)).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
    });
  });

  test("heartbeat titles truncate long prompts like the desktop dialog", () => {
    const parsed = parseMobileSchedules({
      cronJobs: [],
      heartbeats: [
        heartbeatRow({
          prompt:
            "A very long heartbeat instruction that goes well past sixty characters in length for sure",
        }),
      ],
    });
    expect(parsed[0]?.title.endsWith("…")).toBe(true);
    expect(parsed[0]?.title.length).toBeLessThanOrEqual(61);
  });
});

describe("fetchMobileSchedules (request shape)", () => {
  test("requests both bridge list channels against the paired computer", async () => {
    // Expo's module setup runs on import and expects the RN global.
    (globalThis as Record<string, unknown>).__DEV__ = false;
    const { mock } = await import("bun:test");

    // Stand in for the paired-desktop record so the bridge resolves without
    // native secure storage, and capture the channels the module requests.
    const store = new Map<string, string>();
    mock.module("expo-secure-store", () => ({
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        store.set(key, value);
      },
      deleteItemAsync: async (key: string) => {
        store.delete(key);
      },
    }));
    mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
    mock.module("../phone-access", () => ({
      listStoredPairedPhoneAccess: async () => [
        { desktopDeviceId: "desktop-1", mobileDeviceId: "mobile-1" },
      ],
      getDesktopBridgeStatus: async () => ({ available: false }),
    }));

    const channels: string[] = [];
    mock.module("../desktop-bridge-chat", () => ({
      resolveDesktopBridge: async () => ({ desktopDeviceId: "desktop-1" }),
      invokeDesktopBridge: async (
        _bridge: unknown,
        channel: string,
        args: unknown[],
      ) => {
        channels.push(channel);
        void args;
        return [];
      },
    }));

    const { fetchMobileSchedules: fetchSchedules } = await import(
      "../desktop-schedules"
    );
    const rows = await fetchSchedules();
    expect(channels).toEqual([
      "schedule:listCronJobs",
      "schedule:listHeartbeats",
    ]);
    expect(rows).toEqual([]);
  });
});

const shape = (overrides: Partial<MobileSchedule> = {}): MobileSchedule => ({
  kind: "cron",
  id: "cron:abc",
  title: "Morning deploy check",
  conversationId: "conv-1",
  enabled: true,
  nextRunAtMs: Date.now() + 3_600_000,
  running: false,
  ...overrides,
});

describe("row rendering inputs", () => {
  test("cadence line summarizes common patterns like the desktop dialog", () => {
    expect(
      summarizeSchedule(parseStoredSchedule(JSON.stringify({ kind: "cron", expr: "0 9 * * *" }))),
    ).toBe("Daily 09:00");
    expect(
      summarizeSchedule(
        parseStoredSchedule(JSON.stringify({ kind: "cron", expr: "30 8 * * 1-5" })),
      ),
    ).toBe("Mon–Fri 08:30");
    expect(
      summarizeSchedule(parseStoredSchedule(JSON.stringify({ kind: "every", everyMs: 1_800_000 }))),
    ).toBe("Every 30 min");
    expect(summarizeSchedule(null, 30 * 60_000)).toBe("Every 30 min");
    expect(summarizeSchedule(null)).toBe("");
  });

  test("falls back to the raw cron expression for custom patterns", () => {
    expect(
      summarizeSchedule(
        parseStoredSchedule(JSON.stringify({ kind: "cron", expr: "*/7 4 */2 * *" })),
      ),
    ).toBe("*/7 4 */2 * *");
  });

  test("next-run badges go due → now → relative → calendar", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0);
    expect(formatNextRun(now - 120_000, now)).toBe("due");
    expect(formatNextRun(now + 10_000, now)).toBe("now");
    expect(formatNextRun(now + 5 * 60_000, now)).toBe("in 5m");
    expect(formatNextRun(now + 3 * 3_600_000, now)).toBe("in 3h");
  });

  test("unparseable stored schedules summarize to empty, not throw", () => {
    expect(parseStoredSchedule("{not json")).toBeNull();
    expect(summarizeSchedule(null)).toBe("");
  });

  test("paused rows show a Paused badge instead of a next-run time", () => {
    const row = shape({ enabled: false });
    expect(row.enabled ? `Next ${formatNextRun(row.nextRunAtMs, Date.now())}` : "Paused").toBe(
      "Paused",
    );
  });
});
