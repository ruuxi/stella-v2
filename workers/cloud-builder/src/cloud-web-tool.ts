/**
 * `web` in the cloud: the desktop tool's exact surface (`defs/web-def.ts`)
 * and fetch pipeline (`web-fetch-core`, with per-redirect-hop SSRF
 * re-validation). workerd has no resolver hook, so the guard runs
 * literal-only here; Cloudflare's own egress policy backstops DNS-rebinding
 * names. Search is the owner's `search.web`.
 */

import type { TSchema } from "@sinclair/typebox";
import type { WebSearchResult } from "@stella/contracts/backend/search";
import {
  WEB_TOOL_DESCRIPTION,
  WEB_TOOL_NAME,
  WEB_TOOL_PARAMETERS,
  WEB_TOOL_REPLAY,
} from "@stella/runtime/kernel/tools/defs/web-def.js";
import {
  containsSecretLikeToken,
  sanitizeToolVisibleText,
} from "@stella/runtime/kernel/tools/safety.js";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { fetchReadableText } from "@stella/runtime/kernel/tools/web-fetch-core.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import type { OwnerInternalCall } from "./owner-store/registry.js";

export const createCloudWebTool = (context: {
  ownerInternal: OwnerInternalCall;
}): CloudCodeSourceAgentTool => ({
  name: WEB_TOOL_NAME,
  label: "Web",
  replay: WEB_TOOL_REPLAY,
  description: WEB_TOOL_DESCRIPTION,
  parameters: WEB_TOOL_PARAMETERS as unknown as TSchema,
  execute: async (_id, params, signal) => {
    const args = params as {
      query?: string;
      url?: string;
      category?: string;
      prompt?: string;
    };
    const query = args.query?.trim() ?? "";
    const url = args.url?.trim() ?? "";
    if (!query && !url) {
      throw new Error("Either query or url is required.");
    }
    if (query && url) {
      throw new Error("Pass either query or url, not both.");
    }
    if (url) {
      const prompt = args.prompt?.trim() || undefined;
      const text = await fetchReadableText(
        { url, ...(prompt ? { prompt } : {}) },
        {
          guardUrl: (candidate) => normalizeSafePublicUrl(candidate),
          // Same two protections the desktop tool applies: refuse a URL
          // carrying a credential (exfiltration via a model-chosen
          // query string), and redact secrets out of fetched page text
          // before it becomes model-visible and lands in the transcript.
          checkSecretLikeToken: containsSecretLikeToken,
          sanitize: sanitizeToolVisibleText,
          userAgent: "Stella/1.0 (Cloud)",
          ...(signal ? { signal } : {}),
        },
      );
      return {
        content: [{ type: "text", text }],
        details: { mode: "fetch", url },
      };
    }
    signal?.throwIfAborted();
    const category = args.category?.trim();
    const payload = (await context.ownerInternal("search.web", {
      query,
      ...(category ? { category } : {}),
    })) as WebSearchResult;
    return {
      content: [{ type: "text", text: payload.text || "No results found." }],
      details: { mode: "search", query, ...payload },
    };
  },
});
