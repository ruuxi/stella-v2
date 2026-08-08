import { ConvexReactClient } from "convex/react";
import { env } from "../config/env";

/**
 * Singleton Convex React client for the mobile app. The app primarily uses
 * HTTP routes plus Better Auth JWTs; the client stays mounted so Convex auth
 * context is available for any reactive surfaces that are added later.
 *
 * Auth wiring is attached separately by `ConvexBetterAuthProvider`,
 * which calls `setAuth(...)` on this client with a JWT fetcher backed
 * by Better Auth's session.
 */
let cachedClient: ConvexReactClient | null = null;

export function getConvexClient(): ConvexReactClient {
  if (cachedClient) return cachedClient;
  if (!env.convexUrl) {
    throw new Error("EXPO_PUBLIC_CONVEX_URL is not configured.");
  }
  cachedClient = new ConvexReactClient(env.convexUrl);
  return cachedClient;
}
