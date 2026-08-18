import { makeFunctionReference } from "convex/server";
import { getConvexClient } from "./convex";

const webSearchAction = makeFunctionReference("agent/local_runtime:webSearch");

export async function searchChatWeb(query, category) {
  return await getConvexClient().action(webSearchAction, {
    query,
    ...(category ? { category } : {}),
  });
}
