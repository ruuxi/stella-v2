/**
 * Keeps dictation audio ingress at real time.
 *
 * Meta's realtime ASR runs a wall clock from the handshake and closes the
 * session (code 1008, "ingress audio slower than real-time") once the audio it
 * has received falls a cumulative ten seconds behind that clock. It also
 * closes when more than five seconds of audio is queued ahead of real time.
 * The phone only ever hands us what the microphone captured, so any gap in
 * capture (audio-session interruption, route change, a brief suspension, a
 * slow recorder start) becomes permanent lateness that eventually ends the
 * session mid-sentence.
 *
 * The pacer accounts for the audio it forwards and, from a timer, fills any
 * lateness beyond a small tolerance with silence. Silence is only sent when
 * the timer fires on schedule: a late timer means the JS thread was blocked,
 * and the recorder's queued buffers are about to catch the stream up on their
 * own. Padding on top of those would push the session past the backlog limit
 * instead.
 */

import type { DictationStream } from "./dictation-stream";

/** 16 kHz mono signed 16-bit PCM. */
const PCM_BYTES_PER_MS = 32;
const TICK_MS = 250;
/** A tick this late means the JS thread stalled; queued audio will follow. */
const STALLED_TICK_MS = 200;
/** Lateness we tolerate before sending silence. */
const PAD_AFTER_MS = 1_000;
/** Lateness left in place so an in-flight recorder chunk cannot overshoot. */
const PAD_KEEP_MS = 250;
/** Largest single fill; also the relay's per-frame limit. */
const MAX_PAD_MS = 1_000;

export class DictationIngressPacer {
  private sentMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedTickAt = 0;

  constructor(
    private readonly stream: Pick<DictationStream, "send">,
    /** When the provider's clock started: the handshake acknowledgment. */
    private readonly startedAt: number = Date.now(),
  ) {}

  /** Forward captured audio and account for its duration. */
  send(bytes: ArrayBuffer): void {
    this.stream.send(bytes);
    this.sentMs += bytes.byteLength / PCM_BYTES_PER_MS;
  }

  start(): void {
    if (this.timer !== null) return;
    this.expectedTickAt = Date.now() + TICK_MS;
    this.timer = setInterval(this.tick, TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private readonly tick = (): void => {
    const now = Date.now();
    const lateness = now - this.expectedTickAt;
    this.expectedTickAt = now + TICK_MS;
    if (lateness > STALLED_TICK_MS) return;
    const deficitMs = now - this.startedAt - this.sentMs;
    if (deficitMs < PAD_AFTER_MS) return;
    const padMs = Math.min(MAX_PAD_MS, deficitMs - PAD_KEEP_MS);
    const silence = new ArrayBuffer(Math.floor(padMs) * PCM_BYTES_PER_MS);
    this.send(silence);
  };
}
