import { useNetworkState } from "expo-network";

/**
 * True only when the device is definitely offline. Unknown states (cold
 * start, simulator quirks) stay `false` so we never flash a false alarm.
 */
export function useIsOffline(): boolean {
  const state = useNetworkState();
  return (
    state.isConnected === false || state.isInternetReachable === false
  );
}
