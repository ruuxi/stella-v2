export const CARPLAY_APPEARANCE_GRACE_MS = 20_000;

export type DeferColorSchemeArgs = {

  connected: boolean;

  persistedConnected: boolean;

  msSinceJsStart: number;
  graceMs?: number;
};

export function shouldDeferColorScheme({
  connected,
  persistedConnected,
  msSinceJsStart,
  graceMs = CARPLAY_APPEARANCE_GRACE_MS,
}: DeferColorSchemeArgs): boolean {
  if (connected) return true;

  return persistedConnected && msSinceJsStart < graceMs;
}
