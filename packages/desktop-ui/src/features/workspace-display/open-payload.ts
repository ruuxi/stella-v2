import type { DisplayTabPayload } from "@stella/contracts/desktop/display-payload";
import { isFilesPayload } from "./payload-kind";
import { sidebarSections } from "./sidebar-sections";
import { displayTabs } from "./tab-store";
import {
  pushAndOpenSourceDiffBatch,
  type SourceDiffBatch,
} from "./source-diff-batches";
import type { DisplayTabSpec, OpenTabOptions } from "./types";

type WorkspaceDisplayPayloadAdapter = {
  payloadToTabSpec: (payload: DisplayTabPayload) => DisplayTabSpec;
  createSourceDiffTabSpec: () => DisplayTabSpec;
  createAgentThreadTabSpec: (args: AgentThreadTabArgs) => DisplayTabSpec;
};

export type AgentThreadTabArgs = {
  threadId: string;
  conversationId: string;
  agentType: string;
  title: string;

  source?: "stella" | "claude-native";
  readOnly?: boolean;
  parentAgentId?: string;
};

let adapter: WorkspaceDisplayPayloadAdapter | null = null;

export const registerWorkspaceDisplayPayloadAdapter = (
  nextAdapter: WorkspaceDisplayPayloadAdapter,
): void => {
  adapter = nextAdapter;
};

const getAdapter = (): WorkspaceDisplayPayloadAdapter => {
  if (!adapter) {
    throw new Error(
      "Workspace display payload adapter has not been registered.",
    );
  }
  return adapter;
};

export const openDisplayPayloadTab = (
  payload: DisplayTabPayload,
  opts?: OpenTabOptions,
): void => {
  const spec = getAdapter().payloadToTabSpec(payload);
  displayTabs.openTab(spec, opts);
  if (isFilesPayload(payload) && (opts?.activate ?? true)) {
    sidebarSections.openLocation("files", spec.id);
  }
};

export const openAgentThreadTab = (args: AgentThreadTabArgs): void => {
  const spec = getAdapter().createAgentThreadTabSpec(args);
  displayTabs.openTab(spec);
  sidebarSections.openLocation("files", spec.id);
};

export const openSourceDiffBatch = (batch: SourceDiffBatch): void => {
  pushAndOpenSourceDiffBatch(batch, getAdapter().createSourceDiffTabSpec());
};
