import { ConvexReactClient } from "convex/react";
import { env } from "../config/env";

let cachedClient: ConvexReactClient | null = null;

export function getConvexClient(): ConvexReactClient {
  if (cachedClient) return cachedClient;
  if (!env.convexUrl) {
    throw new Error("EXPO_PUBLIC_CONVEX_URL is not configured.");
  }
  cachedClient = new ConvexReactClient(env.convexUrl);
  return cachedClient;
}
