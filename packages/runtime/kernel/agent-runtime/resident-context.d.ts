import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";

type CustomMessage = {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
};
type HistoryEntry = { role: string; customMessage?: CustomMessage };
export type ResidentContext = {
  personality?: string;
  coreMemory?: string;
  userProfile?: string;
  skillsCatalog?: string;
  executionContext?: ExecutionContextSnapshot;
  threadHistory?: HistoryEntry[];
};
type ResidentBlock = {
  id: string;
  customType: string;
  docPath?: string;
  resolve: (context: ResidentContext) => string | undefined;
};
type ResidentFold = { docs: Array<{ customType: string; text: string }> };

export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE: "bootstrap.startup_doc";
export const BOOTSTRAP_SKILLS_CUSTOM_TYPE: "bootstrap.skills_catalog";
export const CONTEXT_DELTA_CUSTOM_TYPE_PREFIX: "runtime.context_delta.";
export const RESIDENT_FOLD_ENTRY_ID_MARKER: "::resident:";
export const PINNED_INSTRUCTION_ENTRY_ID_MARKER: "::pinned-instruction";
export const LIFE_PERSONALITY_DISPLAY_PATH: "~/.stella/PERSONALITY.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH: "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH: "~/.stella/memories/profile.md";
export const RETIRED_MEMORY_DISPLAY_PATHS: string[];
export const RESIDENT_BLOCKS: ResidentBlock[];
export function renderResidentBlockText(
  block: ResidentBlock,
  context: ResidentContext,
): string | undefined;
export function customMessageContentText(
  content: CustomMessage["content"],
): string;
export function isRetiredMemoryCustomMessage(
  message?: CustomMessage | null,
): boolean;
export function buildResidentContextMessages(
  context: ResidentContext,
): RuntimePromptMessage[];
export function parseStartupDocPath(text: string): string | null;
export function residentIdentityForCustomMessage(
  message?: CustomMessage | null,
): string | null;
export function buildResidentFold(args: {
  messages: readonly HistoryEntry[];
  stellaDataDir?: string;
  refreshMemoryDocsFromDisk?: boolean;
}): ResidentFold | null;
export function parseResidentFold(
  details: unknown,
): (ResidentFold & { identities: Set<string> }) | null;
