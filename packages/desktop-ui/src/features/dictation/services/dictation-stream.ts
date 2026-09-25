import { getConvexToken } from "@/global/auth/services/auth-token";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import { postServiceJson } from "@/platform/http/service-request";

type RealtimeConfig = { relayOrigin: string; modelId: string };
type DictationTranscriptFrame = {
  type?: unknown;
  transcript?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
};

const OPEN_TIMEOUT_MS = 10_000;
const FINAL_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 90_000;

/** The relay origin only changes with a deploy; re-check it now and then. */
const CONFIG_TTL_MS = 10 * 60_000;
let cachedConfig: { value: Promise<RealtimeConfig>; at: number } | null = null;

/**
 * The realtime config (and the auth check behind it) is a Convex round trip
 * on the path to the socket. Reuse it across presses, and let callers warm it
 * before the user presses the mic.
 */
export const loadDictationRealtimeConfig = (): Promise<RealtimeConfig> => {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) {
    return cachedConfig.value;
  }
  const entry = {
    value: postServiceJson<RealtimeConfig>(
      "/api/dictation/realtime-config",
      {},
    ),
    at: Date.now(),
  };
  cachedConfig = entry;
  entry.value.catch(() => {
    if (cachedConfig === entry) cachedConfig = null;
  });
  return entry.value;
};

/**
 * Fetch what a press needs before the socket (relay config and a fresh Convex
 * token) so the press itself goes straight to the handshake. Both are cached,
 * so calling this on hover, focus, or mount is cheap.
 */
export const prewarmDictation = (): void => {
  void Promise.all([loadDictationRealtimeConfig(), getConvexToken()]).catch(
    () => undefined,
  );
};

/** A likely press: also connect the relay socket ahead of it. */
export const prewarmDictationSocket = (): void => {
  prewarmDictation();
  warmDictationSocket();
};

/**
 * Open an authenticated relay socket in deferred-start mode: the relay
 * accepts it without reserving anything until the client sends `start`.
 */
const connectRelay = async (): Promise<WebSocket> => {
  const [config, token] = await Promise.all([
    loadDictationRealtimeConfig(),
    getConvexToken(),
  ]);
  if (!token) throw new Error("Sign in to Stella to use dictation.");
  const base = getStellaInteriorBridge()?.gatewayOrigin ?? config.relayOrigin;
  const url = new URL("/dictation/socket", base);
  url.searchParams.set("start", "deferred");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";

  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url.toString(), [
      "stella.v1",
      `stella.token.${token}`,
    ]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Dictation took too long to connect."));
    }, OPEN_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onclose = null;
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to dictation."));
    };
    socket.onclose = () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to dictation."));
    };
  });
};

/** Close an unused warm socket before the relay's 60 s idle limit. */
const WARM_SOCKET_TTL_MS = 50_000;
let warmSocket: { socket: Promise<WebSocket>; expiresAt: number } | null =
  null;

/**
 * Connect ahead of a likely press (mic hover or focus). The socket holds no
 * reservation and no provider session until a press sends `start`.
 */
export const warmDictationSocket = (): void => {
  if (warmSocket && Date.now() < warmSocket.expiresAt) return;
  const entry = {
    socket: connectRelay(),
    expiresAt: Date.now() + WARM_SOCKET_TTL_MS,
  };
  warmSocket = entry;
  entry.socket.then(
    (socket) => {
      socket.onclose = () => {
        if (warmSocket === entry) warmSocket = null;
      };
      setTimeout(() => {
        if (warmSocket !== entry) return;
        warmSocket = null;
        socket.close(1000, "Dictation idle");
      }, Math.max(0, entry.expiresAt - Date.now()));
    },
    () => {
      if (warmSocket === entry) warmSocket = null;
    },
  );
};

/** Claim the warm socket if one is usable, else fall back to a fresh one. */
const takeWarmSocket = (): Promise<WebSocket> | null => {
  const entry = warmSocket;
  warmSocket = null;
  if (!entry || Date.now() >= entry.expiresAt) {
    void entry?.socket.then((socket) => socket.close(1000), () => undefined);
    return null;
  }
  return entry.socket.then(
    (socket) =>
      socket.readyState === WebSocket.OPEN ? socket : connectRelay(),
    () => connectRelay(),
  );
};

