export type JwksRotationState =
  | "prepared"
  | "active"
  | "rolled_back"
  | "retired";

export type JwksRotationSummary = {
  operationId: string;
  state: JwksRotationState;
  previousKeyId: string;
  newKeyId: string;
  createdAt: number;
  updatedAt: number;
  activatedAt?: number;
  rolledBackAt?: number;
  retireAfter?: number;
  retiredAt?: number;
};

export type JwksAuditEvent = "rotation" | "rollback" | "retirement";

/** Keep logs structurally incapable of accepting key documents or JWK data. */
export const buildJwksAuditRecord = (
  event: JwksAuditEvent,
  summary: JwksRotationSummary,
) => ({
  scope: "auth.jwks",
  event,
  operationId: summary.operationId,
  state: summary.state,
  previousKeyId: summary.previousKeyId,
  newKeyId: summary.newKeyId,
  retireAfter: summary.retireAfter,
  retiredAt: summary.retiredAt,
});

export const writeJwksAuditRecord = (
  event: JwksAuditEvent,
  summary: JwksRotationSummary,
) => {
  console.info(JSON.stringify(buildJwksAuditRecord(event, summary)));
};
