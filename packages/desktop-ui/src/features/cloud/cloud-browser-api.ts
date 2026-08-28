import { makeFunctionReference } from "convex/server";
import type {
  CloudBrowserInteractionDecision,
  CloudBrowserInteractionDetail,
  CloudBrowserInteractionSummary,
  CloudBrowserLiveViewCapability,
} from "@stella/contracts/cloud-browser";

export const cloudBrowserApi = {
  listMyPendingBrowserInteractions: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudBrowserInteractionSummary[]
  >("cloud_browser:listMyPendingBrowserInteractions"),
  getMyBrowserInteraction: makeFunctionReference<
    "action",
    { interactionId: string },
    CloudBrowserInteractionDetail | null
  >("cloud_browser:getMyBrowserInteraction"),
  mintMyBrowserLiveViewCapability: makeFunctionReference<
    "action",
    { interactionId: string; expectedRevision: number },
    CloudBrowserLiveViewCapability
  >("cloud_browser:mintMyBrowserLiveViewCapability"),
  decideMyBrowserInteraction: makeFunctionReference<
    "action",
    {
      interactionId: string;
      expectedRevision: number;
      requestId: string;
      decision: CloudBrowserInteractionDecision;
    },
    CloudBrowserInteractionSummary
  >("cloud_browser:decideMyBrowserInteraction"),
  resetMyBrowserProfile: makeFunctionReference<
    "action",
    { requestId: string },
    {
      schemaVersion: 1;
      profileId: "default";
      profileEpoch: number;
      reset: true;
    }
  >("cloud_browser:resetMyBrowserProfile"),
};
