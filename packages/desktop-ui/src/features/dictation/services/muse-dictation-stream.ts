import { getConvexToken } from "@/global/auth/services/auth-token";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import { postServiceJson } from "@/platform/http/service-request";

type RealtimeConfig = { relayOrigin: string; modelId: string };
type MuseTranscriptFrame = {
  type?: unknown;
  transcript?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
};

const OPEN_TIMEOUT_MS = 10_000;
const FINAL_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 90_000;

const exactBuffer = (pcm: Int16Array): ArrayBuffer =>
  pcm.buffer.slice(
    pcm.byteOffset,
    pcm.byteOffset + pcm.byteLength,
  ) as ArrayBuffer;

export class MuseDictationStream {
  private socket: WebSocket | null = null;
  private transcript = "";
  private finalTranscript = "";
  private streamError: Error | null = null;
  private finishResolve: ((value: string) => void) | null = null;
  private finishReject: ((reason: Error) => void) | null = null;

  constructor(private readonly onPartial?: (text: string) => void) {}

  async open(): Promise<void> {
    const [config, token] = await Promise.all([
      postServiceJson<RealtimeConfig>("/api/dictation/realtime-config", {}),
      getConvexToken(),
    ]);
    if (!token) throw new Error("Sign in to Stella to use dictation.");
    const base = getStellaInteriorBridge()?.gatewayOrigin ?? config.relayOrigin;
    const url = new URL("/dictation/socket", base);
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
        reject(new Error("Muse transcription took too long to connect."));
      }, OPEN_TIMEOUT_MS);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to Muse transcription."));
      };
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
            new Error(event.reason || "Muse transcription disconnected."),
          );
        }
        this.clearFinishHandlers();
      };
    });
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
        throw new Error("Muse transcription disconnected.");
      }
      while (socket.bufferedAmount > 256 * 1024) {
        if (Date.now() >= deadline) {
          throw new Error("Muse transcription took too long to receive audio.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("Muse transcription disconnected.");
        }
      }
      this.send(chunk);
    }
  }

  async finish(): Promise<string> {
    if (this.streamError) throw this.streamError;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Muse transcription is not connected.");
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearFinishHandlers();
        socket.close();
        reject(new Error("Muse transcription took too long to finish."));
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
    this.clearFinishHandlers();
    this.socket?.close(1000, "Cancelled");
    this.socket = null;
  }

  private handleMessage(value: unknown): void {
    if (typeof value !== "string") return;
    let frame: MuseTranscriptFrame;
    try {
      frame = JSON.parse(value) as MuseTranscriptFrame;
    } catch {
      return;
    }
    if (frame.type === "error") {
      this.streamError = new Error(
        typeof frame.message === "string"
          ? frame.message
          : "Muse transcription failed.",
      );
      this.finishReject?.(this.streamError);
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
