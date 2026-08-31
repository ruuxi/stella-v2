import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import type { EventRecord } from "./event-transforms";

export declare const deriveTurnInlineImagePayloads: (
  toolEvents: EventRecord[],
) => DisplayPayload[];

export declare const buildPayloadFromBarePath: (
  filePath: string,
  createdAt: number,
  options?: {
    developerResourcesEnabled?: boolean;
    patch?: string;
  },
) => DisplayPayload | null;
export declare const extractMarkdownLinkPaths: (
  assistantText: string,
) => string[];
export declare const collectTurnSourceDiffPayloads: (
  toolEvents: EventRecord[],
  options?: { developerResourcesEnabled?: boolean; assistantText?: string },
) => DisplayPayload[];
export declare const deriveTurnResource: (
  toolEvents: EventRecord[],
  assistantText?: string,
  turnCwd?: string,
  options?: { developerResourcesEnabled?: boolean },
) => DisplayPayload | null;
