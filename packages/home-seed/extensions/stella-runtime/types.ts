export type NativeConnectorCatalogEntry = {
  id: string;
  name: string;
  connectable: boolean;
};

export type RuntimeLogger = {
  debug(event: string, data?: Record<string, unknown>): void;
};

export type ExtensionRuntime = {
  loadHomeAgents(metadataDir: string | URL): Array<Record<string, unknown>>;
  agentHasCapability(agentType: string, capability: string): boolean;
  wrapSystemReminder(text: string): string;
  wrapInternalSystemReminder(text: string): string;
  createLogger(scope: string): RuntimeLogger;
  getCompactionTriggerTokens(route: unknown): number;
  connectors: {
    match(prompt: string): Promise<NativeConnectorCatalogEntry[]>;
    getConnectionState(
      entry: NativeConnectorCatalogEntry,
    ): Promise<{ connected: boolean }>;
    getDecline(connectorId: string): Promise<unknown>;
    isReminderShown(threadKey: string, key: string): Promise<boolean>;
    recordReminderShown(threadKey: string, key: string): Promise<void>;
  };
  memory: {
    reviewTurnThreshold: number;
    spawnReview(args: Record<string, unknown>): void;
    maybeSpawnDreamRun(args: Record<string, unknown>): Promise<unknown>;
  };
  restartContinuation: {
    reminderCustomType: string;
    enabled(): boolean;
    attach(args: { conversationId: string; runId?: string }): null | {
      state: { reason: string; shutdownAt: number };
      turnCompleted: boolean;
      threads: Array<{ threadId: string }>;
    };
    settle(args: {
      conversationId: string;
      runId?: string;
      succeeded: boolean;
      isUserTurn?: boolean;
    }): void;
    describeCurrentThreadState(record: unknown): { label: string };
    buildReminderText(args: Record<string, unknown>): string;
  };
};

export type ExtensionStore = {
  getAgentRecord?(threadId: string): null | {
    description?: string;
    agentType?: string;
    [key: string]: unknown;
  };
  getMemoryReviewState(conversationId: string): {
    lastReviewedMessageTs?: number;
  };
  dreamInboxStore: {
    recordThreadSummary(args: {
      threadId: string;
      runId: string;
      agentType: string;
      rolloutSummary: string;
    }): void;
  };
};

export type RuntimeRunServices = {
  resolvedLlm?: unknown;
  messagesSnapshot?: unknown[];
  userTurnsSinceMemoryReview?: number;
  orchestratorTokenEstimate?: number;
};

export type HookPayload = {
  agentType: string;
  outcome: "success" | "error" | "interrupted";
  userPrompt?: string;
  conversationId?: string;
  threadKey?: string;
  runId?: string;
  isUserTurn?: boolean;
  staleUserReminderText?: string;
  orchestratorReminderText?: string;
  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
  finalText: string;
  services?: RuntimeRunServices;
};

export type HookResult = {
  prependMessages?: Array<{
    text: string;
    uiVisibility: "hidden";
    messageType: "message";
    customType: string;
  }>;
};

export type HookDefinition = {
  event: "before_user_message" | "agent_end";
  handler(payload: HookPayload): Promise<HookResult | void>;
};

export type ExtensionServices = {
  store: ExtensionStore;
  runtime: ExtensionRuntime;
};

export type ExtensionRegistrationApi = {
  on(event: HookDefinition["event"], handler: HookDefinition["handler"]): void;
  registerAgent(agent: Record<string, unknown>): void;
};

export type ExtensionFactory = (
  api: ExtensionRegistrationApi,
  services: ExtensionServices,
) => void | Promise<void>;
