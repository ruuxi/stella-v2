import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Desktop bridge connection state surfaced in the top bar (computer chat). */
export type DesktopConnection = "connected" | "connecting" | "disconnected";

type TopBarStatusContextValue = {
  /** Set the desktop connection status, or `null` to hide the indicator. */
  setConnection: Dispatch<SetStateAction<DesktopConnection | null>>;
};

const TopBarStatusContext = createContext<TopBarStatusContextValue>({
  setConnection: () => {},
});

export const TopBarStatusProvider = TopBarStatusContext.Provider;

export function useTopBarStatus() {
  return useContext(TopBarStatusContext);
}
