import { makeFunctionReference } from "convex/server";
import type { CloudSkillHead } from "@stella/contracts/cloud-home-sync";

export type CloudMemoryPreference = {
  ownerGeneration: string;
  memoryEnabled: boolean;
  revision: number;
  updatedAt: number;
};

export type CloudMemoryPreferenceForSubject = CloudMemoryPreference & {
  subject: string;
};

export type SetCloudMemoryEnabledArgs = {
  expectedSubject: string;
  memoryEnabled: boolean;
  expectedOwnerGeneration: string;
  expectedRevision: number;
  requestId: string;
};

export type CloudMemoryWipeStage =
  | "sweeping"
  | "metadata"
  | "releasing"
  | "completed";

export type CloudMemoryImportDisposition =
  | "automatic_allowed"
  | "explicit_required"
  | "explicit_allowed";

export type CloudMemoryWipeJob = {
  operationId: string;
  stage: CloudMemoryWipeStage;
  attempts: number;
  nextRetryAt: number;
  lastErrorCode?: string;
  objectsDeleted: number;
  rowsDeleted: number;
  completedAt?: number;
  updatedAt: number;
};

export type CloudMemoryWipeStatus = {
  subject: string;
  ownerGeneration: string;
  state: "open" | "wiping";
  memoryEpoch: string;
  importDisposition: CloudMemoryImportDisposition;
  lastWipedEpoch?: string;
  job: CloudMemoryWipeJob | null;
};

export type StartCloudMemoryWipeArgs = {
  expectedOwnerGeneration: string;
  expectedMemoryEpoch: string;
  expectedSubject: string;
  requestId: string;
};

export type AuthorizeCloudMemoryReimportArgs = StartCloudMemoryWipeArgs;

export const cloudHomeApi = {
  getCloudRealtimeConfig: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      httpOrigin: string | null;
      socketOrigin: string | null;
      protocol: number;
    }
  >("cloud_apps:getCloudRealtimeConfig"),
  getMyMemoryPreference: makeFunctionReference<
    "query",
    { expectedSubject: string },
    CloudMemoryPreferenceForSubject
  >("cloud_memory:getMyMemoryPreference"),
  setMyMemoryEnabled: makeFunctionReference<
    "mutation",
    SetCloudMemoryEnabledArgs,
    CloudMemoryPreferenceForSubject
  >("cloud_memory:setMyMemoryEnabled"),
  getMyMemoryWipeStatus: makeFunctionReference<
    "query",
    { expectedSubject: string },
    CloudMemoryWipeStatus
  >("cloud_memory_lifecycle:getMyMemoryWipeStatus"),
  startMyMemoryWipe: makeFunctionReference<
    "mutation",
    StartCloudMemoryWipeArgs,
    CloudMemoryWipeStatus
  >("cloud_memory_lifecycle:startMyMemoryWipe"),
  authorizeMyMemoryReimport: makeFunctionReference<
    "mutation",
    AuthorizeCloudMemoryReimportArgs,
    CloudMemoryWipeStatus
  >("cloud_memory_lifecycle:authorizeMyMemoryReimport"),
  // The only cloud skill read the device needs: mirror heads to diff its
  // canonical root against. There is no cloud-side skill write or edit call.
  listMySkillHeads: makeFunctionReference<
    "query",
    { clientScope: string },
    CloudSkillHead[]
  >("cloud_skills:listMySkillHeads"),
} as const;
