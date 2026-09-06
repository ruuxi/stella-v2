import { makeFunctionReference } from "convex/server";
import type {
  CloudConnectorConnectDecision,
  CloudConnectorConnectDecisionResult,
  CloudConnectorConnectRequest,
} from "@stella/contracts/cloud-connector-connect";

export const cloudConnectorConnectApi = {
  listMyPendingConnectRequests: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudConnectorConnectRequest[]
  >("cloud_connector_connect:listMyPendingConnectRequests"),
  decideMyConnectRequest: makeFunctionReference<
    "action",
    {
      requestId: string;
      expectedRevision: number;
      decisionRequestId: string;
      decision: CloudConnectorConnectDecision;
    },
    CloudConnectorConnectDecisionResult
  >("cloud_connector_connect:decideMyConnectRequest"),
};
