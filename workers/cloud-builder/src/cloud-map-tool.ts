/**
 * `map` for the cloud orchestrator — the device tool's exact model-visible
 * surface (`defs/map-def.ts`) over the shared resolver (`defs/map-resolve.ts`).
 * Pure HTTP against the stella.sh maps endpoint, so nothing about it is
 * device-specific: the resolved `map-route` artifact lands on the tool
 * result's `details.map` and the chat renders the same card on every client.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  MAP_TOOL_DESCRIPTION,
  MAP_TOOL_NAME,
  MAP_TOOL_PARAMETERS,
  MAP_TOOL_SEARCH_TERMS,
  MAP_TOOL_WORKING_TEXT,
} from "@stella/runtime/kernel/tools/defs/map-def.js";
import {
  MAP_RESOLVE_TIMEOUT_MS,
  parseMapToolArgs,
  resolveMapArtifact,
} from "@stella/runtime/kernel/tools/defs/map-resolve.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";

export type CloudMapToolOptions = Readonly<{
  siteBaseUrl?: string;
  fetchImpl?: typeof fetch;
}>;

export const createCloudMapTool = (
  options: CloudMapToolOptions = {},
): CloudCodeSourceAgentTool => ({
  name: MAP_TOOL_NAME,
  label: "Map",
  workingText: MAP_TOOL_WORKING_TEXT,
  description: MAP_TOOL_DESCRIPTION,
  parameters: MAP_TOOL_PARAMETERS as unknown as TSchema,
  demoted: { searchTerms: MAP_TOOL_SEARCH_TERMS },
  execute: async (_toolCallId, params, signal) => {
    const parsed = parseMapToolArgs((params ?? {}) as Record<string, unknown>);
    if ("error" in parsed) {
      return {
        content: [{ type: "text", text: parsed.error }],
        details: null,
        isError: true,
      };
    }
    const timeout = AbortSignal.timeout(MAP_RESOLVE_TIMEOUT_MS);
    const outcome = await resolveMapArtifact(parsed.request, {
      ...(options.siteBaseUrl ? { siteBaseUrl: options.siteBaseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!outcome.ok) {
      return {
        content: [{ type: "text", text: outcome.error }],
        details: null,
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: outcome.summary }],
      details: { map: outcome.map },
    };
  },
});
