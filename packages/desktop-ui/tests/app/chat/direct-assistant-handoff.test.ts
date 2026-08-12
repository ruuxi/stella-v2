import { describe, expect, it } from "vitest";

import {
  DIRECT_ASSISTANT_MESSAGE_DWELL_MS,
  DIRECT_ASSISTANT_MESSAGE_FADE_MS,
  DirectAssistantHandoffController,
  type DirectAssistantHandoffScheduler,
} from "@/features/chat/streaming/direct-assistant-handoff";

class FakeScheduler implements DirectAssistantHandoffScheduler {
  time = 0;
  private nextId = 1;
  readonly timers = new Map<
    number,
    { callback: () => void; dueAtMs: number }
  >();

  now = () => this.time;

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { callback, dueAtMs: this.time + delayMs });
    return id;
  };

  clearTimer = (timerId: number): void => {
    this.timers.delete(timerId);
  };

  advance(ms: number): void {
    this.time += ms;
    let ranTimer = true;
    while (ranTimer) {
      ranTimer = false;
      for (const [id, timer] of [...this.timers]) {
        if (timer.dueAtMs > this.time) continue;
        this.timers.delete(id);
        timer.callback();
        ranTimer = true;
      }
    }
  }
}

const createScene = () => {
  const scheduler = new FakeScheduler();
  const events: string[] = [];
  const controller = new DirectAssistantHandoffController({
    scheduler,
    onFadeStart: (slotId) => events.push(`fade:${slotId}`),
    onSwap: (previousSlotId, nextSlotId) =>
      events.push(`swap:${previousSlotId}:${nextSlotId}`),
  });
  return { controller, events, scheduler };
};

describe("DirectAssistantHandoffController", () => {
  it("waits two seconds from the completed paint, then fades before swapping", () => {
    const { controller, events, scheduler } = createScene();
    controller.queue("slot-1", "slot-2");

    scheduler.advance(5_000);
    expect(events).toEqual([]);

    controller.markPainted("slot-1");
    scheduler.advance(DIRECT_ASSISTANT_MESSAGE_DWELL_MS - 1);
    expect(events).toEqual([]);

    scheduler.advance(1);
    expect(events).toEqual(["fade:slot-1"]);

    scheduler.advance(DIRECT_ASSISTANT_MESSAGE_FADE_MS - 1);
    expect(events).toEqual(["fade:slot-1"]);
    scheduler.advance(1);
    expect(events).toEqual(["fade:slot-1", "swap:slot-1:slot-2"]);
  });

  it("starts the fade immediately when the replacement arrives after the dwell", () => {
    const { controller, events, scheduler } = createScene();
    controller.markPainted("slot-1");
    scheduler.advance(DIRECT_ASSISTANT_MESSAGE_DWELL_MS + 500);

    controller.queue("slot-1", "slot-2");
    scheduler.advance(0);

    expect(events).toEqual(["fade:slot-1"]);
  });

  it("cancels pending fades and swaps on reset", () => {
    const { controller, events, scheduler } = createScene();
    controller.markPainted("slot-1");
    controller.queue("slot-1", "slot-2");
    controller.reset();

    scheduler.advance(
      DIRECT_ASSISTANT_MESSAGE_DWELL_MS + DIRECT_ASSISTANT_MESSAGE_FADE_MS + 1,
    );
    expect(events).toEqual([]);
    expect(scheduler.timers.size).toBe(0);
  });

  it("restarts the dwell when a late delta makes the old slot active again", () => {
    const { controller, events, scheduler } = createScene();
    controller.markPainted("slot-1");
    controller.queue("slot-1", "slot-2");
    scheduler.advance(DIRECT_ASSISTANT_MESSAGE_DWELL_MS - 100);

    controller.markUnpainted("slot-1");
    scheduler.advance(200);
    expect(events).toEqual([]);

    controller.markPainted("slot-1");
    scheduler.advance(DIRECT_ASSISTANT_MESSAGE_DWELL_MS);
    expect(events).toEqual(["fade:slot-1"]);
  });
});
