import { afterEach, describe, expect, it } from "vitest";
import { isTelemetryEventBody } from "@stella/contracts/telemetry";
import {
  BootTimeline,
  getActiveBootTimeline,
  recordBootField,
  recordBootStep,
  setActiveBootTimeline,
  workerReadyTelemetry,
} from "../../observability/boot-timing.js";

const fakeClock = (start = 1_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

afterEach(() => {
  setActiveBootTimeline(null);
});

describe("BootTimeline", () => {
  it("finishes into one flat worker.ready.timing event", () => {
    const clock = fakeClock();
    const timeline = new BootTimeline(clock.now, () => 157.24);

    clock.advance(2);
    timeline.step("deviceIdentity", 1.26);
    timeline.step("layerStorage", 5);
    timeline.step("layerStorage", 1.5); // repeated steps accumulate
    timeline.time("runnerConstruct", () => clock.advance(3));
    timeline.set("dbFromVersion", 3);
    timeline.set("dbMigrated", true);
    timeline.mark("initialized");
    timeline.noteEventLoopStall(4);
    timeline.noteEventLoopStall(12.345);
    timeline.noteEventLoopStall(-3);
    clock.advance(10);

    expect(timeline.finish("success")).toEqual({
      outcome: "success",
      totalMs: 15,
      uptimeAtInitializeMs: 157.2,
      maxEventLoopStallMs: 12.3,
      deviceIdentityMs: 1.3,
      layerStorageMs: 6.5,
      runnerConstructMs: 3,
      dbFromVersion: 3,
      dbMigrated: true,
      initializedAtMs: 5,
    });
  });

  it("reports once and ignores steps after finishing", () => {
    const clock = fakeClock();
    const timeline = new BootTimeline(clock.now, () => 0);
    expect(timeline.finish("failure")?.outcome).toBe("failure");
    expect(timeline.isFinished).toBe(true);
    timeline.step("late", 5);
    expect(timeline.finish("success")).toBeNull();
  });

  it("records a timed step even when the work throws", async () => {
    const clock = fakeClock();
    const timeline = new BootTimeline(clock.now, () => 0);
    expect(() =>
      timeline.time("sync", () => {
        clock.advance(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    await expect(
      timeline.timeAsync("async", async () => {
        clock.advance(3);
        throw new Error("later");
      }),
    ).rejects.toThrow("later");
    const timing = timeline.finish("failure");
    expect(timing?.syncMs).toBe(2);
    expect(timing?.asyncMs).toBe(3);
  });

  it("maps to a contract-valid app.performance worker-ready metric", () => {
    const clock = fakeClock();
    const timeline = new BootTimeline(clock.now, () => 0);
    clock.advance(1234.56);
    const timing = timeline.finish("success");
    const event = workerReadyTelemetry(timing!);
    expect(event).toEqual({
      type: "app.performance",
      component: "runtime-worker",
      metric: "worker-ready",
      durationMs: 1235,
      outcome: "success",
    });
    // The closed telemetry contract (shared with ingest) accepts it.
    expect(isTelemetryEventBody(event)).toBe(true);
    expect(
      isTelemetryEventBody(
        workerReadyTelemetry({ ...timing!, outcome: "canceled" }),
      ),
    ).toBe(true);
  });
});

describe("active boot recorders", () => {
  it("are no-ops outside a boot", () => {
    expect(getActiveBootTimeline()).toBeNull();
    expect(() => recordBootStep("dbOpen", 1)).not.toThrow();
    expect(() => recordBootField("dbMigrated", false)).not.toThrow();
  });

  it("write to the active timeline until it finishes", () => {
    const clock = fakeClock();
    const timeline = new BootTimeline(clock.now, () => 0);
    setActiveBootTimeline(timeline);
    recordBootStep("dbOpen", 1.5);
    recordBootField("dbToVersion", 4);
    const timing = timeline.finish("success");
    expect(timing?.dbOpenMs).toBe(1.5);
    expect(timing?.dbToVersion).toBe(4);
    // A finished timeline is no longer active.
    expect(getActiveBootTimeline()).toBeNull();
    recordBootStep("dbOpen", 99);
  });
});
