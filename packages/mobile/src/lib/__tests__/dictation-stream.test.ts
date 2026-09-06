import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Isolate auth/native module doubles from the rest of the mobile test process.
// The transport itself runs unchanged, including its real timer/close handlers.
test("dictation opening closes rejected and cancelled sockets without starting a late connection", () => {
  const lib = resolve(__dirname, "..");
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    let config = async () => ({ relayOrigin: "https://relay.example" });
    mock.module(${JSON.stringify(resolve(lib, "http.ts"))}, () => ({ postJson: () => config() }));
    mock.module(${JSON.stringify(resolve(lib, "auth-token.ts"))}, () => ({ getConvexToken: async () => "fixture-token" }));
    class Socket {
      static OPEN = 1;
      static instances = [];
      readyState = 0;
      closeCount = 0;
      sent = [];
      constructor() { Socket.instances.push(this); }
      close() { this.closeCount++; this.readyState = 3; }
      send(value) { this.sent.push(value); }
      open() { this.readyState = 1; this.onopen?.({}); }
      receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    }
    globalThis.WebSocket = Socket;
    const { DictationStream } = await import(${JSON.stringify(resolve(lib, "dictation-stream.ts"))});
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    const failed = new DictationStream();
    const failedOpen = failed.open();
    await flush();
    const rejectedSocket = Socket.instances.at(-1);
    rejectedSocket.onerror();
    await assert.rejects(failedOpen, /Could not connect/);
    assert.equal(rejectedSocket.closeCount, 1);
    assert.equal(rejectedSocket.onopen, null);

    const cancelled = new DictationStream();
    const cancelledOpen = cancelled.open();
    await flush();
    const cancelledSocket = Socket.instances.at(-1);
    cancelled.cancel();
    await assert.rejects(cancelledOpen, /cancelled/);
    assert.equal(cancelledSocket.closeCount, 1);

    const closed = new DictationStream();
    const closedOpen = closed.open();
    await flush();
    Socket.instances.at(-1).onclose({ code: 1008 });
    await assert.rejects(closedOpen, /Could not connect/);

    const previews = [];
    const preReady = new DictationStream((text) => previews.push(text));
    let resolved = false;
    const opening = preReady.open().then(() => { resolved = true; });
    await flush();
    const awaitingProvider = Socket.instances.at(-1);
    awaitingProvider.open();
    await flush();
    assert.equal(resolved, false, "HTTP upgrade is not provider authorization");
    awaitingProvider.receive({ sessionId: "" });
    await flush();
    assert.equal(resolved, false);
    awaitingProvider.receive({ sessionId: "verified-provider-session" });
    await opening;
    assert.equal(resolved, true);
    const queuedMessage = awaitingProvider.onmessage;
    preReady.cancel();
    queuedMessage({ data: JSON.stringify({ type: "transcript", text: "stale audio" }) });
    assert.deepEqual(previews, []);
    assert.equal(awaitingProvider.onmessage, null);

    const refused = new DictationStream();
    const refusedOpen = refused.open();
    await flush();
    const refusedSocket = Socket.instances.at(-1);
    refusedSocket.open();
    refusedSocket.receive({ type: "error", sessionId: "rejected-session", message: "Provider refused credential" });
    await assert.rejects(refusedOpen, /Provider refused credential/);
    assert.equal(refusedSocket.closeCount, 1);

    let failures = 0;
    const live = new DictationStream(undefined, () => { failures++; });
    const liveOpen = live.open();
    await flush();
    const liveSocket = Socket.instances.at(-1);
    liveSocket.open();
    liveSocket.receive({ sessionId: "accepted-session" });
    await liveOpen;
    liveSocket.receive({ type: "error", message: "Provider session expired" });
    liveSocket.onclose({ code: 1008 });
    assert.equal(failures, 1);
    assert.throws(() => live.throwIfFailed(), /Provider session expired/);
    await assert.rejects(live.finish(), /Provider session expired/);
    live.cancel();

    const finishing = new DictationStream();
    const finishingOpen = finishing.open();
    await flush();
    const finishingSocket = Socket.instances.at(-1);
    finishingSocket.open();
    finishingSocket.receive({ sessionId: "accepted-finish" });
    await finishingOpen;
    const final = finishing.finish();
    assert.equal(finishingSocket.sent.at(-1), JSON.stringify({ type: "endStream" }));
    finishingSocket.receive({ type: "error", message: "Final transcription refused" });
    finishingSocket.onclose?.({ code: 1008 });
    await assert.rejects(final, /Final transcription refused/);

    const completed = new DictationStream();
    const completedOpen = completed.open();
    await flush();
    const completedSocket = Socket.instances.at(-1);
    completedSocket.open();
    completedSocket.receive({ sessionId: "accepted-success" });
    await completedOpen;
    const completedText = completed.finish();
    completedSocket.receive({ type: "transcript", text: "A short recorded phrase.", final: true });
    completedSocket.onclose({ code: 1000 });
    assert.equal(await completedText, "A short recorded phrase.");
    assert.equal(completedSocket.onmessage, null);

    let finals = 0;
    let unexpectedFailures = 0;
    const auto = new DictationStream(undefined, () => unexpectedFailures++, () => finals++);
    const autoOpen = auto.open();
    await flush();
    const autoSocket = Socket.instances.at(-1);
    autoSocket.open();
    autoSocket.receive({ sessionId: "accepted-cap" });
    await autoOpen;
    autoSocket.receive({ type: "transcript", transcript: "unfinished", final: false });
    assert.equal(finals, 0, "partial utterances do not end recording");
    autoSocket.receive({ type: "transcript", transcript: "Allowance-limited phrase.", final: true });
    assert.equal(finals, 1);
    assert.equal(auto.isComplete, true);
    auto.send(new ArrayBuffer(320));
    assert.equal(autoSocket.sent.length, 0, "native trailing audio is ignored after terminal final");
    autoSocket.receive({ type: "transcript", transcript: "late replacement", final: true });
    autoSocket.onerror();
    autoSocket.readyState = 3;
    autoSocket.onclose({ code: 1000 });
    assert.equal(finals, 1);
    assert.equal(unexpectedFailures, 0);
    assert.equal(await auto.finish(), "Allowance-limited phrase.");
    assert.equal(autoSocket.onmessage, null);

    const empty = new DictationStream();
    const emptyOpen = empty.open();
    await flush();
    const emptySocket = Socket.instances.at(-1);
    emptySocket.open();
    emptySocket.receive({ sessionId: "accepted-empty" });
    await emptyOpen;
    emptySocket.receive({ type: "transcript", transcript: "discarded interim", final: false });
    emptySocket.receive({ type: "transcript", transcript: "", final: true });
    emptySocket.readyState = 3;
    emptySocket.onclose({ code: 1000 });
    assert.equal(await empty.finish(), "", "an empty final must not resurrect interim text");

    let cancelledFinals = 0;
    const abandoned = new DictationStream(undefined, undefined, () => cancelledFinals++);
    const abandonedOpen = abandoned.open();
    await flush();
    const abandonedSocket = Socket.instances.at(-1);
    abandonedSocket.open();
    abandonedSocket.receive({ sessionId: "accepted-cancel-final" });
    await abandonedOpen;
    const queuedFinal = abandonedSocket.onmessage;
    abandoned.cancel();
    queuedFinal({ data: JSON.stringify({ type: "transcript", transcript: "discard me", final: true }) });
    assert.equal(cancelledFinals, 0);
    await assert.rejects(abandoned.finish(), /cancelled/);

    let invalidFrames = 0;
    const batching = new DictationStream(undefined, () => { invalidFrames++; });
    const batchingOpen = batching.open();
    await flush();
    const batchSocket = Socket.instances.at(-1);
    batchSocket.open();
    batchSocket.receive({ sessionId: "accepted-batches" });
    await batchingOpen;
    batching.send(new ArrayBuffer(0));
    assert.equal(batchSocket.sent.length, 0);
    for (const length of [32000, 32002, 35200, 96008]) {
      batchSocket.sent = [];
      const input = Uint8Array.from({ length }, (_, index) => index % 251);
      batching.send(input.buffer);
      assert.ok(batchSocket.sent.every(frame => frame.byteLength <= 32000 && frame.byteLength % 2 === 0));
      const rebuilt = new Uint8Array(length);
      let cursor = 0;
      for (const frame of batchSocket.sent) {
        rebuilt.set(new Uint8Array(frame), cursor);
        cursor += frame.byteLength;
      }
      assert.equal(cursor, length);
      assert.deepEqual(rebuilt, input);
    }
    const validCount = batchSocket.sent.length;
    batching.send(new ArrayBuffer(3));
    assert.equal(batchSocket.sent.length, validCount, "odd PCM is never truncated or sent");
    assert.equal(invalidFrames, 1);
    batching.cancel();

    let releaseConfig;
    config = () => new Promise(resolve => { releaseConfig = resolve; });
    const beforeConfig = new DictationStream();
    const pendingConfig = beforeConfig.open();
    const beforeCount = Socket.instances.length;
    beforeConfig.cancel();
    releaseConfig({ relayOrigin: "https://relay.example" });
    await assert.rejects(pendingConfig, /cancelled/);
    assert.equal(Socket.instances.length, beforeCount);
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
