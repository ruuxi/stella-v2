export interface SyncDiagnosticEntry {
  at: number;

  trigger: string;
  catchUp: boolean;

  sinceCursor: string | null;
  fullWindow: boolean;
  outcome: "ok" | "offline" | "error" | "deferred" | "stale-generation";

  rows?: number;
  pages?: number;
  cursorOut?: string | null;
  cursorStatus?: "valid" | "snapshot" | "invalid";
  continuationNeeded?: boolean;
  conversationChanged?: boolean;
  durationMs?: number;
  error?: string;
}

const MAX_ENTRIES = 50;
const entries: SyncDiagnosticEntry[] = [];

export function recordSyncDiagnostic(entry: SyncDiagnosticEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES)
    entries.splice(0, entries.length - MAX_ENTRIES);
  const cursorLabel = entry.fullWindow
    ? "full-window"
    : `delta(${entry.sinceCursor ?? "none"})`;
  const parts = [
    `[computer-sync] ${entry.trigger}${entry.catchUp ? " catch-up" : ""}`,
    cursorLabel,
    entry.outcome,
    entry.rows !== undefined ? `rows=${entry.rows}` : null,
    entry.pages !== undefined ? `pages=${entry.pages}` : null,
    entry.cursorStatus ? `cursor=${entry.cursorStatus}` : null,
    entry.continuationNeeded ? "continuing" : null,
    entry.conversationChanged ? "conversation-changed" : null,
    entry.durationMs !== undefined ? `${entry.durationMs}ms` : null,
    entry.cursorOut !== undefined
      ? `cursor→${entry.cursorOut ?? "none"}`
      : null,
    entry.error ? `error=${entry.error}` : null,
  ].filter(Boolean);
  console.log(parts.join(" "));
}

export function getSyncDiagnostics(): readonly SyncDiagnosticEntry[] {
  return entries.slice();
}
