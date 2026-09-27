import { describe, expect, test } from "bun:test";
import * as schedules from "../schedules";
import {
  formatNextRun,
  parseStoredSchedule,
  summarizeSchedule,
} from "../schedule-format";

type MobileSchedule = schedules.MobileSchedule;

describe("toMobileSchedule", () => {
  test("maps a Convex row onto the tab's row shape", () => {
    expect(
      schedules.toMobileSchedule({
        scheduleId: "sch-1",
        conversationId: "conversation-1",
        targetDeviceId: "desk-1",
        prompt: "Check the build.",
        schedule: JSON.stringify({ kind: "every", everyMs: 3_600_000 }),
        nextRunAt: 5_000,
        status: "paused",
        description: "Build check",
        lastError: "Skipped",
      }),
    ).toEqual({
      kind: "cron",
      id: "sch-1",
      title: "Build check",
      conversationId: "conversation-1",
      enabled: false,
      nextRunAtMs: 5_000,
      scheduleJson: JSON.stringify({ kind: "every", everyMs: 3_600_000 }),
      targetDeviceId: "desk-1",
      lastError: "Skipped",
      running: false,
    });
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

  test("paused rows badge as Paused; active rows badge the next run", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0);
    // Paused wins even with an imminent nextRunAtMs still on the record.
    expect(
      schedules.scheduleRowBadge(
        shape({ enabled: false, nextRunAtMs: now + 60_000 }),
        now,
      ),
    ).toEqual({ kind: "paused" });
    expect(
      schedules.scheduleRowBadge(shape({ nextRunAtMs: now + 5 * 60_000 }), now),
    ).toEqual({ kind: "next", label: "in 5m" });
  });

  test("cadence line composes stored schedule JSON / heartbeat interval", () => {
    expect(
      schedules.scheduleCadence({
        scheduleJson: JSON.stringify({ kind: "cron", expr: "0 9 * * *" }),
      }),
    ).toBe("Daily 09:00");
    expect(schedules.scheduleCadence({ intervalMs: 30 * 60_000 })).toBe(
      "Every 30 min",
    );
    // Corrupt stored JSON yields "" — the UI's localized fallback takes over.
    expect(schedules.scheduleCadence({ scheduleJson: "{corrupt" })).toBe("");
    expect(schedules.scheduleCadence({})).toBe("");
  });
});
