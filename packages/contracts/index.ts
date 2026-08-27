export type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ChatContextFile = {
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string;

  path?: string;
};

export type ChatAppSelection = {
  label: string;
  snapshot: string;
  bounds: WindowBounds;
  surface?: string;
  anchor?: {
    kind: string;
    label?: string;
    tag?: string;
    role?: string;
    path?: string;
  };
  source?: {
    filePath?: string;
    lineNumber?: number;
    componentName?: string;
  };
  stack?: string;
};

export type ChatContext = {
  window: {
    title: string;
    app: string;
    bounds: WindowBounds;
  } | null;
  activity?: {
    id: string;
    label: string;
    agentType: string;
    status: string;
    runId?: string;
    anchorTurnId?: string;
    startedAtMs?: number;
    completedAtMs?: number;
    lastUpdatedAtMs?: number;
  } | null;

  appSelection?: ChatAppSelection | null;

  appSelections?: ChatAppSelection[];
  windowContextEnabled?: boolean;
  windowAxTree?: string | null;
  browserUrl?: string | null;
  selectedText?: string | null;
  regionScreenshots?: {
    dataUrl: string;
    width: number;
    height: number;

    previewUrl?: string;

    filePath?: string;
  }[];
  files?: ChatContextFile[];

  pastedTexts?: string[];
  capturePending?: boolean;
  windowScreenshot?: {
    dataUrl: string;
    width: number;
    height: number;
  } | null;
};

export type ChatContextUpdate = {
  context: ChatContext | null;
  version: number;
};

export type BrowserType =
  | "chrome"
  | "edge"
  | "brave"
  | "arc"
  | "opera"
  | "vivaldi";

export type DomainVisit = {
  domain: string;
  visits: number;
};

export type DomainDetail = {
  title: string;
  url: string;
  visitCount: number;
};

export type ClusterKeyword = {
  keyword: string;
  score: number;
  lastVisit: number;
};

export type SearchQuery = {
  query: string;
  count: number;
};

export type BrowserData = {
  browser: BrowserType | null;
  clusterDomains: string[];
  recentDomains: DomainVisit[];
  allTimeDomains: DomainVisit[];
  domainDetails: Record<string, DomainDetail[]>;
  clusterKeywords: ClusterKeyword[];
  searchQueries?: SearchQuery[];
};

export type BrowserDataResult = {
  data: BrowserData | null;
  formatted: string | null;
  error?: string;
};

export type PreferredBrowserProfile = {
  browser: BrowserType | null;
  profile: string | null;
};

export type BrowserProfile = {
  id: string;
  name: string;
};

export type DevProject = {
  name: string;
  path: string;
  lastActivity: number;

  tech?: string[];
};

export type CommandFrequency = {
  command: string;
  count: number;
};

export type ShellAnalysis = {
  topCommands: CommandFrequency[];
  projectPaths: string[];
  toolsUsed: string[];
};

export type DiscoveredApp = {
  name: string;
  executablePath: string;
  source: "running" | "recent";
  lastUsed?: number;
};

export type AllUserSignals = {
  browser: BrowserData;
  devProjects: DevProject[];
  shell: ShellAnalysis;
};

export type AllUserSignalsResult = {
  data: AllUserSignals | null;
  formatted: string | null;
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null;
  error?: string;
};

export type AgentHealth =
  | {
      ready: true;
      runnerVersion?: string;
      engine?: string;
    }
  | {
      ready: false;
      reason?: string;
      engine?: string;
    };

export type LocalLlmCredentialSummary = {
  provider: string;
  label: string;
  status: "active";
  updatedAt: number;
};

export type LocalCronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type LocalCronPayload =
  | { kind: "notify"; text: string }
  | { kind: "script"; scriptPath: string }
  | { kind: "agent"; prompt: string; agentType?: string };

export type LocalHeartbeatActiveHours = {
  start: string;
  end: string;
  timezone?: string;
};

export type LocalCronJobRecord = {
  id: string;
  conversationId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: LocalCronSchedule;
  payload: LocalCronPayload;
  deliver?: boolean;
  deleteAfterRun?: boolean;
  nextRunAtMs: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;
  lastOutputPreview?: string;
  createdAt: number;
  updatedAt: number;
};

export type LocalHeartbeatConfigRecord = {
  id: string;
  conversationId: string;
  enabled: boolean;
  intervalMs: number;
  prompt?: string;
  checklist?: string;
  ackMaxChars?: number;
  deliver?: boolean;
  agentType?: string;
  activeHours?: LocalHeartbeatActiveHours;
  targetDeviceId?: string;
  runningAtMs?: number;
  lastRunAtMs?: number;
  nextRunAtMs: number;
  lastStatus?: string;
  lastError?: string;
  lastSentText?: string;
  lastSentAtMs?: number;
  createdAt: number;
  updatedAt: number;
};

export type ScheduledConversationEvent = {
  _id: string;
  conversationId: string;
  timestamp: number;
  type: "assistant_message";
  payload: Record<string, unknown>;
};

export type LocalCronJobUpdatePatch = {
  name?: string;
  schedule?: LocalCronSchedule;
  payload?: LocalCronPayload;
  conversationId?: string;
  description?: string;
  enabled?: boolean;
  deliver?: boolean;
  deleteAfterRun?: boolean;
};

export type LocalHeartbeatUpsertInput = {
  conversationId: string;
  enabled?: boolean;
  intervalMs?: number;
  prompt?: string;
  checklist?: string;
  ackMaxChars?: number;
  deliver?: boolean;
  agentType?: string;
  activeHours?: LocalHeartbeatActiveHours;
  targetDeviceId?: string;
};

export type VoiceRuntimeSnapshot = {
  sessionState: "idle" | "connecting" | "connected" | "error" | "disconnecting";
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

export type {
  UserAppProjectDescriptor,
  UserAppProjectListResult,
  UserAppProjectMeta,
  UserAppProjectStartResult,
  UserAppProjectStatus,
  UserAppProjectStopResult,
} from "./user-app-projects.js";
