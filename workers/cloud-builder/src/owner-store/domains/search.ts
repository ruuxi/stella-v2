/**
 * Web search, metered in the owner's object: the plan admits the request,
 * and a request that reached the provider is charged once.
 *
 * The desktop runtime calls `search.web`; the orchestrator, cloud agents and
 * the turn broker reach the same operation as an internal call.
 */

import type { SearchCalls } from "@stella/contracts/backend/search";
import { WEB_SEARCH_COST_MICRO_CENTS, searchWeb } from "../../web-search.js";
import { object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDomain } from "../registry.js";
import { billingAccess, recordUsage } from "./billing.js";

type SearchArgs = SearchCalls["search.web"]["args"];
type SearchResult = SearchCalls["search.web"]["result"];

const SEARCH_TIMEOUT_MS = 90_000;

const parseSearch = object({
  query: string({ max: 2_000 }),
  category: optional(string({ max: 200 })),
});

const webSearch = async (ctx: OwnerContext, args: SearchArgs): Promise<SearchResult> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "search.web",
    { count: 30, windowMs: 60_000 },
    "Too many web searches. Wait a moment and try again.",
  );
  const access = billingAccess(ctx);
  if (!access.allowed) {
    throw new RpcError("RATE_LIMITED", access.message, {
      retryAfterMs: access.retryAfterMs,
      reason: "usage_limit",
    });
  }
  const outcome = await searchWeb(ctx.env, {
    query: args.query,
    ...(args.category ? { category: args.category } : {}),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (outcome.dispatched) {
    recordUsage({ ...ctx, now: Date.now() }, [
      { id: `search:${crypto.randomUUID()}`, costMicroCents: WEB_SEARCH_COST_MICRO_CENTS },
    ]);
  }
  return outcome.result;
};

export const searchDomain: OwnerDomain = {
  name: "search",
  calls: {
    "search.web": {
      scope: "owner",
      parse: parseSearch,
      handler: webSearch,
    },
  },
  internal: {
    "search.web": (ctx, args) => webSearch(ctx, parseSearch(args)),
  },
};
