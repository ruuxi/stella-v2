import { makeFunctionReference } from "convex/server";
import {
  createMobileCloudMemoryPreferenceClient,
  type MobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceMutationInput,
} from "./cloud-memory-preference";
import { getConvexClient } from "./convex";

const getMyMemoryPreferenceRef = makeFunctionReference<
  "query",
  { expectedSubject: string },
  MobileCloudMemoryPreference & { subject: string }
>("cloud_memory:getMyMemoryPreference");

const setMyMemoryEnabledRef = makeFunctionReference<
  "mutation",
  MobileCloudMemoryPreferenceMutationInput,
  MobileCloudMemoryPreference & { subject: string }
>("cloud_memory:setMyMemoryEnabled");

/** Authenticated Convex transport; all returned values are decoded by core. */
export const mobileCloudMemoryPreferenceClient =
  createMobileCloudMemoryPreferenceClient({
    getMyMemoryPreference: (input) =>
      getConvexClient().query(getMyMemoryPreferenceRef, input),
    setMyMemoryEnabled: (input) =>
      getConvexClient().mutation(setMyMemoryEnabledRef, input),
  });
