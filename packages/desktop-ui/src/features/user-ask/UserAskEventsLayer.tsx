import { useEffect } from "react";
import { refreshUserAsks, useUserAsks } from "./user-ask-store";

export function UserAskEventsLayer() {
  useUserAsks();

  useEffect(() => {
    void refreshUserAsks();
  }, []);

  return null;
}
