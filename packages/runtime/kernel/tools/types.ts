import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import type {
  AgentModelConfigSnapshot,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "@stella/contracts/agent-engine";
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
} from "@stella/contracts/scheduling";
import type {
  RuntimeThreadLiveState,
  RuntimeThreadRecord,
} from "../runtime-threads.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { RecallLookupResult } from "../agent-runtime/recall-run-cache.js";

export type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
  runId?: string;
  rootRunId?: string;
  agentType?: string;
  stellaAppDir?: string;
  stellaDataDir?: string;
  toolWorkspaceRoot?: string;
  storageMode?: "cloud" | "local";
  agentId?: string;

  parentAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  allowedToolNames?: string[];

  deferImageDeliveryAck?: boolean;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
};

export type ToolResult = {
  result?: unknown;
  details?: unknown;
  error?: string;

  modelOutputTokens?: number;

};

export type ToolUpdateCallback = (update: ToolResult) => void;

export type ToolHandlerExtras = {
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
};

export type ToolMetadata = {
  name: string;
  label?: string;
  workingText?: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  approval?: unknown;
  sideEffects?: unknown;
  reversible?: boolean;
  annotations?: Record<string, unknown>;

  demoted?: {
    searchTerms?: readonly string[];
    requiredConnectorProvider?: string;
  };

  agentTypes?: readonly string[];
};

export type ShellRecord = {
  id: string;
  command: string;
  cwd: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  completedAt: number | null;
  kill: () => void;
};

export type AgentRecord = {
  id: string;
  description: string;
  status: "running" | "completed" | "error";
  result?: string;
  error?: string;
  startedAt: number;
  completedAt: number | null;
};

export type AgentToolRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType: string;

  model?: string;

  spawnEngine?: SpawnEngineSelection;

  spawnReasoningEffort?: SpawnReasoningEffort;

  modelConfigSnapshot?: AgentModelConfigSnapshot;
  toolWorkspaceRoot?: string;
  rootRunId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  threadId?: string;
  storageMode: "local";
};

export type AgentToolSnapshot = {
  id: string;
  status: TaskLifecycleStatus;
  description: string;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  recentActivity?: string[];

  lastActivityAt?: number;

  activeToolCount?: number;
  messages?: Array<{
    from: "orchestrator" | "subagent";
    text: string;
    timestamp: number;
  }>;
};

export type AgentThreadStatusMessage = {
  timestamp: number;
  role: string;
  content: string;
  payload?: PersistedRuntimeThreadPayload;
};

export type AgentThreadStatusRead = {

  status: RuntimeThreadLiveState;

  statusLabel: string;

  agentStatus?: TaskLifecycleStatus | string;
  description?: string;

  engine?: string;

  lastActiveAt?: number;
  messages: AgentThreadStatusMessage[];
};

export type AgentToolApi = {

  readAgentThreadStatus?: (
    threadId: string,
  ) => Promise<AgentThreadStatusRead | null>;
  createAgent: (request: AgentToolRequest) => Promise<{
    threadId: string;
    activeThreads?: RuntimeThreadRecord[];
  }>;
  getAgent: (threadId: string) => Promise<AgentToolSnapshot | null>;
  cancelAgent: (
    threadId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
  sendAgentMessage?: (
    threadId: string,
    message: string,
    from: "orchestrator" | "subagent",
    options?: {
      rootRunId?: string;

      parentAgentId?: string;

      deliveryKind?: "child-report" | "external-input";
      modelConfigSnapshot?: AgentModelConfigSnapshot;
    },
  ) => Promise<{ delivered: boolean; reason?: string }>;
  drainAgentMessages?: (
    threadId: string,
    recipient: "orchestrator" | "subagent",
  ) => Promise<string[]>;
};

export type ToolHostOptions = {
  stellaAppDir: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  cliBridgeSocketPath?: string;
  agentApi?: AgentToolApi;

  validateSpawnModel?: (modelName: string) => void;
  validateSpawnModelWithMetadata?: (
    modelName: string,
    reasoningEffort?: SpawnReasoningEffort,
  ) => Promise<void>;

  captureSpawnModelConfig?: (args: {
    agentType: string;
    spawnEngine: SpawnEngineSelection;

    useConfiguredEngine?: boolean;
    model?: string;
    spawnReasoningEffort?: SpawnReasoningEffort;
  }) => Promise<AgentModelConfigSnapshot | undefined>;
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  extensionTools?: import("../extensions/types.js").ToolDefinition[];

  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{
    text: string;
    results?: Array<{ title: string; url: string; snippet: string }>;
  }>;

  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;

  queryConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  actionConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    runId?: string;
    prompt: string;
    memorySearchTerms?: string[];
    agentType?: string;
    modelConfigSnapshot?: AgentModelConfigSnapshot;
    signal?: AbortSignal;
  }) => Promise<RecallLookupResult>;
  stellaDataDir?: string;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;

  requestBrowserExtensionConnect?: import("./browser-extension-offer.js").BrowserExtensionConnectRequester;
  requestComputerUseAppApproval?: (payload: {
    bundleIdentifier: string;
    displayName: string;
    appPath?: string;
    allowPersistentApproval: boolean;
    risk?: string;
    warningSubtitle?: string;
  }) => Promise<
    | { decision: "approved"; scope: "session" | "persistent" }
    | { decision: "declined"; scope: "none" }
  >;

  requestConnectorConnection?: import("./defs/connector-status.js").ConnectorConnectionRequester;

  requestLinkWalletConnection?: import("./defs/link-wallet.js").LinkWalletConnectionRequester;
};

