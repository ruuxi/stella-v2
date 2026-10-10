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

/**
 * Restore a saved selection into the global preferences and let every picker
 * surface (sidebar picker, composer mini picker, mention menu) refresh through
 * the shared change event. Send-time routing reads the same global
 * preferences, so this single write moves both the displayed model and the
 * routed model together.
 */
const applySelection = async (selection) => {
  try {
    await window.electronAPI?.system?.setLocalModelPreferences?.(selection);
    window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
};

/**
 * Per-conversation model-selection memory for the multi-tab chat experience.
 *
 * The engine/provider + underlying model + reasoning-effort selection lives in
 * GLOBAL local preferences, which both the model pickers and the send-time
 * runtime routing read. This hook keeps those global preferences mirrored to
 * the ACTIVE conversation:
 *
 *   - When the selection changes (from any picker), the active conversation's
 *     snapshot is refreshed, so the pick is remembered for that conversation
 *     only — including the engine dimension (Stella / Codex / Claude Code).
 *   - When the user switches tabs or history replaces the current tab, the
 *     leaving conversation's last-known selection is captured synchronously
 *     and the entering conversation's saved selection is restored. A
 *     brand-new chat has no snapshot, so it inherits the current (last-used /
 *     global) selection as its independent starting point.
 *
 * Because the displayed picker and the send-time routing both derive from the
 * same global preferences, and this hook syncs them to the active conversation,
 * a tab's shown model can't diverge from the model its next turn actually
 * routes to. Changing the model in one tab never silently rewrites another
 * conversation's snapshot.
 *
 * Snapshots outlive the open tab: closing a tab or replacing it from history
 * keeps the conversation's pick so a later reopen restores it. Deleted
 * conversations drop their snapshot explicitly.
 */
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

  // Keep the active conversation's snapshot current whenever the selection
  // changes from any surface. Depends only on `enabled`, reading the live
  // conversation id through a ref so it never re-subscribes on tab switches.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const capture = async () => {
      if (restoringRef.current) return;
      const conversationId = activeConversationIdRef.current;
      if (!conversationId) return;
      const preferences = await readPreferences();
      if (cancelled || restoringRef.current || !preferences) return;
      // A tab switch mid-read must not stamp the leaving tab's prefs onto
      // the conversation that just became active.
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

  // On active-conversation change (and on enable): capture the leaving
  // conversation from the last-known selection that still belongs to it,
  // then restore or seed the entering one.
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
