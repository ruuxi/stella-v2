/**
 * This computer's two-way memory sync with the owner's cloud, as the renderer
 * sees it. The sync itself runs in Electron main
 * (`electron/services/memory-sync/`); the renderer only shows it and asks for
 * a pass.
 *
 * - `signed_out`: no connected account, so nothing syncs.
 * - `off`: the owner turned memory off (or it is being erased); nothing syncs.
 * - `syncing` / `synced`: the files under `~/.stella` that are memory
 *   (`core-memory.md`, `memories/**.md`, `PERSONALITY.md`) are kept the same
 *   here and in the cloud.
 * - `held`: this computer has memory it will not upload. `wiped`: cloud
 *   memory was erased after this computer last synced (or before it ever
 *   did), so its memory goes up only once the owner allows it, or is erased
 *   here. `other_account`: this computer's memory is kept with a different
 *   Stella account.
 * - `error`: the last pass failed; the next one retries.
 */

export type MemorySyncPhase =
  | "signed_out"
  | "off"
  | "syncing"
  | "synced"
  | "held"
  | "error";

export type MemorySyncStatus = {
  phase: MemorySyncPhase;
  heldReason?: "wiped" | "other_account";
  /** When a pass last finished with both sides the same. */
  lastSyncedAt: number | null;
  /** Files changed on both sides, handed to a background agent to merge. */
  merging: number;
  /** Files the cloud refused (over their size limit), relative to `~/.stella`. */
  refused: string[];
};

export type MemorySyncEraseResult = { ok: true } | { ok: false; error: string };
