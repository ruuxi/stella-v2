import { useNetworkState } from "expo-network";

export function useIsOffline(): boolean {
  const state = useNetworkState();
  return (
    state.isConnected === false || state.isInternetReachable === false
  );
}
