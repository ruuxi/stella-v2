import type { RuntimePromptMessage } from "@stella/contracts/protocol";

export type BeforeUserMessagePayload = {
  agentType: string;
  userPrompt: string;
  staleUserReminderText?: string;
  orchestratorReminderText?: string;
  /**
   * Pre-rendered hidden reminder text describing a change in the user's
   * routing surface (desktop ⇄ connector / connector ⇄ different
   * connector). Computed in `prepareOrchestratorRun`; undefined when
   * the surface didn't change since the previous user message. Hooks
   * inject it as a hidden system reminder so the orchestrator only sees
   * the format guidance on the transition turn.
   */
  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
};

export type BeforeUserMessageHookResult = {
  /**
   * Messages prepended to the prompt-message array in registration
   * order. Each hook's prepends land before any bundled startup
   * messages and before the user's typed prompt. Use `display: false`
   * (or `uiVisibility: "hidden"`) to keep the message out of the
   * user-facing chat surface.
   */
  prependMessages?: RuntimePromptMessage[];
  /**
   * Messages appended just before the user's typed prompt. Useful for
   * context that should land close to the user's text without sitting
   * inside the bundled startup section.
   */
  appendMessages?: RuntimePromptMessage[];
};

/** Required bundled hooks fail the turn on error. Optional extensions use HookEmitter's isolation. */
export const runBeforeUserMessageHooks = async (
  hooks: readonly {
    event: "before_user_message";
    handler(
      payload: BeforeUserMessagePayload,
    ): Promise<BeforeUserMessageHookResult | void>;
  }[],
  payload: BeforeUserMessagePayload,
): Promise<Array<BeforeUserMessageHookResult | void>> => {
  const results: Array<BeforeUserMessageHookResult | void> = [];
  for (const hook of hooks) results.push(await hook.handler(payload));
  return results;
};
