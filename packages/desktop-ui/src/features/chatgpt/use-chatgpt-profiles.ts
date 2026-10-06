import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatGptProfileSummary,
  ChatGptProfilesState,
} from "@stella/contracts/chatgpt-siwc-types";

/**
 * This computer's ChatGPT accounts (Sign in with ChatGPT), as Electron main
 * keeps them. Desktop host only: in a browser `available` is false and
 * nothing here runs. Sign-in opens the browser from main and finishes on its
 * loopback listener; `signingIn` covers that wait.
 */
export function useChatGptProfiles() {
  const available =
    typeof window !== "undefined" && Boolean(window.electronAPI?.system?.listChatGptProfiles);
  const [state, setState] = useState<ChatGptProfilesState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const list = window.electronAPI?.system?.listChatGptProfiles;
    if (!list) return;
    try {
      const next = await list();
      if (mounted.current) setState(next);
    } catch {
      // Keep the last list; the next change reloads it.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const unsubscribe = window.electronAPI?.system?.onChatGptProfilesChanged?.(() => {
      void reload();
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [reload]);

  /**
   * Sign in: a new account (dynamic registration), `profileId` again, or
   * with `sharedClientId`, a registration another of the owner's hosts made.
   * Resolves the saved account, or null when the sign-in was cancelled.
   */
  const signIn = useCallback(
    async (options?: {
      profileId?: string;
      sharedClientId?: string;
      enablePlanUsage?: boolean;
    }): Promise<ChatGptProfileSummary | null> => {
      const run = window.electronAPI?.system?.signInChatGpt;
      if (!run) throw new Error("ChatGPT sign-in on this computer needs the Stella desktop app.");
      setSigningIn(true);
      try {
        return await run(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/cancel/iu.test(message)) return null;
        throw error;
      } finally {
        if (mounted.current) setSigningIn(false);
        void reload();
      }
    },
    [reload],
  );

  const cancelSignIn = useCallback(() => {
    void window.electronAPI?.system?.cancelChatGptSignIn?.().catch(() => undefined);
  }, []);

  const act = useCallback(
    async <T,>(action: () => Promise<T> | undefined): Promise<T | undefined> => {
      try {
        return await action();
      } finally {
        void reload();
      }
    },
    [reload],
  );

  const profiles = state?.profiles ?? [];
  const usable = profiles.some(
    (profile) => profile.status === "signed_in" && profile.planUsage,
  );

  return {
    available,
    loaded: state !== null,
    profiles,
    /** A signed-in account with plan usage serves ChatGPT on this computer. */
    usable,
    signingIn,
    signIn,
    cancelSignIn,
    setActive: (profileId: string) =>
      act(() => window.electronAPI?.system?.setActiveChatGptProfile?.(profileId)),
    signOut: (profileId: string) =>
      act(() => window.electronAPI?.system?.signOutChatGptProfile?.(profileId)),
    remove: (profileId: string) =>
      act(() => window.electronAPI?.system?.removeChatGptProfile?.(profileId)),
    reload,
  };
}

export type ChatGptProfiles = ReturnType<typeof useChatGptProfiles>;
