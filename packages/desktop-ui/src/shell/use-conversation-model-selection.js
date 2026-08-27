import { useEffect, useRef } from "react";
import {
  conversationModelSelections,
  modelSelectionsEqual,
  pickModelSelection,
} from "@/features/chat/services/conversation-model-selection";

const PREFERENCES_CHANGED_EVENT = "stella:local-model-preferences-changed";

const readPreferences = async () => {
  try {
    return (
      (await window.electronAPI?.system?.getLocalModelPreferences?.()) ?? null
    );
  } catch {
    return null;
  }
};

const applySelection = async (selection) => {
  try {
    await window.electronAPI?.system?.setLocalModelPreferences?.(selection);
    window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
};

export function useConversationModelSelection({
  activeConversationId,
  enabled,
}) {
  const previousConversationIdRef = useRef(null);
  const activeConversationIdRef = useRef(activeConversationId);
  const lastKnownSelectionRef = useRef(null);
  const lastKnownConversationIdRef = useRef(null);
  const restoringRef = useRef(false);
  const restoreGenerationRef = useRef(0);
  activeConversationIdRef.current = activeConversationId;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const capture = async () => {
      if (restoringRef.current) return;
      const conversationId = activeConversationIdRef.current;
      if (!conversationId) return;
      const preferences = await readPreferences();
      if (cancelled || restoringRef.current || !preferences) return;

      if (activeConversationIdRef.current !== conversationId) return;
      const selection = pickModelSelection(preferences);
      if (!selection) return;
      lastKnownSelectionRef.current = selection;
      lastKnownConversationIdRef.current = conversationId;
      conversationModelSelections.set(conversationId, selection);
    };
    const handleChanged = () => {
      void capture();
    };
    window.addEventListener(PREFERENCES_CHANGED_EVENT, handleChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, handleChanged);
    };
  }, [enabled]);

  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    previousConversationIdRef.current = activeConversationId;
    if (!enabled) return undefined;

    if (
      previousConversationId &&
      previousConversationId !== activeConversationId &&
      lastKnownSelectionRef.current &&
      lastKnownConversationIdRef.current === previousConversationId
    ) {
      conversationModelSelections.set(
        previousConversationId,
        lastKnownSelectionRef.current,
      );
    }

    const generation = ++restoreGenerationRef.current;
    restoringRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (!activeConversationId) return;
        const saved = conversationModelSelections.get(activeConversationId);
        if (saved) {
          if (
            !cancelled &&
            !modelSelectionsEqual(saved, lastKnownSelectionRef.current)
          ) {
            const applied = await applySelection(saved);
            if (
              applied &&
              !cancelled &&
              generation === restoreGenerationRef.current
            ) {
              lastKnownSelectionRef.current = saved;
              lastKnownConversationIdRef.current = activeConversationId;
            }
          } else if (!cancelled) {
            lastKnownConversationIdRef.current = activeConversationId;
          }
          return;
        }

        const preferences = await readPreferences();
        if (cancelled || generation !== restoreGenerationRef.current) return;
        if (!preferences) return;
        const currentSelection = pickModelSelection(preferences);
        if (!currentSelection) return;
        lastKnownSelectionRef.current = currentSelection;
        lastKnownConversationIdRef.current = activeConversationId;
        conversationModelSelections.set(activeConversationId, currentSelection);
      } finally {
        if (generation === restoreGenerationRef.current) {
          restoringRef.current = false;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, activeConversationId]);
}
