export type ConnectorRequestState =
  | "pending"
  | "claimed"
  | "fulfilled"
  | "cancelled"
  | null;

export const connectorFollowupDisposition = (
  state: ConnectorRequestState,
): "wait" | "deliver" | "suppress" => {
  if (state === "fulfilled") return "deliver";
  if (state === "cancelled" || state === null) return "suppress";
  return "wait";
};
