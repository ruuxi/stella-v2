import {
  DictationUsageError,
  handleMuseTranscribeSocket,
  type MuseControl,
} from "../../src/muse-transcribe-socket.js";

const state = {
  providerFrames: [] as number[][],
  handshakes: 0,
  settlements: [] as Record<string, unknown>[],
  preparedSessionIds: [] as string[],
  prepareFinishedAt: 0,
  handshakeAt: 0,
  providerSessionIds: [] as string[],
};
const originalFetch = globalThis.fetch;
let fixtureOrigin = "";
// The relay opens the provider upgrade while prepare runs, so a hanging
// provider is chosen per relay request rather than by the prepared session.
let hangProvider = false;
// Only external services are faked. Every binary event below is delivered by
// real Workerd WebSocketPair transport, including the production relay pair.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "api.meta.ai") {
    state.providerSessionIds.push(url.searchParams.get("sessionId") ?? "");
    // Use native fetch over a real upgrade, so its AbortSignal has Workerd's
    // actual post-upgrade lifetime semantics rather than a mock's behavior.
    return await originalFetch(
      new Request(
        `${fixtureOrigin}/provider${hangProvider ? "?hang=1" : ""}`,
        request,
      ),
    );
  }
  throw new Error(`Unexpected fixture fetch: ${url.hostname}`);
}) as typeof originalFetch;

/** The owner's metering, faked per fixture owner. */
const fixtureControl = (ownerId: string): MuseControl => ({
  async prepare(sessionId) {
    state.preparedSessionIds.push(sessionId);
    if (ownerId === "owner-slow-prepare")
      await new Promise((resolve) => setTimeout(resolve, 400));
    state.prepareFinishedAt = Date.now();
    if (ownerId === "owner-exhausted")
      throw new DictationUsageError("Your Stella usage allowance is exhausted.");
    return {
      sessionId: ownerId === "owner-hanging" ? "muse-hanging" : "muse-fixture",
      providerDeadlineAt:
        Date.now() + (ownerId === "owner-deadline" ? 500 : 30_000),
      ...(ownerId === "owner-capped" ? { maxAudioBytes: 6 } : {}),
    };
  },
  async settle(usage) {
    state.settlements.push(usage);
  },
});

const providerResponse = () => {
  const pair = new WebSocketPair();
  const provider = pair[1];
  provider.binaryType = "arraybuffer";
  provider.accept();
  provider.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      state.providerFrames.push([...new Uint8Array(event.data)]);
    } else {
      const message = JSON.parse(String(event.data));
      if (message.type === "endStream") {
        provider.send(
          JSON.stringify({
            type: "transcript",
            final: true,
            text: "binary audio accepted",
          }),
        );
        provider.close(1000, "done");
      } else {
        state.handshakes += 1;
        state.handshakeAt = Date.now();
      }
    }
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
};

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response("ready");
    if (path === "/state") return Response.json(state);
    if (path === "/provider") {
      if (new URL(request.url).searchParams.has("hang")) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      return providerResponse();
    }
    if (path === "/default-binary") {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      server.addEventListener("message", (event) => {
        server.send(
          JSON.stringify({
            binaryType: server.binaryType,
            isBlob: event.data instanceof Blob,
            isArrayBuffer: event.data instanceof ArrayBuffer,
          }),
        );
        server.close(1000, "observed");
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/relay") {
      fixtureOrigin = new URL(request.url).origin;
      hangProvider = new URL(request.url).searchParams.has("hang");
      return await handleMuseTranscribeSocket({
        request,
        control: fixtureControl(
          new URL(request.url).searchParams.has("hang")
            ? "owner-hanging"
            : `owner-${new URL(request.url).searchParams.get("case") ?? "fixture"}`,
        ),
        env: { META_MODEL_API_KEY: "fixture-only" },
        waitUntil: (work) => ctx.waitUntil(work),
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
