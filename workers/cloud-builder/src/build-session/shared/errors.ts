/** An error whose message is safe to show the user verbatim. */
export class AgentTurnError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "AgentTurnError";
  }
}

/** Exact Convex attempt/token authority was revoked or could not be proven. */
export class AgentTurnAuthorityLostError extends Error {
  constructor() {
    super("Cloud agent attempt authority was lost.");
    this.name = "AgentTurnAuthorityLostError";
  }
}

/** Exact Convex app-turn/token authority was revoked or could not be proven. */
export class AppTurnAuthorityLostError extends Error {
  constructor() {
    super("Cloud app attempt authority was lost.");
    this.name = "AppTurnAuthorityLostError";
  }
}

export class OwnerPurgeFenceError extends Error {
  constructor() {
    super("This owner's cloud activity is being purged.");
    this.name = "OwnerPurgeFenceError";
  }
}

export class TurnStateOwnerCallError extends Error {
  constructor(readonly status: number) {
    super(`Turn state owner operation failed (${status}).`);
    this.name = "TurnStateOwnerCallError";
  }
}

export class BrowserGatewayResponseTooLargeError extends Error {
  constructor() {
    super("Browser Gateway response exceeded its bound.");
    this.name = "BrowserGatewayResponseTooLargeError";
  }
}

export class OwnerProductTransferConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "owner_transfer_conflict"
      | "destination_checkpoint_changed"
      | "owner_purge_permanent"
      | "owner_purge_temporary"
      | "transfer_busy" = "owner_transfer_conflict",
  ) {
    super(message);
    this.name = "OwnerProductTransferConflictError";
  }
}

export class OwnerProductTransferConfigurationError extends Error {}
