import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("provider completion stops native recording and commits once across close, startup, and cancellation races", () => {
  const lib = resolve(__dirname, "..");
  const result = spawnSync(process.execPath, ["--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const cleanups = [];
    const statuses = [];
    const transcripts = [];
    const alerts = [];
    const audioCallbacks = [];
    let stops = 0;
    let releases = 0;
    let subscriptions = 0;
    let stopNative = async () => ({});
    let startNative = async () => undefined;
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    // Exercise the actual hook closures and transport without loading a native
    // renderer. The hook's ref ownership and async cleanup remain unchanged.
    mock.module("react", () => ({
      useRef: current => ({ current }),
      useState: initial => [initial, value => statuses.push(value)],
      useCallback: fn => fn,
      useEffect: fn => { cleanups.push(fn()); },
    }));
    mock.module("expo-audio", () => ({ AudioModule: {
      requestRecordingPermissionsAsync: async () => ({ granted: true }),
    } }));
    mock.module("@siteed/audio-studio", () => ({ AudioStudioModule: {
      startRecording: () => startNative(),
      stopRecording: () => { stops++; return stopNative(); },
    } }));
    mock.module("expo-modules-core", () => ({ LegacyEventEmitter: class {
      addListener(_event, callback) {
        audioCallbacks.push(callback);
        subscriptions++;
        let removed = false;
        return { remove() { if (!removed) { removed = true; subscriptions--; } } };
      }
    } }));
    mock.module("expo-file-system", () => ({ File: class { delete() {} } }));
    mock.module("react-native", () => ({ Alert: { alert: (...args) => alerts.push(args) }, Linking: {} }));
    mock.module(${JSON.stringify(resolve(lib, "ai-consent.ts"))}, () => ({ hasAiConsent: () => true, requestAiConsent() {} }));
    mock.module(${JSON.stringify(resolve(lib, "mobile-audio-session.ts"))}, () => ({
      acquireRecordingAudioSession: async () => 1,
      releaseRecordingAudioSession: async () => { releases++; },
    }));
    mock.module(${JSON.stringify(resolve(lib, "read-aloud.ts"))}, () => ({ stopReadAloudForDictation() {} }));
    mock.module(${JSON.stringify(resolve(lib, "dictation-meter.ts"))}, () => ({ startDictationMeter() {}, stopDictationMeter() {}, updateDictationMeter() {} }));
    mock.module(${JSON.stringify(resolve(lib, "dictation-transcript-preview.ts"))}, () => ({ resetDictationTranscriptPreview() {}, updateDictationTranscriptPreview() {} }));
    mock.module(${JSON.stringify(resolve(lib, "auth-token.ts"))}, () => ({ getConvexToken: async () => "fixture-token" }));
    mock.module(${JSON.stringify(resolve(lib, "http.ts"))}, () => ({
      postJson: async () => ({ relayOrigin: "https://relay.example" }),
      HttpRequestError: class extends Error {},
    }));
    class Socket {
      static OPEN = 1;
      static instances = [];
      readyState = 0;
      sent = [];
      constructor() { Socket.instances.push(this); }
      send(frame) { this.sent.push(frame); }
      close() { this.readyState = 3; }
      receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
      acknowledge() { this.readyState = 1; this.onopen?.({}); this.receive({ sessionId: "provider-session" }); }
      end() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    }
    globalThis.WebSocket = Socket;
    const { useDictation } = await import(${JSON.stringify(resolve(lib, "dictation.ts"))});
    const makeHook = () => useDictation({ anonymous: true, onTranscript: text => transcripts.push(text) });
    const hook = makeHook();
    const start = hook.start();
    await flush();
    const socket = Socket.instances.at(-1);
    socket.acknowledge();
    assert.equal(await start, true);
    assert.equal(subscriptions, 1);
    const oldAudioCallback = audioCallbacks.at(-1);
    const stopping = deferred();
    stopNative = () => stopping.promise;
    socket.receive({ type: "transcript", transcript: "partial", final: false });
    assert.equal(stops, 0);
    socket.receive({ type: "transcript", transcript: "Saved at the limit.", final: true });
    assert.equal(stops, 1, "terminal final starts native stop immediately");
    assert.equal(statuses.at(-1), "transcribing");
    socket.end();
    assert.deepEqual(transcripts, [], "wait for native cleanup before committing");
    stopping.resolve({});
    await flush();
    assert.deepEqual(transcripts, ["Saved at the limit."]);
    assert.equal(statuses.at(-1), "idle");
    assert.equal(subscriptions, 0);
    assert.equal(releases, 1);
    assert.deepEqual(alerts, []);

    stopNative = async () => ({});
    const restart = hook.start();
    await flush();
    const cancelledSocket = Socket.instances.at(-1);
    cancelledSocket.acknowledge();
    assert.equal(await restart, true);
    oldAudioCallback({ encoded: "AAA=" });
    assert.equal(cancelledSocket.sent.length, 0, "queued audio from an old recording cannot enter the restarted session");
    const queued = cancelledSocket.onmessage;
    await hook.cancel();
    queued({ data: JSON.stringify({ type: "transcript", transcript: "discard cancelled speech", final: true }) });
    await flush();
    assert.deepEqual(transcripts, ["Saved at the limit."]);
    assert.equal(subscriptions, 0);
    assert.equal(statuses.at(-1), "idle");

    const nativeStartup = deferred();
    startNative = () => nativeStartup.promise;
    const fast = hook.start();
    await flush();
    const fastSocket = Socket.instances.at(-1);
    fastSocket.acknowledge();
    await flush();
    fastSocket.receive({ type: "transcript", transcript: "Short allowance.", final: true });
    fastSocket.end();
    nativeStartup.resolve();
    assert.equal(await fast, true);
    await flush();
    assert.deepEqual(transcripts, ["Saved at the limit.", "Short allowance."], "a final during startup is not lost to the minimum-duration guard");
    assert.equal(statuses.at(-1), "idle");
    assert.equal(subscriptions, 0);

    startNative = async () => undefined;
    const unmountHook = makeHook();
    const last = unmountHook.start();
    await flush();
    const lastSocket = Socket.instances.at(-1);
    lastSocket.acknowledge();
    await last;
    const lastStop = deferred();
    stopNative = () => lastStop.promise;
    lastSocket.receive({ type: "transcript", transcript: "do not commit after unmount", final: true });
    cleanups.at(-1)();
    lastSocket.end();
    lastStop.resolve({});
    await flush();
    assert.deepEqual(transcripts, ["Saved at the limit.", "Short allowance."]);
    assert.equal(subscriptions, 0);
    assert.deepEqual(alerts, []);
  `], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
