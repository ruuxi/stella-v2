import { makeFunctionReference } from "convex/server";
import { getConvexClient } from "./convex";

const webSearchAction = makeFunctionReference("agent/local_runtime:webSearch");

export async function searchChatWeb(request, legacyCategory) {
  const args =
    typeof request === "string"
      ? {
          query: request,
          ...(legacyCategory ? { category: legacyCategory } : {}),
        }
      : {
          ...(request?.query ? { query: request.query } : {}),
          ...(request?.url ? { url: request.url } : {}),
          ...(request?.category ? { category: request.category } : {}),
          ...(request?.prompt ? { prompt: request.prompt } : {}),
          ...(request?.format ? { format: request.format } : {}),
        };
  return await getConvexClient().action(webSearchAction, args);
}
