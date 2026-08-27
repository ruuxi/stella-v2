import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTtsProviderDispatchGuard } from "./tts_dispatch_guard";

type RunMutation = (
  reference: Parameters<
    Parameters<typeof acquireTtsProviderDispatchGuard>[0]["runMutation"]
  >[0],
  args: unknown,
) => Promise<unknown>;

const usage = {
  provider: "inworld" as const,
  model: "inworld-tts-1.5-max",
  voice: "voice-a",
  streaming: true,
  requestChars: 40,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("TTS provider dispatch guard", () => {
  it("retries an exact terminal mutation after response loss", async () => {
    const now = Date.now();
    let settleAttempts = 0;
    const runMutation: RunMutation = async (reference) => {
      const name = getFunctionName(reference);
      if (name.endsWith("reserveTtsProviderDispatchInternal")) {
        return {
          acquired: true,
          hardExpiresAt: now + 60_000,
          quiescentAfterAt: now + 90_000,
        };
      }
      if (name.endsWith("markTtsProviderDispatchMayHaveStartedInternal")) {
        return true;
      }
      if (name.endsWith("settleTtsProviderDispatchInternal")) {
        settleAttempts += 1;
        if (settleAttempts === 1) {
          throw new Error("terminal mutation response was lost");
        }
        return true;
      }
      if (name.endsWith("heartbeatTtsProviderDispatchInternal")) {
        return { allowed: true };
      }
      throw new Error(`Unexpected mutation: ${name}`);
    };

    const guard = await acquireTtsProviderDispatchGuard(
      { runMutation: runMutation as never },
      {
        ownerId: "owner-a",
        ownerGeneration: "generation-a",
        dispatchId: "dispatch-a",
        kind: "desktop_stream",
        usage,
      },
    );
    expect(guard).not.toBeNull();
    await guard!.markMayHaveDispatched();

    const settlement = {
      status: "completed" as const,
      synthesizedChars: 40,
      audioBytes: 1_024,
      durationMs: 50,
    };
    await expect(
      guard!.release({ outcome: "settled", settlement }),
    ).rejects.toThrow("response was lost");
    await expect(
      guard!.release({ outcome: "settled", settlement }),
    ).resolves.toBeUndefined();
    expect(settleAttempts).toBe(2);
  });

  it("aborts and cancels a hung body at the absolute deadline, then retains ambiguity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const mutations: string[] = [];
    const runMutation: RunMutation = async (reference) => {
      const name = getFunctionName(reference);
      mutations.push(name);
      if (name.endsWith("reserveTtsProviderDispatchInternal")) {
        return {
          acquired: true,
          hardExpiresAt: 1_000_100,
          quiescentAfterAt: 1_030_100,
        };
      }
      if (name.endsWith("markTtsProviderDispatchMayHaveStartedInternal")) {
        return true;
      }
      if (name.endsWith("abandonTtsProviderDispatchInternal")) return true;
      if (name.endsWith("heartbeatTtsProviderDispatchInternal")) {
        return { allowed: true };
      }
      throw new Error(`Unexpected mutation: ${name}`);
    };
    const guard = await acquireTtsProviderDispatchGuard(
      { runMutation: runMutation as never },
      {
        ownerId: "owner-a",
        ownerGeneration: "generation-a",
        dispatchId: "dispatch-hung",
        kind: "desktop_stream",
        usage,
      },
    );
    await guard!.markMayHaveDispatched();
    const cancel = vi.fn(async () => undefined);
    const bodyRead = guard!.race(new Promise<never>(() => undefined), cancel);
    const rejection = expect(bodyRead).rejects.toThrow(
      "TTS provider dispatch expired",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    await guard!.release({
      outcome: "may_have_dispatched",
      settlement: {
        status: "interrupted",
        synthesizedChars: 0,
        audioBytes: 0,
        durationMs: 100,
      },
      abort: true,
    });
    expect(
      mutations.some((name) =>
        name.endsWith("abandonTtsProviderDispatchInternal"),
      ),
    ).toBe(true);
  });
});