const exactBuffer = (pcm: Int16Array): ArrayBuffer =>
  pcm.buffer.slice(
    pcm.byteOffset,
    pcm.byteOffset + pcm.byteLength,
  ) as ArrayBuffer;

export class DictationStream {
  private socket: WebSocket | null = null;
  private transcript = "";
  private finalTranscript = "";
  private streamError: Error | null = null;
  private finishResolve: ((value: string) => void) | null = null;
  private finishReject: ((reason: Error) => void) | null = null;
  private cancelled = false;
  private failed = false;

  constructor(
    private readonly onPartial?: (text: string) => void,
    /** The relay ended the session while recording (not while finishing). */
    private readonly onFailure?: (error: Error) => void,
  ) {}

  private fail(error: Error): void {
    if (this.failed || this.cancelled) return;
    this.failed = true;
    this.onFailure?.(error);
  }

  async open(): Promise<void> {
    const socket = await (takeWarmSocket() ?? connectRelay());
    if (this.cancelled) {
      socket.close(1000, "Cancelled");
      throw new Error("Dictation cancelled.");
    }
    this.socket = socket;
    socket.onerror = null;
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = (event) => {
      this.socket = null;
      if (this.finishReject && this.streamError) {
        this.finishReject(this.streamError);
      } else if (
        this.finishResolve &&
        (event.code === 1000 || this.finalTranscript)
      ) {
        this.finishResolve(this.finalTranscript || this.transcript);
      } else if (this.finishReject) {
        this.finishReject(
          new Error(event.reason || "Dictation disconnected."),
        );
      } else if (!this.cancelled) {
        this.fail(
          this.streamError ??
            new Error(event.reason || "Dictation disconnected."),
        );
      }
      this.clearFinishHandlers();
    };
    // The relay reserves the session and opens the provider only now.
    socket.send(JSON.stringify({ type: "start" }));
  }

  send(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN || pcm.length === 0) return;
    this.socket.send(exactBuffer(pcm));
  }

  async replay(chunks: readonly Int16Array[]): Promise<void> {
    const deadline = Date.now() + REPLAY_TIMEOUT_MS;
    for (const chunk of chunks) {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Dictation disconnected.");
      }
      while (socket.bufferedAmount > 256 * 1024) {
        if (Date.now() >= deadline) {
          throw new Error("Dictation took too long to receive audio.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("Dictation disconnected.");
        }
      }
      this.send(chunk);
    }
  }

  async finish(): Promise<string> {
    if (this.streamError) throw this.streamError;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Dictation is not connected.");
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearFinishHandlers();
        socket.close();
        reject(new Error("Dictation took too long to finish."));
      }, FINAL_TIMEOUT_MS);
      this.finishResolve = (value) => {
        clearTimeout(timer);
        resolve(value.trim());
      };
      this.finishReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.send(JSON.stringify({ type: "endStream" }));
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.clearFinishHandlers();
    this.socket?.close(1000, "Cancelled");
    this.socket = null;
  }

  private handleMessage(value: unknown): void {
    if (typeof value !== "string") return;
    let frame: DictationTranscriptFrame;
    try {
      frame = JSON.parse(value) as DictationTranscriptFrame;
    } catch {
      return;
    }
    if (frame.type === "error") {
      this.streamError = new Error(
        typeof frame.message === "string"
          ? frame.message
          : "Dictation failed.",
      );
      if (this.finishReject) this.finishReject(this.streamError);
      else this.fail(this.streamError);
      this.clearFinishHandlers();
      return;
    }
    if (frame.type !== "transcript") return;
    const text =
      typeof frame.transcript === "string"
        ? frame.transcript
        : typeof frame.text === "string"
          ? frame.text
          : "";
    this.transcript = text;
    this.onPartial?.(text);
    if (frame.final === true) this.finalTranscript = text;
  }

  private clearFinishHandlers(): void {
    this.finishResolve = null;
    this.finishReject = null;
  }
}
