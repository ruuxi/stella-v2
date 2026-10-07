import type { TSchema } from "@sinclair/typebox";
import {
  MAP_TOOL_DESCRIPTION,
  MAP_TOOL_NAME,
  MAP_TOOL_PARAMETERS,
  MAP_TOOL_REPLAY,
  MAP_TOOL_SEARCH_TERMS,
  MAP_TOOL_WORKING_TEXT,
} from "@stella/runtime/kernel/tools/defs/map-def.js";
import {
  MAP_RESOLVE_TIMEOUT_MS,
  mapOutcomeFromResolver,
  parseMapToolArgs,
} from "@stella/runtime/kernel/tools/defs/map-resolve.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import { ownerMapsAdmission } from "./maps/admission.js";
import { resolveMapRequest } from "./maps/google-resolve.js";

export type CloudMapToolOptions = Readonly<{
  apiKey: string | undefined;
  ownerInternal: (name: string, args: unknown) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}>;

export const createCloudMapTool = (
  options: CloudMapToolOptions,
): CloudCodeSourceAgentTool => ({
  name: MAP_TOOL_NAME,
  replay: MAP_TOOL_REPLAY,
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
    const { request } = parsed;
    const result = await resolveMapRequest(
      {
        places: request.places,
        ...(request.origin ? { origin: request.origin, destination: request.destination } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.title ? { title: request.title } : {}),
      },
      options.apiKey,
      {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        admit: ownerMapsAdmission(options.ownerInternal),
      },
    );
    const outcome = mapOutcomeFromResolver(result.status, result.body);
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
