import { getConvexToken } from "./auth-token";
import { postJson } from "./http";

// The relay accepts at most one second of 16 kHz mono signed PCM per frame.
const MAX_PCM_FRAME_BYTES = 16_000 * 2;

type RealtimeConfig = { relayOrigin: string; modelId: string };
type TranscriptFrame = {
  type?: unknown;
  sessionId?: unknown;
  transcript?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
};

export class DictationStream {
  private socket: WebSocket | null = null;
  private transcript = "";
  private finalTranscript = "";
  private hasFinalTranscript = false;
  private streamError: Error | null = null;
  private cancelled = false;
  private rejectOpening: ((error: Error) => void) | null = null;
  private rejectFinishing: ((error: Error) => void) | null = null;

  constructor(
    private readonly onPartial?: (text: string) => void,
    private readonly onFailure?: (error: Error) => void,
    private readonly onFinal?: () => void,
  ) {}

  get isComplete(): boolean {
    return this.hasFinalTranscript;
  }

  throwIfFailed(): void {
    if (this.streamError) throw this.streamError;
    if (this.cancelled) throw new Error("Dictation cancelled.");
  }

  private fail(error: Error): void {
    if (this.cancelled || this.streamError || this.hasFinalTranscript) return;
    this.streamError = error;
    if (this.rejectOpening) this.rejectOpening(error);
    else if (this.rejectFinishing) this.rejectFinishing(error);
    else this.onFailure?.(error);
  }

  async open(): Promise<void> {
    const [config, token] = await Promise.all([
      postJson("/api/dictation/realtime-config", {}),
      getConvexToken(),
    ]);
    if (this.cancelled) throw new Error("Dictation cancelled.");
    const relayOrigin = (config as RealtimeConfig).relayOrigin;
    const url = new URL("/dictation/socket", relayOrigin);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url.toString(), [
        "stella.v1",
        `stella.token.${token}`,
      ]);
      this.socket = socket;
      const failOpening = (error: Error) => {
        clearTimeout(timer);
        this.rejectOpening = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          /* The peer may already be gone. */
        }
        reject(error);
      };
      const timer = setTimeout(() => {
        failOpening(new Error("Dictation took too long to connect."));
      }, 10_000);
      this.rejectOpening = failOpening;
      socket.binaryType = "arraybuffer";
      // The relay forwards Muse's handshake acknowledgment unchanged. A
      // WebSocket upgrade alone does not mean the provider accepted its key.
      socket.onopen = () => undefined;
      socket.onerror = () => {
        this.fail(
          new Error(
            this.rejectOpening
              ? "Could not connect to dictation."
              : "Dictation disconnected.",
          ),
        );
      };
      socket.onclose = () => {
        this.fail(
          new Error(
            this.rejectOpening
              ? "Could not connect to dictation."
              : "Dictation disconnected.",
          ),
        );
      };
      socket.onmessage = (event) => {
        if (
          this.cancelled ||
          this.streamError ||
          this.hasFinalTranscript ||
          this.socket !== socket
        )
          return;
        if (typeof event.data !== "string") return;
        let frame: TranscriptFrame;
        try {
          frame = JSON.parse(event.data) as TranscriptFrame;
        } catch {
          return;
        }
        if (
          frame.type === undefined &&
          typeof frame.sessionId === "string" &&
          frame.sessionId.trim() &&
          this.rejectOpening
        ) {
          clearTimeout(timer);
          this.rejectOpening = null;
          resolve();
        } else if (frame.type === "transcript") {
          if (this.rejectOpening) return;
          const transcript =
            typeof frame.transcript === "string"
              ? frame.transcript
              : typeof frame.text === "string"
                ? frame.text
                : this.transcript;
          this.transcript = transcript;
          this.onPartial?.(transcript);
          if (frame.final === true) {
            // The relay uses PUSH_TO_TALK: final ends the entire session,
            // including when the relay ended input at the allowance limit.
            this.finalTranscript = transcript;
            this.hasFinalTranscript = true;
            if (!this.cancelled && this.socket === socket) this.onFinal?.();
          }
        } else if (frame.type === "error") {
          this.fail(
            new Error(
              typeof frame.message === "string"
                ? frame.message
                : "Dictation failed.",
            ),
          );
        }
      };
    });
  }

  send(bytes: ArrayBuffer): void {
    const socket = this.socket;
    if (
      this.cancelled ||
      this.streamError ||
      this.hasFinalTranscript ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      bytes.byteLength === 0
    )
      return;
    if (bytes.byteLength % 2 !== 0) {
      this.fail(new Error("The microphone returned invalid audio."));
      return;
    }
    // Native delivery can coalesce beyond the requested interval (including
    // the final flush). Preserve PCM sample boundaries/order while enforcing
    // the relay's frame limit independently of native callback timing.
    try {
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += MAX_PCM_FRAME_BYTES
      ) {
        socket.send(
          bytes.byteLength <= MAX_PCM_FRAME_BYTES
            ? bytes
            : bytes.slice(offset, offset + MAX_PCM_FRAME_BYTES),
        );
      }
    } catch {
      this.fail(new Error("Could not send dictation audio."));
    }
  }

  async finish(): Promise<string> {
    this.throwIfFailed();
    const socket = this.socket;
    // Provider completion can precede native stopRecording's final flush and
    // close the socket before the hook reaches finish(). Keep that success.
    if (this.hasFinalTranscript) {
      this.socket = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          /* Already closed by the relay. */
        }
      }
      return this.finalTranscript.trim();
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Dictation is not connected.");
    }
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const complete = (error: Error | null, text = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rejectFinishing = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          /* Settlement must still complete. */
        }
        if (error) reject(error);
        else resolve(text);
      };
      const timer = setTimeout(() => {
        complete(new Error("Dictation took too long to finish."));
      }, 15_000);
      this.rejectFinishing = (error) => complete(error);
      socket.onclose = (event) => {
        if (this.streamError) complete(this.streamError);
        else if (event.code === 1000 || this.hasFinalTranscript) {
          complete(
            null,
            (this.hasFinalTranscript ? this.finalTranscript : this.transcript).trim(),
          );
        } else {
          complete(new Error(event.reason || "Dictation disconnected."));
        }
      };
      socket.onerror = () => this.fail(new Error("Dictation failed."));
      try {
        socket.send(JSON.stringify({ type: "endStream" }));
      } catch {
        complete(new Error("Dictation disconnected."));
      }
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.rejectOpening?.(new Error("Dictation cancelled."));
    this.rejectFinishing?.(new Error("Dictation cancelled."));
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
    }
    try {
      this.socket?.close(1000, "Cancelled");
    } catch {
      /* Best effort. */
    }
    this.socket = null;
  }
}
