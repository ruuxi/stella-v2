import { useCallback, useEffect, useState } from "react";
import { uiState } from "@/platform/ui-state";
import { useAuthSessionState } from "./use-auth-session-state";
import { useCurrentUser } from "./use-current-user";

const NICKNAME_PREFIX = "stella-nickname:";
const NICKNAME_CHANGED_EVENT = "stella:nickname-changed";
const DEFAULT_NICKNAME = "Account";

const identityKey = (email: string | null | undefined): string | null => {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

export function getStoredNickname(email: string | null | undefined): string {
  const id = identityKey(email);
  if (!id) return DEFAULT_NICKNAME;
  return uiState.getItem(`${NICKNAME_PREFIX}${id}`) ?? DEFAULT_NICKNAME;
}

export function setStoredNickname(
  email: string | null | undefined,
  nickname: string,
): void {
  const id = identityKey(email);
  if (!id) return;
  const trimmed = nickname.trim();
  if (trimmed) {
    uiState.setItem(`${NICKNAME_PREFIX}${id}`, trimmed);
  } else {
    uiState.removeItem(`${NICKNAME_PREFIX}${id}`);
  }
  window.dispatchEvent(new CustomEvent(NICKNAME_CHANGED_EVENT));
}

interface UseNicknameResult {
  nickname: string;
  email: string | undefined;
  hasConnectedAccount: boolean;
  setNickname: (next: string) => void;
}

export function useNickname(): UseNicknameResult {
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { user: sessionUser } = useAuthSessionState();
  const email = convexUser?.email ?? sessionUser?.email ?? undefined;
  const [nickname, setNicknameState] = useState<string>(() =>
    getStoredNickname(email),
  );

  useEffect(() => {
    setNicknameState(getStoredNickname(email));
    const handler = () => setNicknameState(getStoredNickname(email));
    window.addEventListener(NICKNAME_CHANGED_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(NICKNAME_CHANGED_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, [email]);

  const setNickname = useCallback(
    (next: string) => {
      setStoredNickname(email, next);
    },
    [email],
  );

  return { nickname, email, hasConnectedAccount, setNickname };
}
