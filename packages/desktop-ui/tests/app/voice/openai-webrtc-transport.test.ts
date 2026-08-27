import { afterEach, describe, expect, it, vi } from "vitest";

const { createServiceRequestMock } = vi.hoisted(() => ({
  createServiceRequestMock: vi.fn(),
}));

vi.mock("@/platform/http/service-request", () => ({
  createServiceRequest: createServiceRequestMock,
}));

import { OpenAIWebRTCTransport } from "@/features/voice/services/realtime/transports/openai-webrtc-transport";
import {
  bearerSdpFetcher,
  stellaProxiedSdpFetcher,
} from "@/features/voice/services/realtime/transports/sdp-fetchers";

type PeerHarness = {
  dataChannel: RTCDataChannel;
  peerConnection: RTCPeerConnection;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  closeDataChannel: ReturnType<typeof vi.fn>;
  closePeerConnection: ReturnType<typeof vi.fn>;
};

const installPeerHarness = (): PeerHarness => {
  const closeDataChannel = vi.fn();
  const dataChannel = {
    readyState: "connecting",
    send: vi.fn(),
    close: closeDataChannel,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  } as unknown as RTCDataChannel;

  const setRemoteDescription = vi.fn(async () => undefined);
  const closePeerConnection = vi.fn();
  const peerConnection = {
    localDescription: null as RTCSessionDescription | null,
    ontrack: null,
    addTransceiver: vi.fn(() => ({
      sender: { replaceTrack: vi.fn(async () => undefined) },
    })),
    createDataChannel: vi.fn(() => dataChannel),
    createOffer: vi.fn(async () => ({
      type: "offer" as RTCSdpType,
      sdp: "offer-sdp",
    })),
    setLocalDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        Object.assign(peerConnection, { localDescription: description });
      },
    ),
    setRemoteDescription,
    close: closePeerConnection,
  } as unknown as RTCPeerConnection;

  const PeerConnection = vi.fn(function PeerConnection() {
    return peerConnection;
  });
  vi.stubGlobal("RTCPeerConnection", PeerConnection);

  return {
    dataChannel,
    peerConnection,
    setRemoteDescription,
    closeDataChannel,
    closePeerConnection,
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const connectEvents = () => ({
  onEvent: vi.fn(),
  onClose: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OpenAIWebRTCTransport SDP cancellation", () => {
  it("aborts SDP and refuses a late answer when disconnected", async () => {
    const peer = installPeerHarness();
    const answer = deferred<string>();
    const sdpStarted = deferred<void>();
    let sdpSignal: AbortSignal | null = null;
    const sdpFetch = vi.fn((offer: string, signal: AbortSignal) => {
      expect(offer).toBe("offer-sdp");
      sdpSignal = signal;
      sdpStarted.resolve();
      // Deliberately ignore cancellation here. The production fetchers honor
      // it; this proves a late custom response still cannot install an answer.
      return answer.promise;
    });
    const transport = new OpenAIWebRTCTransport({
      provider: "openai",
      model: "gpt-realtime",
      sdpFetch,
    });
    const events = connectEvents();

    const connectPromise = transport.connect(events);
    await sdpStarted.promise;
    await transport.disconnect();

    expect(sdpSignal?.aborted).toBe(true);
    expect(peer.closeDataChannel).toHaveBeenCalledOnce();
    expect(peer.closePeerConnection).toHaveBeenCalledOnce();
    await expect(connectPromise).resolves.toBeUndefined();

    answer.resolve("late-answer-sdp");
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(events.onClose).not.toHaveBeenCalled();
  });

  it("aborts and closes a pending SDP request at the 8 second deadline", async () => {
    vi.useFakeTimers();
    const peer = installPeerHarness();
    const answer = deferred<string>();
    const sdpStarted = deferred<void>();
    let sdpSignal: AbortSignal | null = null;
    const transport = new OpenAIWebRTCTransport({
      provider: "openai",
      model: "gpt-realtime",
      sdpFetch: (_offer, signal) => {
        sdpSignal = signal;
        sdpStarted.resolve();
        return answer.promise;
      },
    });

    const connectPromise = transport.connect(connectEvents());
    const timedOut = expect(connectPromise).rejects.toThrow(
      "Timed out while connecting to the realtime voice provider.",
    );
    await sdpStarted.promise;

    await vi.advanceTimersByTimeAsync(7_999);
    expect(sdpSignal?.aborted).toBe(false);
    expect(peer.closePeerConnection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(sdpSignal?.aborted).toBe(true);
    expect(peer.closeDataChannel).toHaveBeenCalledOnce();
    expect(peer.closePeerConnection).toHaveBeenCalledOnce();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();

    answer.resolve("too-late-answer-sdp");
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
  });
});

describe("SDP fetchers", () => {
  it("forwards the transport AbortSignal to bearer and Stella proxy fetches", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "answer-sdp",
    }));
    vi.stubGlobal("fetch", fetchMock);
    createServiceRequestMock.mockResolvedValue({
      endpoint: "https://voice.stella.test/sdp",
      headers: { Authorization: "Bearer session" },
    });
    const controller = new AbortController();

    await expect(
      bearerSdpFetcher("https://provider.test/sdp", "provider-token")(
        "offer-sdp",
        controller.signal,
      ),
    ).resolves.toBe("answer-sdp");
    await expect(
      stellaProxiedSdpFetcher("/api/voice/inworld/sdp", "voice-session-1")(
        "offer-sdp",
        controller.signal,
      ),
    ).resolves.toBe("answer-sdp");
    await expect(
      stellaProxiedSdpFetcher(
        "/api/voice/openai/sdp",
        "voice-session-2",
        {
          ownerGeneration: "generation-2",
          providerDispatchId: "dispatch-2",
          providerAttemptId: "attempt-2",
        },
      )("offer-sdp", controller.signal),
    ).resolves.toBe("answer-sdp");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://provider.test/sdp",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://voice.stella.test/sdp",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(createServiceRequestMock).toHaveBeenNthCalledWith(
      2,
      "/api/voice/openai/sdp",
      expect.objectContaining({
        "X-Stella-Voice-Session-ID": "voice-session-2",
        "X-Stella-Owner-Generation": "generation-2",
        "X-Stella-Provider-Dispatch-ID": "dispatch-2",
        "X-Stella-Provider-Attempt-ID": "attempt-2",
      }),
    );
  });
});
