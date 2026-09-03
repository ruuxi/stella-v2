import { getConvexToken } from "./auth-token";
import { postJson } from "./http";

type RealtimeConfig = { relayOrigin: string; modelId: string };
type TranscriptFrame = {
  type?: unknown;
  transcript?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
};

export class DictationStream {
  private socket: WebSocket | null = null;
  private transcript = "";
  private finalTranscript = "";
  private streamError: Error | null = null;

  constructor(private readonly onPartial?: (text: string) => void) {}

  async open(): Promise<void> {
    const [config, token] = await Promise.all([
      postJson("/api/dictation/realtime-config", {}),
      getConvexToken(),
    ]);
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
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Dictation took too long to connect."));
      }, 10_000);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to dictation."));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let frame: TranscriptFrame;
        try {
          frame = JSON.parse(event.data) as TranscriptFrame;
        } catch {
          return;
        }
        if (frame.type === "transcript") {
          const transcript =
            typeof frame.transcript === "string"
              ? frame.transcript
              : typeof frame.text === "string"
                ? frame.text
                : this.transcript;
          this.transcript = transcript;
          this.onPartial?.(transcript);
          if (frame.final === true) this.finalTranscript = transcript;
        } else if (frame.type === "error") {
          this.streamError = new Error(
            typeof frame.message === "string"
              ? frame.message
              : "Dictation failed.",
          );
        }
      };
    });
  }

  send(bytes: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN && bytes.byteLength > 0) {
      this.socket.send(bytes);
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
        socket.close();
        reject(new Error("Dictation took too long to finish."));
      }, 15_000);
      socket.onclose = (event) => {
        clearTimeout(timer);
        this.socket = null;
        if (this.streamError) reject(this.streamError);
        else if (event.code === 1000 || this.finalTranscript) {
          resolve((this.finalTranscript || this.transcript).trim());
        } else {
          reject(new Error(event.reason || "Dictation disconnected."));
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Dictation failed."));
      };
      socket.send(JSON.stringify({ type: "endStream" }));
    });
  }

  cancel(): void {
    this.socket?.close(1000, "Cancelled");
    this.socket = null;
  }
}
