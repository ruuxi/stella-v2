/**
 * `map` tool — show the user an interactive map inline in the chat: pinned
 * places and/or a route with directions.
 *
 * The tool takes natural inputs (place names, addresses, "lat,lng" strings)
 * and POSTs them to the stella.sh maps resolve endpoint, which geocodes and
 * routes through Google APIs with a server-side key (zero keys and zero
 * setup on the user's machine — a hard product requirement). The resolved
 * `map-route` artifact lands on the tool_result `details`, where the desktop
 * chat card and the mobile bridge pick it up; the model gets a compact text
 * summary (distance, duration, top places) to speak from.
 *
 * Best-effort by design: resolution failures come back as a clear tool error
 * (the model can answer without a card), never a broken card. The
 * model-visible surface is `map-def.ts` and the resolution `map-resolve.ts`,
 * both shared with the cloud host.
 */

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { MAPS_SITE_URL_ENV } from "@stella/contracts/map-artifact";
import type { ToolDefinition } from "../types.js";
import { forkAbortTimer } from "../effect-runtime.js";
import {
  MAP_TOOL_DESCRIPTION,
  MAP_TOOL_NAME,
  MAP_TOOL_PARAMETERS,
  MAP_TOOL_PROMPT_SNIPPET,
  MAP_TOOL_SEARCH_TERMS,
  MAP_TOOL_WORKING_TEXT,
} from "./map-def.js";
import {
  MAP_RESOLVE_TIMEOUT_MS,
  parseMapToolArgs,
  resolveMapArtifact,
} from "./map-resolve.js";

export type MapToolOptions = {
  /** Override the stella.sh base for self-hosted resolution. */
  siteBaseUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

export const createMapTool = (options: MapToolOptions = {}): ToolDefinition => {
  const resolveBase = () =>
    options.siteBaseUrl ?? process.env[MAPS_SITE_URL_ENV]?.trim() ?? undefined;

  return {
    name: MAP_TOOL_NAME,
    // Chat-surface artifact: only the orchestrator drops map cards into the
    // conversation, mirroring the html/canvas tool.
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    demoted: { searchTerms: MAP_TOOL_SEARCH_TERMS },
    description: MAP_TOOL_DESCRIPTION,
    promptSnippet: MAP_TOOL_PROMPT_SNIPPET,
    workingText: MAP_TOOL_WORKING_TEXT,
    parameters: MAP_TOOL_PARAMETERS,
    execute: async (args, _context, extras) => {
      const parsed = parseMapToolArgs(args);
      if ("error" in parsed) return { error: parsed.error };

      // The controller stays at the fetch seam (composing the caller's
      // cooperative AbortSignal with the resolve deadline); the deadline
      // itself is a bounded fiber canceled in the `finally` below.
      const controller = new AbortController();
      const cancelResolveTimer = forkAbortTimer(MAP_RESOLVE_TIMEOUT_MS, () =>
        controller.abort(),
      );
      const onAbort = () => controller.abort();
      extras?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const outcome = await resolveMapArtifact(parsed.request, {
          ...(resolveBase() ? { siteBaseUrl: resolveBase() } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          signal: controller.signal,
        });
        if (!outcome.ok) return { error: outcome.error };
        return { result: outcome.summary, details: { map: outcome.map } };
      } finally {
        cancelResolveTimer();
        extras?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
};
