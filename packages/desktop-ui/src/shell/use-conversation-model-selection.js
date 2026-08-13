import { useEffect, useRef } from "react";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { conversationModelSelections, modelSelectionsEqual, pickModelSelection, } from "@/features/chat/services/conversation-model-selection";

const PREFERENCES_CHANGED_EVENT = "stella:local-model-preferences-changed";

const readPreferences = async () => {
  try {
    return ((await window.electronAPI?.system?.getLocalModelPreferences?.()) ??
        null);
  }
  catch {
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
  }
  catch {
    return false;
  }
};

const isConversationOpen = (conversationId) => conversationTabs
    .getSnapshot()
    .tabs.some((tab) => tab.conversationId === conversationId);

/**
 * Per-tab (per-conversation) model-selection memory for the multi-tab
 * (direct / orchestrator-off) chat experience.
 *
 * The engine/provider + underlying model + reasoning-effort selection lives in
 * GLOBAL local preferences, which both the model pickers and the send-time
 * runtime routing read. This hook keeps those global preferences mirrored to
 * the ACTIVE tab:
 *
 *   - When the selection changes (from any picker), the active tab's snapshot
 *     is refreshed, so the pick is remembered for that tab only.
 *   - When the user switches tabs, the leaving tab's selection is captured and
 *     the entering tab's saved selection is restored into the global
 *     preferences. A brand-new tab has no snapshot, so it inherits the current
 *     (last-used) selection as its independent starting point without any
 *     rewrite — and is recorded from then on.
 *
 * Because the displayed picker and the send-time routing both derive from the
 * same global preferences, and this hook syncs them to the active tab, a tab's
 * shown model can't diverge from the model its next turn actually routes to.
 *
 * A no-op in orchestrated single-chat mode (`enabled === false`), where there
 * are no tabs and the global selection is the only selection.
 */
export function useConversationModelSelection({ activeConversationId, enabled, }) {
  const previousConversationIdRef = useRef(null);
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  // Keep the active tab's snapshot current whenever the selection changes from
  // any surface. Depends only on `enabled`, reading the live conversation id
  // through a ref so it never re-subscribes on tab switches.
  useEffect(() => {
    if (!enabled)
      return undefined;
    let cancelled = false;
    const capture = async () => {
      const conversationId = activeConversationIdRef.current;
      if (!conversationId)
        return;
      const preferences = await readPreferences();
      if (cancelled || !preferences)
        return;
      const selection = pickModelSelection(preferences);
      if (selection)
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

  // On active-conversation change (and on enable): capture the leaving tab,
  // then restore or seed the entering tab.
  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    previousConversationIdRef.current = activeConversationId;
    if (!enabled)
      return undefined;
    let cancelled = false;
    void (async () => {
      const preferences = await readPreferences();
      if (cancelled || !preferences)
        return;
      const currentSelection = pickModelSelection(preferences);
      if (!currentSelection)
        return;
      const nextConversationId = activeConversationId;
      // The global preferences still reflect the LEAVING tab here (nothing has
      // been restored yet), so capture them as that tab's latest snapshot.
      if (previousConversationId &&
        previousConversationId !== nextConversationId &&
        isConversationOpen(previousConversationId)) {
        conversationModelSelections.set(previousConversationId, currentSelection);
      }
      if (!nextConversationId)
        return;
      const saved = conversationModelSelections.get(nextConversationId);
      if (saved) {
        // Restore the tab's own selection. Skipped when it already matches to
        // avoid a redundant preference write + broadcast. The cancelled
        // recheck ensures a tab switch that lands mid-restore wins the final
        // preference write, so the displayed model can't be left pointing at a
        // superseded tab's pick.
        if (!cancelled && !modelSelectionsEqual(saved, currentSelection)) {
          await applySelection(saved);
        }
      }
      else {
        // New / never-recorded tab: adopt the inherited last-used selection as
        // its independent starting point without rewriting preferences.
        conversationModelSelections.set(nextConversationId, currentSelection);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, activeConversationId]);

  // Drop snapshots for tabs the user has closed, mirroring the composer /
  // scroll per-tab memory cleanup.
  useEffect(() => {
    if (!enabled)
      return undefined;
    const prune = () => {
      const openConversationIds = new Set(conversationTabs.getSnapshot().tabs.map((tab) => tab.conversationId));
      conversationModelSelections.pruneToOpenConversations(openConversationIds);
    };
    prune();
    return conversationTabs.subscribe(prune);
  }, [enabled]);
}
