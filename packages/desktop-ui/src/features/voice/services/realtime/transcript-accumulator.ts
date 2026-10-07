/**
 * Turn reconstruction for GPT-Live transcripts.
 *
 * GPT-Live reports speech as fragments: `session.input_transcript.delta` and
 * `session.output_transcript.delta` each carry a `delta` plus `start_ms` and
 * `end_ms` relative to the session clock. A fragment is explicitly NOT a
 * complete turn and there is no "transcript done" event, so anything that
 * needs a whole utterance — persisting history, matching a goodbye, building
 * a delegation request — has to accumulate here.
 *
 * A run of fragments is closed when any of these happens:
 *   - the other speaker starts (role switch),
 *   - the next fragment starts more than `TURN_GAP_MS` after the previous one
 *     ended, which is a pause long enough to be a new utterance,
 *   - no fragment arrives for `TURN_IDLE_MS` (the common case at end of turn),
 *   - the session asks for an explicit flush (disconnect, delegation).
 */

export type TranscriptRole = "user" | "assistant";

export type CompletedTranscriptTurn = {
  role: TranscriptRole;
  text: string;
  startMs: number;
  endMs: number;
};

const TURN_GAP_MS = 1_200;
const TURN_IDLE_MS = 800;
const MAX_RETAINED_TURNS = 24;

type OpenTurn = {
  role: TranscriptRole;
  parts: string[];
  startMs: number;
  endMs: number;
};

const joinFragments = (parts: readonly string[]): string => {
  let text = "";
  for (const part of parts) {
    if (!part) continue;
    if (!text) {
      text = part;
      continue;
    }
    const needsSpace =
      !/\s$/.test(text) && !/^\s/.test(part) && !/^[,.!?;:)\]}'"]/.test(part);
    text += needsSpace ? ` ${part}` : part;
  }
  return text.replace(/\s+/g, " ").trim();
};

export class TranscriptAccumulator {
  private open: OpenTurn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turns: CompletedTranscriptTurn[] = [];

  constructor(
    private readonly handlers: {
      /** Every fragment, for live (non-final) UI. */
      onPartial: (role: TranscriptRole, text: string) => void;
      /** One reconstructed utterance. */
      onTurn: (turn: CompletedTranscriptTurn) => void;
    },
  ) {}

  /** Feed one `*_transcript.delta`. */
  push(args: {
    role: TranscriptRole;
    delta: string;
    startMs?: number;
    endMs?: number;
  }): void {
    const delta = args.delta;
    if (!delta) return;

    const startMs = Number.isFinite(args.startMs)
      ? (args.startMs as number)
      : (this.open?.endMs ?? 0);
    const endMs = Number.isFinite(args.endMs)
      ? (args.endMs as number)
      : startMs;

    if (this.open) {
      const roleChanged = this.open.role !== args.role;
      const gapped = startMs - this.open.endMs > TURN_GAP_MS;
      if (roleChanged || gapped) this.flush();
    }

    if (!this.open) {
      this.open = { role: args.role, parts: [], startMs, endMs };
    }
    this.open.parts.push(delta);
    this.open.endMs = Math.max(this.open.endMs, endMs);

    this.handlers.onPartial(args.role, delta);
    this.armIdleTimer();
  }

  /** Close the open run, if any, and report it as a completed turn. */
  flush(): CompletedTranscriptTurn | null {
    this.clearIdleTimer();
    const open = this.open;
    this.open = null;
    if (!open) return null;

    const text = joinFragments(open.parts);
    if (!text) return null;

    const turn: CompletedTranscriptTurn = {
      role: open.role,
      text,
      startMs: open.startMs,
      endMs: open.endMs,
    };
    this.turns.push(turn);
    if (this.turns.length > MAX_RETAINED_TURNS) {
      this.turns.splice(0, this.turns.length - MAX_RETAINED_TURNS);
    }
    this.handlers.onTurn(turn);
    return turn;
  }

  /** Completed turns, oldest first. Includes whatever is still open. */
  snapshot(): CompletedTranscriptTurn[] {
    const pending = this.open
      ? [
          {
            role: this.open.role,
            text: joinFragments(this.open.parts),
            startMs: this.open.startMs,
            endMs: this.open.endMs,
          },
        ].filter((turn) => turn.text.length > 0)
      : [];
    return [...this.turns, ...pending];
  }

  /** The most recent user speech, newest last, up to `limit` utterances. */
  recentUserTurns(limit: number): CompletedTranscriptTurn[] {
    return this.snapshot()
      .filter((turn) => turn.role === "user")
      .slice(-limit);
  }

  reset(): void {
    this.clearIdleTimer();
    this.open = null;
    this.turns = [];
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flush();
    }, TURN_IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
