import { describe, expect, it } from "bun:test";

import {
  RelayResumeSseParser,
  STELLA_RELAY_RESUME_MAX_BYTES,
  decideRelayResumeAccess,
  relayResumeChunkEvents,
  relayResumeEventBytes,
  relayResumeStreamIsStale,
  relayResumeTerminalSuffix,
} from "../../convex/stella_provider/relay_resume";

const sse = (event: Record<string, unknown>): string =>
  `data: ${JSON.stringify(event)}\n\n`;

describe("relay-owned Responses SSE cursoring", () => {
  it("assigns stable monotonic relay sequences across split transport chunks", () => {
    const parser = new RelayResumeSseParser();
    const wire =
      sse({
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_upstream", status: "in_progress" },
      }) +
      sse({
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "hel",
      }) +
      sse({
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        delta: '{"q":"x"}',
      }) +
      sse({
        type: "response.completed",
        sequence_number: 3,
        response: { id: "resp_upstream", status: "completed" },
      }) +
      "data: [DONE]\n\n";

    const frames = [
      ...parser.push(wire.slice(0, 37)),
      ...parser.push(wire.slice(37, 143)),
      ...parser.push(wire.slice(143)),
    ];
    const events = frames.flatMap((frame) =>
      frame.kind === "event" ? [frame.event] : [],
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[0]).toMatchObject({
      responseId: "resp_upstream",
      responseStatus: "in_progress",
    });
    expect(events[3]).toMatchObject({
      eventType: "response.completed",
      terminalStatus: "completed",
    });
    expect(
      events
        .map((event) => JSON.parse(event.frame.slice(6)))
        .map((event) => event.stella_relay_sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(frames.at(-1)).toMatchObject({ kind: "done" });
  });

  it("keeps replay chunks bounded without duplicating text or tool events", () => {
    const parser = new RelayResumeSseParser();
    const frames = parser.push(
      sse({ type: "response.output_text.delta", delta: "A" }) +
        sse({ type: "response.function_call_arguments.delta", delta: "B" }) +
        sse({ type: "response.output_text.delta", delta: "C" }),
    );
    const events = frames.flatMap((frame) =>
      frame.kind === "event" ? [frame.event] : [],
    );
    const chunks = relayResumeChunkEvents(events);
    const replayed = chunks.flat().filter((event) => event.sequence > 1);

    expect(replayed.map((event) => event.sequence)).toEqual([2, 3]);
    expect(replayed.map((event) => event.eventType)).toEqual([
      "response.function_call_arguments.delta",
      "response.output_text.delta",
    ]);
    expect(
      chunks
        .flat()
        .reduce((sum, event) => sum + relayResumeEventBytes(event), 0),
    ).toBeLessThan(STELLA_RELAY_RESUME_MAX_BYTES);
  });

  it("fails closed when an EOF arrives after partial events without a terminal", () => {
    const parser = new RelayResumeSseParser();
    const frames = parser.push(
      sse({ type: "response.created", response: { id: "resp_partial" } }) +
        sse({ type: "response.output_text.delta", delta: "partial" }),
    );
    expect(
      frames.some(
        (frame) => frame.kind === "event" && frame.event.terminalStatus,
      ),
    ).toBe(false);
    const suffix = relayResumeTerminalSuffix("upstream_eof", 2)!;
    expect(suffix[0]).toContain('"type":"error"');
    expect(suffix[0]).toContain('"stella_relay_sequence":3');
    expect(suffix[1]).toBe("data: [DONE]\n\n");
  });
});

describe("relay resume isolation and retention", () => {
  const snapshot = {
    ownerId: "owner:a",
    expiresAt: 20_000,
    lastSequence: 7,
  };

  it("denies a cross-user cursor without disclosing whether it exists", () => {
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:b",
        snapshot,
        startingAfter: 3,
        nowMs: 10_000,
      }),
    ).toEqual({ ok: false, status: 404, message: "Relay response not found" });
  });

  it("returns an explicit expiry and rejects cursors ahead of durable state", () => {
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:a",
        snapshot,
        startingAfter: 3,
        nowMs: 20_000,
      }),
    ).toMatchObject({ ok: false, status: 410 });
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:a",
        snapshot,
        startingAfter: 8,
        nowMs: 10_000,
      }),
    ).toMatchObject({ ok: false, status: 416 });
  });

  it("replays terminal streams as finite SSE responses", () => {
    expect(relayResumeTerminalSuffix("completed", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    expect(relayResumeTerminalSuffix("failed", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    expect(relayResumeTerminalSuffix("error", 7)).toEqual(["data: [DONE]\n\n"]);
    expect(relayResumeTerminalSuffix("streaming", 7)).toBeNull();
    expect(relayResumeTerminalSuffix("canceled", 7)?.[0]).toContain(
      '"code":"relay_stream_canceled"',
    );
  });

  it("fails an orphaned stream after the redeploy heartbeat window", () => {
    expect(relayResumeStreamIsStale(10_000, 40_000)).toBe(false);
    expect(relayResumeStreamIsStale(10_000, 40_001)).toBe(true);
  });
});
