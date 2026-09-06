import { handleMuseTranscribeSocket } from "../../src/muse-transcribe-socket.js";

const state = {
  providerFrames: [] as number[][],
  handshakes: 0,
  settlements: [] as Record<string, unknown>[],
};
const originalFetch = globalThis.fetch;
// Only external services are faked. Every binary event below is delivered by
// real Workerd WebSocketPair transport, including the production relay pair.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "control.fixture") {
    if (url.pathname.endsWith("/prepare")) {
      return Response.json({
        sessionId: "muse-fixture",
        ownerGeneration: "generation-1",
        providerDeadlineAt: Date.now() + 30_000,
      });
    }
    state.settlements.push((await request.json()) as Record<string, unknown>);
    return Response.json({ ok: true });
  }
  if (url.hostname === "api.meta.ai") {
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
        }
      }
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  throw new Error(`Unexpected fixture fetch: ${url.hostname}`);
}) as typeof originalFetch;

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response("ready");
    if (path === "/state") return Response.json(state);
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
      return await handleMuseTranscribeSocket({
        request,
        ownerId: "owner-fixture",
        env: {
          BUILDER_SERVICE_SECRET: "fixture-only",
          META_MODEL_API_KEY: "fixture-only",
          STELLA_CONVEX_SITE_URL: "https://control.fixture",
        },
        waitUntil: (work) => ctx.waitUntil(work),
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
