import { describe, expect, it, vi } from "vitest";

import {
  resilientEventStream,
  StreamReconnectError,
} from "../../../../runtime/ai/utils/resilient-event-stream.js";

type TestEvent = {
  sequence: number;
  type: "delta" | "tool-result" | "done";
  runId?: string;
  value?: string;
};

const socketClosed = () => new Error("socket closed unexpectedly");

const source = async function* (
  entries: Array<TestEvent | Error>,
): AsyncGenerator<TestEvent> {
  for (const entry of entries) {
    if (entry instanceof Error) throw entry;
    yield entry;
  }
};

const collect = async (
  stream: AsyncIterable<TestEvent>,
): Promise<TestEvent[]> => {
  const events: TestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const makeStream = (
  overrides: Partial<Parameters<typeof resilientEventStream<TestEvent>>[0]> & {
    connect: (
      signal?: AbortSignal,
    ) => AsyncIterable<TestEvent> | Promise<AsyncIterable<TestEvent>>;
  },
) =>
  resilientEventStream<TestEvent>({
    getRunId: (event) => event.runId,
    getSequence: (event) => event.sequence,
    isTerminal: (event) => event.type === "done",
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
    ...overrides,
  });

describe("bounded event-stream connection recovery", () => {
  it("retries a pre-header transport failure", async () => {
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce(source([{ sequence: 0, type: "done" }]));

    await expect(collect(makeStream({ connect }))).resolves.toEqual([
      { sequence: 0, type: "done" },
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("uses a proposed cursor after pre-header failure instead of replaying connect", async () => {
    const connect = vi.fn(async () => {
      throw socketClosed();
    });
    const resume = vi.fn(() =>
      source([{ sequence: 1, type: "done", runId: "relay_proposed" }]),
    );

    await expect(
      collect(
        makeStream({
          connect,
          resume,
          getInitialResumeState: () => ({
            runId: "relay_proposed",
            cursor: 0,
          }),
        }),
      ),
    ).resolves.toEqual([
      { sequence: 1, type: "done", runId: "relay_proposed" },
    ]);
    expect(connect).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "relay_proposed",
        cursor: 0,
        timeoutMs: expect.any(Number),
      }),
    );
    expect(resume.mock.calls[0]![0].timeoutMs).toBeGreaterThan(0);
    expect(resume.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(12_000);
  });

  it("deduplicates replayed events after cursor resume", async () => {
    const resume = vi.fn(({ runId }: { runId: string }) =>
      source([
        { sequence: 9, type: "delta", runId, value: "A" },
        { sequence: 10, type: "delta", runId, value: "B" },
        { sequence: 11, type: "done", runId },
      ]),
    );

    const events = await collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 9, type: "delta", runId: "resp_dup", value: "A" },
            socketClosed(),
          ]),
        resume,
      }),
    );

    expect(events.map((event) => event.sequence)).toEqual([9, 10, 11]);
    expect(events.filter((event) => event.value === "A")).toHaveLength(1);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("repairs a cursor gap before yielding any out-of-order event", async () => {
    const resume = vi
      .fn<
        (args: { runId: string; cursor: number }) => AsyncIterable<TestEvent>
      >()
      .mockReturnValueOnce(
        source([
          { sequence: 3, type: "delta", runId: "resp_gap", value: "gap" },
        ]),
      )
      .mockReturnValueOnce(
        source([{ sequence: 2, type: "done", runId: "resp_gap" }]),
      );

    const events = await collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 1, type: "delta", runId: "resp_gap", value: "A" },
            socketClosed(),
          ]),
        resume,
      }),
    );

    expect(events).toEqual([
      { sequence: 1, type: "delta", runId: "resp_gap", value: "A" },
      { sequence: 2, type: "done", runId: "resp_gap" },
    ]);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: "resp_gap", cursor: 1 }),
    );
  });

  it("never replays a partial response without a durable run id", async () => {
    const connect = vi.fn(() =>
      source([
        { sequence: 1, type: "delta", value: "partial" },
        socketClosed(),
      ]),
    );

    const result = collect(makeStream({ connect }));
    await expect(result).rejects.toMatchObject({
      partialResponse: true,
      resumable: false,
      attempts: 0,
    });
    await expect(result).rejects.toThrow("request was not replayed");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("does not retry deterministic provider errors", async () => {
    const providerError = Object.assign(new Error("invalid_request_error"), {
      status: 400,
    });
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValue(providerError);

    await expect(collect(makeStream({ connect }))).rejects.toBe(providerError);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("propagates external cancellation during backoff", async () => {
    const controller = new AbortController();
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValue(socketClosed());
    const result = collect(
      makeStream({
        connect,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("Canceled by user"));

    await expect(result).rejects.toThrow("Canceled by user");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("aborts a stalled resumed body at the total recovery deadline", async () => {
    let rejectRead: ((reason: Error) => void) | undefined;
    const stalled: AsyncIterable<TestEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<TestEvent>>((_resolve, reject) => {
              rejectRead = reject;
            }),
        };
      },
    };
    const resume = vi.fn(() => stalled);

    const result = collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 1, type: "delta", runId: "resp_stall" },
            socketClosed(),
          ]),
        resume,
        deadlineMs: 30,
        abortSource: (_stream, reason) => rejectRead?.(reason),
      }),
    );

    await expect(result).rejects.toBeInstanceOf(StreamReconnectError);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("cancels the recovery deadline after the first fresh resumed event", async () => {
    const resume = vi.fn(({ runId }: { runId: string }) =>
      (async function* () {
        yield { sequence: 2, type: "delta", runId, value: "B" } as TestEvent;
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { sequence: 3, type: "done", runId } as TestEvent;
      })(),
    );
    let aborted = false;

    const events = await collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 1, type: "delta", runId: "resp_long", value: "A" },
            socketClosed(),
          ]),
        resume,
        deadlineMs: 30,
        abortSource: () => {
          aborted = true;
        },
      }),
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(resume).toHaveBeenCalledOnce();
    expect(aborted).toBe(false);
  });

  it("fails closed if a stream changes its durable run id", async () => {
    await expect(
      collect(
        makeStream({
          connect: () =>
            source([
              { sequence: 1, type: "delta", runId: "resp_one" },
              { sequence: 2, type: "done", runId: "resp_two" },
            ]),
        }),
      ),
    ).rejects.toThrow("changed durable run id");
  });
});