export type FashionShopProduct = {
  productId: string;
  variantId: string;
  title: string;
  vendor?: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  merchantOrigin: string;
};

export type FashionShopProductDetail = FashionShopProduct & {
  variants?: Array<{
    variantId: string;
    title?: string;
    price?: number;
    currency?: string;
    available?: boolean;
    options?: Record<string, string>;
  }>;
};

export type FashionOutfitProductInput = {
  slot: string;
  productId: string;
  variantId: string;
  title: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  vendor?: string;
  merchantOrigin: string;
};

export type FashionContextSummary = {
  profile: {
    gender?: string;
    sizes?: Record<string, string>;
    stylePreferences?: string;
  } | null;
  recentLikes: Array<{ productId: string; title: string; vendor?: string }>;
  cart: Array<{ productId: string; title: string; quantity: number }>;
  recentOutfitProductIds: string[];
};

export type FashionCheckoutSessionResult = {
  checkoutId: string;
  status: string;
  continueUrl?: string;
  merchantOrigin: string;
  mcpEndpoint: string;
  usingMcp: boolean;
  cartUrl?: string;
};

export type FashionToolApi = {
  getOrchestratorContext: () => Promise<FashionContextSummary>;
  searchProducts: (args: {
    query: string;
    context?: string;
    limit?: number;
    savedCatalog?: string;
  }) => Promise<FashionShopProduct[]>;
  getProductDetails: (args: {
    productId: string;
  }) => Promise<FashionShopProductDetail | null>;
  registerOutfit: (args: {
    batchId: string;
    ordinal: number;
    themeLabel: string;
    themeDescription?: string;
    stylePrompt?: string;
    products: FashionOutfitProductInput[];
    tryOnPrompt?: string;
  }) => Promise<string>;
  markOutfitReady: (args: {
    outfitId: string;
    tryOnImagePath?: string;
    tryOnImageUrl?: string;
  }) => Promise<void>;
  markOutfitFailed: (args: {
    outfitId: string;
    errorMessage: string;
  }) => Promise<void>;
  createCheckout: (args: {
    merchantOrigin: string;
    lines: Array<{ variantId: string; quantity: number }>;
  }) => Promise<FashionCheckoutSessionResult>;
  cancelCheckout: (args: {
    mcpEndpoint: string;
    checkoutId: string;
  }) => Promise<{ checkoutId: string; status: string }>;
};

export type ScheduleToolApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  addCronJob: (input: LocalCronJobCreateInput) => Promise<LocalCronJobRecord>;
  updateCronJob: (
    jobId: string,
    patch: LocalCronJobUpdatePatch,
  ) => Promise<LocalCronJobRecord | null>;
  removeCronJob: (jobId: string) => Promise<boolean>;
  runCronJob: (jobId: string) => Promise<LocalCronJobRecord | null>;
  getHeartbeatConfig: (
    conversationId: string,
  ) => Promise<LocalHeartbeatConfigRecord | null>;
  upsertHeartbeat: (
    input: LocalHeartbeatUpsertInput,
  ) => Promise<LocalHeartbeatConfigRecord>;
  runHeartbeat: (
    conversationId: string,
  ) => Promise<LocalHeartbeatConfigRecord | null>;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
) => Promise<ToolResult>;

export type ToolDefinition = {

  name: string;

  label?: string;

  workingText?: string;

  description: string;

  parameters: Record<string, unknown>;

  outputSchema?: Record<string, unknown>;

  resultSchema?: Record<string, unknown>;

  approval?: unknown;

  sideEffects?: unknown;

  reversible?: boolean;

  annotations?: Record<string, unknown>;

  agentTypes?: readonly string[];

  promptSnippet?: string;

  demoted?: {
    searchTerms?: readonly string[];
    requiredConnectorProvider?: string;
  };

  execute: ToolHandler;
};
