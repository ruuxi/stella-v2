/**
 * Lightweight diagnostics for the desktop transcript sync. Production reports
 * so far have been blind ("it just doesn't sync") — every pull now records
 * what it asked for and what came back, both to the console (visible in
 * device logs / `npx expo run` output) and to an in-memory ring buffer that a
 * debug surface can dump later.
 */

export interface SyncDiagnosticEntry {
  at: number;
  /** What initiated the pull (landing, resume, force-sync, poll, push, send). */
  trigger: string;
  catchUp: boolean;
  /** Delta cursor sent, or null for a full-window pull. */
  sinceCursor: string | null;
  fullWindow: boolean;
  outcome: "ok" | "offline" | "error" | "deferred" | "stale-generation";
  /** Rows the desktop returned (before merge de-dupe). */
  rows?: number;
  cursorOut?: string | null;
  conversationChanged?: boolean;
  durationMs?: number;
  error?: string;
}

const MAX_ENTRIES = 50;
const entries: SyncDiagnosticEntry[] = [];

export function recordSyncDiagnostic(entry: SyncDiagnosticEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const cursorLabel = entry.fullWindow
    ? "full-window"
    : `delta(${entry.sinceCursor ?? "none"})`;
  const parts = [
    `[computer-sync] ${entry.trigger}${entry.catchUp ? " catch-up" : ""}`,
    cursorLabel,
    entry.outcome,
    entry.rows !== undefined ? `rows=${entry.rows}` : null,
    entry.conversationChanged ? "conversation-changed" : null,
    entry.durationMs !== undefined ? `${entry.durationMs}ms` : null,
    entry.cursorOut !== undefined ? `cursor→${entry.cursorOut ?? "none"}` : null,
    entry.error ? `error=${entry.error}` : null,
  ].filter(Boolean);
  console.log(parts.join(" "));
}

/** Most-recent-last snapshot for a future debug surface. */
export function getSyncDiagnostics(): readonly SyncDiagnosticEntry[] {
  return entries.slice();
}
