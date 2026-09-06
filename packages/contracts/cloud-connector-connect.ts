/**
 * The inline connect card a cloud orchestrator turn shows while its
 * `connector_status` call waits: the cloud twin of the desktop's IPC-driven
 * connect offer. Secret-free — the Composio link is minted on demand by the
 * client's own decision and never stored on the row.
 */

export const CLOUD_CONNECTOR_CONNECT_STATES = [
  "pending",
  "connecting",
  "connected",
  "declined",
  "canceled",
  "expired",
] as const;

export type CloudConnectorConnectState =
  (typeof CLOUD_CONNECTOR_CONNECT_STATES)[number];

export type CloudConnectorConnectDecision = "connect" | "decline";

export type CloudConnectorConnectRequest = Readonly<{
  schemaVersion: 1;
  requestId: string;
  conversationId: string;
  turnId: string;
  integrationId: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
  state: CloudConnectorConnectState;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}>;

export type CloudConnectorConnectDecisionResult = Readonly<{
  request: CloudConnectorConnectRequest;
  /** Present after a `connect` decision: the hosted OAuth page to open. */
  url?: string;
}>;
