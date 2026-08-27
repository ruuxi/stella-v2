import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  hashStripeDeletedOperationTuple,
  hashStripePhysicalSuccessLocators,
  hashStripeRetainedLocatorSet,
  stripeHistoricalResultShape,
} from "./billing_deletion";
import { hashSha256Hex } from "./crypto_utils";
import { ownershipMigrationSourceDigest } from "./auth_migration_paths";

export const STRIPE_RECEIPT_INTEGRITY_VERSION = 3;

export type StripeOperation = Doc<"billing_stripe_operations">;

const hasValidProjectedStripeLateResult = (
  operation: StripeOperation,
): boolean => {
  const projectedFields = [
    operation.lateResultConflictStep,
    operation.lateResultConflictAttemptId,
    operation.lateResultRequestFingerprint,
    operation.lateResultIdempotencyKey,
    operation.lateResultProviderDeadlineAt,
    operation.lateResultReconcileClaimId,
    operation.lateResultStripeCustomerId,
    operation.lateResultStripeCheckoutSessionId,
    operation.lateResultStripePortalSessionId,
    operation.lateResultConflictAt,
    operation.lateResultConflictQuiescentAfterAt,
  ];
  const hasAnyProjection = projectedFields.some((value) => value !== undefined);
  if (!hasAnyProjection) {
    return operation.manualDebtReason !== "late_result_conflict";
  }
  const step = operation.lateResultConflictStep;
  const customerId = operation.lateResultStripeCustomerId?.trim();
  const checkoutId = operation.lateResultStripeCheckoutSessionId?.trim();
  const portalId = operation.lateResultStripePortalSessionId?.trim();
  const locatorShapeValid =
    step === "customer_create"
      ? Boolean(customerId && !checkoutId && !portalId)
      : step === "checkout_create"
        ? Boolean(customerId && checkoutId && !portalId)
        : step === "portal_create"
          ? Boolean(customerId && portalId && !checkoutId)
          : false;
  return (
    operation.manualDebtReason === "late_result_conflict" &&
    locatorShapeValid &&
    Boolean(operation.lateResultConflictAttemptId?.trim()) &&
    /^[a-f0-9]{64}$/u.test(
      operation.lateResultRequestFingerprint?.trim() ?? "",
    ) &&
    Boolean(operation.lateResultIdempotencyKey?.trim()) &&
    Number.isSafeInteger(operation.lateResultProviderDeadlineAt) &&
    (operation.lateResultReconcileClaimId === undefined ||
      Boolean(operation.lateResultReconcileClaimId.trim())) &&
    Number.isSafeInteger(operation.lateResultConflictAt) &&
    Number.isSafeInteger(operation.lateResultConflictQuiescentAfterAt) &&
    operation.lateResultConflictQuiescentAfterAt! >=
      operation.lateResultConflictAt!
  );
};

export const hasValidStripeRetainedLocatorProof = async (
  ctx: Pick<QueryCtx, "db">,
  locator: Doc<"billing_stripe_retained_locators">,
): Promise<boolean> => {
  const [resolutions, receipts, retainedLocators] = await Promise.all([
    ctx.db
      .query("billing_stripe_late_cleanup_resolutions")
      .withIndex("by_resolutionId", (q) =>
        q.eq("resolutionId", locator.resolutionId),
      )
      .take(2),
    ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", locator.tupleHash))
      .take(2),
    ctx.db
      .query("billing_stripe_retained_locators")
      .withIndex("by_resolutionId", (q) =>
        q.eq("resolutionId", locator.resolutionId),
      )
      .take(3),
  ]);
  const resolution = resolutions[0];
  const receipt = receipts[0];
  const uniqueLocatorHashes = new Set(
    retainedLocators.map((row) => row.locatorHash),
  );
  const locatorSetHash = await hashStripeRetainedLocatorSet(retainedLocators);
  return (
    /^[a-f0-9]{64}$/u.test(locator.ownerHash) &&
    resolutions.length === 1 &&
    receipts.length === 1 &&
    Boolean(resolution) &&
    Boolean(receipt) &&
    resolution!.tupleHash === locator.tupleHash &&
    resolution!.successLocatorHash === receipt!.successLocatorHash &&
    resolution!.resolution === "provider_resource_retained" &&
    Number.isSafeInteger(resolution!.locatorCount) &&
    resolution!.locatorCount === retainedLocators.length &&
    resolution!.locatorSetHash === locatorSetHash &&
    retainedLocators.length >= 1 &&
    retainedLocators.length <= 2 &&
    uniqueLocatorHashes.size === retainedLocators.length &&
    retainedLocators.every(
      (row) =>
        row.tupleHash === locator.tupleHash &&
        row.resolutionId === locator.resolutionId &&
        row.ownerHash === locator.ownerHash,
    ) &&
    retainedLocators.some((row) => row._id === locator._id) &&
    receipt!.cleanupResolutionId === locator.resolutionId &&
    receipt!.deletionCleanupTerminalized !== true
  );
};

/**
 * State/locator proof independent of the live transport tuple. Ordinary
 * provider-complete operations retain their step-shaped locators. The two
 * deletion-only markers are the sole exceptions because their exact
 * cleanup/no-dispatch proof lives outside the primary locator fields.
 */
export const hasValidStripeOperationStateLocators = (
  operation: StripeOperation,
): boolean => {
  if (!hasValidProjectedStripeLateResult(operation)) return false;
  const customerId = operation.stripeCustomerId?.trim();
  const checkoutId = operation.stripeCheckoutSessionId?.trim();
  const portalId = operation.stripePortalSessionId?.trim();
  const terminalizedWithoutProviderDispatch =
    operation.terminalizedWithoutProviderDispatch === true;
  const terminalizedForDeletionCleanup =
    operation.terminalizedForDeletionCleanup === true;
  if (
    operation.priorStripeCustomerId !== undefined ||
    operation.priorStripeCheckoutSessionId !== undefined ||
    operation.priorStripePortalSessionId !== undefined
  ) {
    return false;
  }
  const historicalTupleFields = [
    operation.lastStripeAttemptId,
    operation.lastStripeStep,
    operation.lastStripeRequestFingerprint,
    operation.lastStripeIdempotencyKey,
    operation.lastStripeProviderDeadlineAt,
  ];
  const hasAnyHistoricalResult =
    historicalTupleFields.some((value) => value !== undefined) ||
    operation.lastStripeReconcileClaimId !== undefined ||
    operation.lastStripeDisposition !== undefined;
  const hasCompleteHistoricalResult =
    typeof operation.lastStripeAttemptId === "string" &&
    operation.lastStripeAttemptId.trim().length > 0 &&
    (operation.lastStripeStep === "customer_create" ||
      operation.lastStripeStep === "checkout_create" ||
      operation.lastStripeStep === "portal_create") &&
    typeof operation.lastStripeRequestFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(operation.lastStripeRequestFingerprint) &&
    typeof operation.lastStripeIdempotencyKey === "string" &&
    operation.lastStripeIdempotencyKey.trim().length > 0 &&
    Number.isSafeInteger(operation.lastStripeProviderDeadlineAt) &&
    (operation.lastStripeDisposition === "succeeded" ||
      operation.lastStripeDisposition === "not_created") &&
    (operation.lastStripeReconcileClaimId === undefined ||
      operation.lastStripeReconcileClaimId.trim().length > 0);
  if (hasAnyHistoricalResult && !hasCompleteHistoricalResult) return false;
  if (terminalizedWithoutProviderDispatch && terminalizedForDeletionCleanup) {
    return false;
  }
  if (operation.state === "reserved") {
    if (
      !terminalizedWithoutProviderDispatch &&
      !terminalizedForDeletionCleanup
    ) {
      const validReservedLocators =
        operation.kind === "billing_portal"
          ? Boolean(customerId && !checkoutId && !portalId)
          : Boolean(!checkoutId && !portalId);
      if (!validReservedLocators) return false;
      if (!hasAnyHistoricalResult) return true;
      if (operation.lastStripeDisposition === "not_created") {
        return operation.lastStripeStep === "customer_create"
          ? true
          : operation.lastStripeStep === "portal_create"
            ? operation.kind === "billing_portal" && Boolean(customerId)
            : operation.lastStripeStep === "checkout_create" &&
              operation.kind !== "billing_portal" &&
              Boolean(customerId);
      }
      return (
        operation.lastStripeDisposition === "succeeded" &&
        operation.lastStripeStep === "customer_create" &&
        Boolean(customerId)
      );
    }
    return false;
  }
  if (terminalizedForDeletionCleanup) {
    return (
      operation.state === "provider_succeeded" &&
      hasCompleteHistoricalResult &&
      operation.lastStripeDisposition === "succeeded" &&
      (operation.lastStripeStep === "customer_create"
        ? Boolean(customerId && !checkoutId && !portalId)
        : operation.lastStripeStep === "checkout_create"
          ? operation.kind !== "billing_portal" &&
            Boolean(customerId && checkoutId && !portalId)
          : operation.lastStripeStep === "portal_create" &&
            operation.kind === "billing_portal" &&
            Boolean(customerId && portalId && !checkoutId))
    );
  }
  if (terminalizedWithoutProviderDispatch) {
    if (operation.state !== "provider_succeeded") return false;
    return !checkoutId && !portalId;
  }
  const hasCompleteSucceededHistory =
    hasCompleteHistoricalResult &&
    operation.lastStripeDisposition === "succeeded" &&
    operation.lastStripeStep ===
      (operation.kind === "billing_portal"
        ? "portal_create"
        : "checkout_create");
  if (
    !hasCompleteSucceededHistory &&
    !operation.terminalizedByManualResolutionId?.trim()
  ) {
    return false;
  }
  return operation.kind === "billing_portal"
    ? Boolean(customerId && portalId && !checkoutId)
    : Boolean(customerId && checkoutId && !portalId);
};

export const hasCurrentStripeOperationIntegrity = (
  operation: StripeOperation,
): boolean =>
  operation.integrityVersion === STRIPE_RECEIPT_INTEGRITY_VERSION &&
  hasValidStripeOperationStateLocators(operation);

export const hasLegacyStripeOperationIntegrityVersion = (
  operation: StripeOperation,
): boolean =>
  operation.integrityVersion === undefined ||
  operation.integrityVersion === 1 ||
  operation.integrityVersion === 2;

const hasCleanStripeOperationTransportFields = (
  operation: StripeOperation,
): boolean =>
  operation.activeStep === undefined &&
  operation.activeAttemptId === undefined &&
  operation.activeRequestJson === undefined &&
  operation.activeRequestFingerprint === undefined &&
  operation.activeIdempotencyKey === undefined &&
  operation.providerDeadlineAt === undefined &&
  operation.quiescentAfterAt === undefined &&
  operation.nextReconcileAt === undefined &&
  operation.reconcileClaimId === undefined &&
  operation.reconcileClaimExpiresAt === undefined &&
  operation.manualDebtReason === undefined &&
  operation.lateResultConflictStep === undefined &&
  operation.lateResultConflictAttemptId === undefined &&
  operation.lateResultRequestFingerprint === undefined &&
  operation.lateResultIdempotencyKey === undefined &&
  operation.lateResultProviderDeadlineAt === undefined &&
  operation.lateResultReconcileClaimId === undefined &&
  operation.lateResultStripeCustomerId === undefined &&
  operation.lateResultStripeCheckoutSessionId === undefined &&
  operation.lateResultStripePortalSessionId === undefined &&
  operation.lateResultConflictAt === undefined &&
  operation.lateResultConflictQuiescentAfterAt === undefined &&
  (operation.stripeCustomerMetadataTransferState === undefined ||
    operation.stripeCustomerMetadataTransferState === "idle") &&
  operation.stripeCustomerMetadataTransferToOwnerId === undefined &&
  operation.stripeCustomerMetadataTransferAttemptId === undefined &&
  operation.stripeCustomerMetadataTransferIdempotencyKey === undefined &&
  operation.stripeCustomerMetadataTransferProviderDeadlineAt === undefined &&
  operation.stripeCustomerMetadataTransferQuiescentAfterAt === undefined &&
  operation.stripeCustomerMetadataTransferDebtReason === undefined;

export const hasCleanIdleStripeOperationTransport = (
  operation: StripeOperation,
): boolean =>
  operation.dispatchState === "idle" &&
  hasCleanStripeOperationTransportFields(operation);

export const hasCleanLegacyStripeOperationTransport = (
  operation: StripeOperation,
): boolean =>
  (operation.dispatchState === undefined ||
    operation.dispatchState === "idle") &&
  hasCleanStripeOperationTransportFields(operation);

export const hasMatchingStripeManualResolutionProof = async (
  ctx: Pick<QueryCtx, "db">,
  operation: StripeOperation,
): Promise<boolean> => {
  const resolutionId = operation.terminalizedByManualResolutionId?.trim();
  if (!resolutionId) return false;
  const resolution = await ctx.db
    .query("billing_stripe_operation_resolutions")
    .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
    .unique();
  if (
    !resolution ||
    resolution.operationId !== operation.operationId ||
    resolution.ownerId !== operation.ownerId ||
    resolution.ownerGeneration !== operation.ownerGeneration
  ) {
    return false;
  }
  const expectedStep =
    operation.kind === "billing_portal" ? "portal_create" : "checkout_create";
  const expectedResolution =
    expectedStep === "portal_create"
      ? "recovered_portal"
      : "recovered_checkout";
  if (
    resolution.step !== expectedStep ||
    resolution.resolution !== expectedResolution ||
    !resolution.locatorHash
  ) {
    return false;
  }
  const locatorEnvelope =
    expectedStep === "portal_create"
      ? {
          stripeCustomerId: operation.stripeCustomerId!,
          stripePortalSessionId: operation.stripePortalSessionId!,
        }
      : {
          stripeCustomerId: operation.stripeCustomerId!,
          stripeCheckoutSessionId: operation.stripeCheckoutSessionId!,
        };
  const locatorHash = await hashSha256Hex(
    `stella-stripe-resolution-v1\u0000locator\u0000${JSON.stringify(locatorEnvelope)}`,
  );
  return resolution.locatorHash === locatorHash;
};

export const MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION = 256;
export const MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION =
  MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION * 2 + 1;

/**
 * Bounded range-read used immediately before minting a new immutable physical
 * tuple. Keeping the read and insert in the same mutation lets Convex OCC
 * serialize concurrent writers, so the 257th tuple can never poison every
 * later lifecycle integrity check for the operation.
 */
export const hasStripePhysicalReceiptCapacityForInsert = async (
  ctx: Pick<MutationCtx, "db">,
  operationId: string,
): Promise<boolean> => {
  const receipts = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
    .take(MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION + 1);
  return receipts.length < MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION;
};

export const hasStripeOperationResolutionCapacityForInsert = async (
  ctx: Pick<MutationCtx, "db">,
  operationId: string,
): Promise<boolean> => {
  const resolutions = await ctx.db
    .query("billing_stripe_operation_resolutions")
    .withIndex("by_operationId_and_resolvedAt", (q) =>
      q.eq("operationId", operationId),
    )
    .take(MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION + 1);
  return resolutions.length < MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION;
};

/**
 * Atomically re-owns every immutable manual/late resolution proof attached to
 * one operation. A proof is migration authority only when both global
 * resolution id and per-operation debt key identify exactly the same row.
 * Callers patch the operation in the same mutation after this returns true.
 */
export const moveStripeOperationResolutionProofs = async (
  ctx: MutationCtx,
  operation: StripeOperation,
  args: {
    fromOwnerId: string;
    fromOwnerGeneration: string;
    toOwnerId: string;
    toOwnerGeneration: string;
    phase?: "before_operation_move" | "after_operation_move";
  },
): Promise<boolean> => {
  const phase = args.phase ?? "before_operation_move";
  const expectedOperationOwnerId =
    phase === "before_operation_move" ? args.fromOwnerId : args.toOwnerId;
  const expectedOperationOwnerGeneration =
    phase === "before_operation_move"
      ? args.fromOwnerGeneration
      : args.toOwnerGeneration;
  const resolutions = await ctx.db
    .query("billing_stripe_operation_resolutions")
    .withIndex("by_operationId_and_resolvedAt", (q) =>
      q.eq("operationId", operation.operationId),
    )
    .take(MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION + 1);
  if (
    resolutions.length > MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION ||
    operation.ownerId !== expectedOperationOwnerId ||
    operation.ownerGeneration !== expectedOperationOwnerGeneration
  ) {
    return false;
  }

  const seenResolutionIds = new Set<string>();
  const seenDebtKeys = new Set<string>();
  const exactRows = await Promise.all(
    resolutions.map(async (resolution) => {
      if (
        resolution.operationId !== operation.operationId ||
        !(
          (resolution.ownerId === args.fromOwnerId &&
            resolution.ownerGeneration === args.fromOwnerGeneration) ||
          (phase === "after_operation_move" &&
            resolution.ownerId === args.toOwnerId &&
            resolution.ownerGeneration === args.toOwnerGeneration)
        ) ||
        !resolution.resolutionId.trim() ||
        !resolution.debtKey.trim() ||
        seenResolutionIds.has(resolution.resolutionId) ||
        seenDebtKeys.has(resolution.debtKey)
      ) {
        return false;
      }
      seenResolutionIds.add(resolution.resolutionId);
      seenDebtKeys.add(resolution.debtKey);
      const [resolutionIdRows, debtKeyRows] = await Promise.all([
        ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_resolutionId", (q) =>
            q.eq("resolutionId", resolution.resolutionId),
          )
          .take(2),
        ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_debtKey", (q) =>
            q
              .eq("operationId", operation.operationId)
              .eq("debtKey", resolution.debtKey),
          )
          .take(2),
      ]);
      return (
        resolutionIdRows.length === 1 &&
        resolutionIdRows[0]!._id === resolution._id &&
        debtKeyRows.length === 1 &&
        debtKeyRows[0]!._id === resolution._id
      );
    }),
  );
  if (!exactRows.every(Boolean)) return false;
  if (
    operation.terminalizedByManualResolutionId !== undefined &&
    !seenResolutionIds.has(operation.terminalizedByManualResolutionId)
  ) {
    return false;
  }

  for (const resolution of resolutions) {
    if (
      resolution.ownerId !== args.toOwnerId ||
      resolution.ownerGeneration !== args.toOwnerGeneration
    ) {
      await ctx.db.patch(resolution._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: args.toOwnerGeneration,
      });
    }
  }
  return true;
};

/** Exact read-only proof used at provider-I/O fences. */
export const hasExactStripeOperationResolutionProofSet = async (
  ctx: MutationCtx,
  operation: StripeOperation,
): Promise<boolean> =>
  await moveStripeOperationResolutionProofs(ctx, operation, {
    fromOwnerId: operation.ownerId,
    fromOwnerGeneration: operation.ownerGeneration,
    toOwnerId: operation.ownerId,
    toOwnerGeneration: operation.ownerGeneration,
  });

type StripePhysicalTuple = {
  operationId: string;
  attemptId: string;
  step: "customer_create" | "checkout_create" | "portal_create";
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
};

const hasStepCompatibleSuccessLocators = (
  step: StripePhysicalTuple["step"],
  locators: {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
): boolean => {
  const customerId = locators.stripeCustomerId?.trim();
  const checkoutId = locators.stripeCheckoutSessionId?.trim();
  const portalId = locators.stripePortalSessionId?.trim();
  return step === "customer_create"
    ? Boolean(customerId && !checkoutId && !portalId)
    : step === "checkout_create"
      ? Boolean(customerId && checkoutId && !portalId)
      : Boolean(customerId && portalId && !checkoutId);
};

const operationHistoricalTuple = (
  operation: StripeOperation,
): StripePhysicalTuple | null =>
  stripeHistoricalResultShape(operation) === "complete"
    ? {
        operationId: operation.operationId,
        attemptId: operation.lastStripeAttemptId!,
        step: operation.lastStripeStep! as StripePhysicalTuple["step"],
        requestFingerprint: operation.lastStripeRequestFingerprint!,
        idempotencyKey: operation.lastStripeIdempotencyKey!,
        providerDeadlineAt: operation.lastStripeProviderDeadlineAt!,
      }
    : null;

const operationHistoricalSuccessLocators = (operation: StripeOperation) => ({
  stripeCustomerId: operation.stripeCustomerId,
  ...(operation.lastStripeStep === "checkout_create"
    ? { stripeCheckoutSessionId: operation.stripeCheckoutSessionId }
    : {}),
  ...(operation.lastStripeStep === "portal_create"
    ? { stripePortalSessionId: operation.stripePortalSessionId }
    : {}),
});

/**
 * Proves that every immutable physical receipt for one logical operation is
 * explained by its current active tuple, canonical historical result,
 * unresolved late-result row, or an immutable late-result resolution audit.
 * A clean current row with an otherwise unnameable receipt is provider debt,
 * not replay authority.
 */
export const hasOnlyProvenStripeOperationPhysicalReceipts = async (
  ctx: Pick<QueryCtx, "db">,
  operation: StripeOperation,
): Promise<boolean> => {
  const [receipts, lateResults, resolutions] = await Promise.all([
    ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_operationId", (q) =>
        q.eq("operationId", operation.operationId),
      )
      .take(MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION + 1),
    ctx.db
      .query("billing_stripe_late_results")
      .withIndex("by_operationId_and_createdAt", (q) =>
        q.eq("operationId", operation.operationId),
      )
      .take(MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION + 1),
    ctx.db
      .query("billing_stripe_operation_resolutions")
      .withIndex("by_operationId_and_resolvedAt", (q) =>
        q.eq("operationId", operation.operationId),
      )
      .take(MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION + 1),
  ]);
  if (
    receipts.length > MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION ||
    lateResults.length > MAX_STRIPE_PHYSICAL_RECEIPTS_PER_OPERATION ||
    resolutions.length > MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION
  ) {
    return false;
  }

  type ExpectedPhysicalEvidence = {
    fallbackHashes: Set<string | null>;
    providerSuccessHashes: Set<string>;
  };
  const expected = new Map<string, ExpectedPhysicalEvidence>();
  const terminalNotCreatedTupleHashes = new Set<string>();
  const addExpected = (
    tupleHash: string,
    successLocatorHash: string | undefined,
    source: "fallback" | "provider_success",
  ) => {
    const normalizedTupleHash = tupleHash.trim();
    const normalizedSuccessHash = successLocatorHash?.trim() || null;
    if (!/^[a-f0-9]{64}$/u.test(normalizedTupleHash)) return false;
    if (
      normalizedSuccessHash !== null &&
      !/^[a-f0-9]{64}$/u.test(normalizedSuccessHash)
    ) {
      return false;
    }
    if (source === "provider_success" && normalizedSuccessHash === null) {
      return false;
    }
    const evidence = expected.get(normalizedTupleHash) ?? {
      fallbackHashes: new Set<string | null>(),
      providerSuccessHashes: new Set<string>(),
    };
    if (source === "provider_success") {
      evidence.providerSuccessHashes.add(normalizedSuccessHash!);
    } else {
      evidence.fallbackHashes.add(normalizedSuccessHash);
    }
    expected.set(normalizedTupleHash, evidence);
    return true;
  };

  if (operation.dispatchState === "may_have_dispatched") {
    if (
      !operation.activeAttemptId ||
      !operation.activeStep ||
      !operation.activeRequestFingerprint ||
      !operation.activeIdempotencyKey ||
      operation.providerDeadlineAt === undefined
    ) {
      return false;
    }
    const tupleHash = await hashStripeDeletedOperationTuple({
      operationId: operation.operationId,
      attemptId: operation.activeAttemptId,
      step: operation.activeStep,
      requestFingerprint: operation.activeRequestFingerprint,
      idempotencyKey: operation.activeIdempotencyKey,
      providerDeadlineAt: operation.providerDeadlineAt,
    });
    if (!addExpected(tupleHash, undefined, "fallback")) return false;
  }

  const historicalTuple = operationHistoricalTuple(operation);
  if (historicalTuple) {
    const succeeded = operation.lastStripeDisposition === "succeeded";
    const locators = operationHistoricalSuccessLocators(operation);
    if (
      succeeded &&
      !hasStepCompatibleSuccessLocators(historicalTuple.step, locators)
    ) {
      return false;
    }
    const tupleHash = await hashStripeDeletedOperationTuple(historicalTuple);
    const successLocatorHash = succeeded
      ? await hashStripePhysicalSuccessLocators(locators)
      : undefined;
    const expectedRecoveredResolution =
      historicalTuple.step === "customer_create"
        ? "recovered_customer"
        : historicalTuple.step === "checkout_create"
          ? "recovered_checkout"
          : "recovered_portal";
    const matchingManualResolutions = succeeded
      ? resolutions.filter(
          (resolution) =>
            resolution.ownerId === operation.ownerId &&
            resolution.ownerGeneration === operation.ownerGeneration &&
            resolution.attemptId === historicalTuple.attemptId &&
            resolution.step === historicalTuple.step &&
            resolution.debtReason !== undefined &&
            resolution.debtKey ===
              `attempt:${historicalTuple.attemptId}:${resolution.debtReason}` &&
            resolution.resolution === expectedRecoveredResolution &&
            resolution.locatorHash === successLocatorHash &&
            (historicalTuple.step === "customer_create" ||
              operation.terminalizedByManualResolutionId ===
                resolution.resolutionId),
        )
      : [];
    const matchingManualNotCreatedResolutions = !succeeded
      ? resolutions.filter(
          (resolution) =>
            resolution.ownerId === operation.ownerId &&
            resolution.ownerGeneration === operation.ownerGeneration &&
            resolution.attemptId === historicalTuple.attemptId &&
            resolution.step === historicalTuple.step &&
            resolution.debtReason !== undefined &&
            resolution.debtKey ===
              `attempt:${historicalTuple.attemptId}:${resolution.debtReason}` &&
            resolution.resolution === "provider_confirmed_not_created" &&
            resolution.locatorHash === undefined,
        )
      : [];
    if (matchingManualResolutions.length > 1) return false;
    if (matchingManualNotCreatedResolutions.length > 1) return false;
    if (matchingManualResolutions.length === 1) {
      // Operator recovery proves the canonical locator, but it is not itself a
      // provider callback. The permanent physical receipt remains unbound
      // until Stripe actually returns; that later result may either match the
      // recovery or become an independently recorded late-result conflict.
      if (
        !addExpected(tupleHash, undefined, "fallback") ||
        !addExpected(tupleHash, successLocatorHash, "fallback")
      ) {
        return false;
      }
    } else if (
      !addExpected(
        tupleHash,
        successLocatorHash,
        succeeded ? "provider_success" : "fallback",
      )
    ) {
      return false;
    }
    if (!succeeded && matchingManualNotCreatedResolutions.length === 0) {
      terminalNotCreatedTupleHashes.add(tupleHash);
    }
  }

  if (
    operation.manualDebtReason === "late_result_conflict" &&
    operation.lateResultConflictAttemptId &&
    operation.lateResultConflictStep &&
    operation.lateResultRequestFingerprint &&
    operation.lateResultIdempotencyKey &&
    operation.lateResultProviderDeadlineAt !== undefined
  ) {
    const locators = {
      stripeCustomerId: operation.lateResultStripeCustomerId,
      stripeCheckoutSessionId: operation.lateResultStripeCheckoutSessionId,
      stripePortalSessionId: operation.lateResultStripePortalSessionId,
    };
    if (
      !hasStepCompatibleSuccessLocators(
        operation.lateResultConflictStep,
        locators,
      )
    ) {
      return false;
    }
    const tupleHash = await hashStripeDeletedOperationTuple({
      operationId: operation.operationId,
      attemptId: operation.lateResultConflictAttemptId,
      step: operation.lateResultConflictStep,
      requestFingerprint: operation.lateResultRequestFingerprint,
      idempotencyKey: operation.lateResultIdempotencyKey,
      providerDeadlineAt: operation.lateResultProviderDeadlineAt,
    });
    if (
      !addExpected(
        tupleHash,
        await hashStripePhysicalSuccessLocators(locators),
        "provider_success",
      )
    ) {
      return false;
    }
  }

  for (const row of lateResults) {
    if (row.ownerId !== operation.ownerId) return false;
    const locators = {
      stripeCustomerId: row.stripeCustomerId,
      stripeCheckoutSessionId: row.stripeCheckoutSessionId,
      stripePortalSessionId: row.stripePortalSessionId,
    };
    if (!hasStepCompatibleSuccessLocators(row.step, locators)) return false;
    const tupleHash = await hashStripeDeletedOperationTuple({
      operationId: row.operationId,
      attemptId: row.attemptId,
      step: row.step,
      requestFingerprint: row.requestFingerprint,
      idempotencyKey: row.idempotencyKey,
      providerDeadlineAt: row.providerDeadlineAt,
    });
    const locatorHash = await hashStripePhysicalSuccessLocators(locators);
    if (
      tupleHash !== row.tupleHash ||
      locatorHash !== row.locatorHash ||
      !addExpected(tupleHash, locatorHash, "provider_success")
    ) {
      return false;
    }
  }

  const lateResolutionDebtKeyCounts = new Map<string, number>();
  for (const resolution of resolutions) {
    if (resolution.debtKey.startsWith("late:")) {
      lateResolutionDebtKeyCounts.set(
        resolution.debtKey,
        (lateResolutionDebtKeyCounts.get(resolution.debtKey) ?? 0) + 1,
      );
    }
  }
  for (const resolution of resolutions) {
    if (!resolution.debtKey.startsWith("late:")) continue;
    const match = /^late:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(
      resolution.debtKey,
    );
    if (
      !match ||
      resolution.ownerId !== operation.ownerId ||
      resolution.ownerGeneration !== operation.ownerGeneration ||
      resolution.debtReason !== "late_result_conflict" ||
      !resolution.attemptId?.trim() ||
      lateResolutionDebtKeyCounts.get(resolution.debtKey) !== 1 ||
      resolution.resolution !==
        (resolution.step === "customer_create"
          ? "recovered_customer"
          : resolution.step === "checkout_create"
            ? "recovered_checkout"
            : "recovered_portal") ||
      resolution.locatorHash !== match[2] ||
      !addExpected(match[1]!, match[2]!, "provider_success")
    ) {
      return false;
    }
  }

  const canonicalSuccessLocatorHashes = new Set<string>();
  if (operation.stripeCustomerId?.trim()) {
    canonicalSuccessLocatorHashes.add(
      await hashStripePhysicalSuccessLocators({
        stripeCustomerId: operation.stripeCustomerId,
      }),
    );
    if (operation.stripeCheckoutSessionId?.trim()) {
      canonicalSuccessLocatorHashes.add(
        await hashStripePhysicalSuccessLocators({
          stripeCustomerId: operation.stripeCustomerId,
          stripeCheckoutSessionId: operation.stripeCheckoutSessionId,
        }),
      );
    }
    if (operation.stripePortalSessionId?.trim()) {
      canonicalSuccessLocatorHashes.add(
        await hashStripePhysicalSuccessLocators({
          stripeCustomerId: operation.stripeCustomerId,
          stripePortalSessionId: operation.stripePortalSessionId,
        }),
      );
    }
  }

  const observed = new Set<string>();
  let deletingOwner: boolean | undefined;
  const globalReceiptRows = await Promise.all(
    receipts.map((receipt) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", receipt.tupleHash))
        .take(2),
    ),
  );
  const retentionResolutionRows = await Promise.all(
    receipts.map((receipt) =>
      receipt.cleanupResolutionId
        ? ctx.db
            .query("billing_stripe_late_cleanup_resolutions")
            .withIndex("by_resolutionId", (q) =>
              q.eq("resolutionId", receipt.cleanupResolutionId!),
            )
            .take(2)
        : Promise.resolve([]),
    ),
  );
  const retainedLocatorRows = await Promise.all(
    receipts.map((receipt) =>
      receipt.cleanupResolutionId
        ? ctx.db
            .query("billing_stripe_retained_locators")
            .withIndex("by_resolutionId", (q) =>
              q.eq("resolutionId", receipt.cleanupResolutionId!),
            )
            .take(3)
        : Promise.resolve([]),
    ),
  );
  for (const [receiptIndex, receipt] of receipts.entries()) {
    const tupleRows = globalReceiptRows[receiptIndex]!;
    const retentionRows = retentionResolutionRows[receiptIndex]!;
    const retainedLocators = retainedLocatorRows[receiptIndex]!;
    const retainedLocatorSetHash =
      await hashStripeRetainedLocatorSet(retainedLocators);
    const matchingRetentionResolution =
      receipt.cleanupResolutionId !== undefined &&
      receipt.deletionCleanupTerminalized !== true &&
      retentionRows.length === 1 &&
      retentionRows[0]!.resolutionId === receipt.cleanupResolutionId &&
      retentionRows[0]!.tupleHash === receipt.tupleHash &&
      retentionRows[0]!.successLocatorHash === receipt.successLocatorHash &&
      retentionRows[0]!.resolution === "provider_resource_retained" &&
      retentionRows[0]!.locatorCount === retainedLocators.length &&
      retentionRows[0]!.locatorSetHash === retainedLocatorSetHash &&
      retainedLocators.length >= 1 &&
      retainedLocators.length <= 2 &&
      new Set(retainedLocators.map((locator) => locator.locatorHash)).size ===
        retainedLocators.length &&
      retainedLocators.every(
        (locator) =>
          locator.tupleHash === receipt.tupleHash &&
          /^[a-f0-9]{64}$/u.test(locator.ownerHash),
      );
    if (
      receipt.operationId !== operation.operationId ||
      observed.has(receipt.tupleHash) ||
      tupleRows.length !== 1 ||
      tupleRows[0]!._id !== receipt._id ||
      !/^[a-f0-9]{64}$/u.test(receipt.providerOwnerHash ?? "")
    ) {
      return false;
    }
    if (
      (receipt.cleanupResolutionId !== undefined &&
        !matchingRetentionResolution) ||
      (receipt.cleanupResolutionId !== undefined &&
        receipt.deletionCleanupTerminalized === true)
    ) {
      return false;
    }
    const observedSuccessLocatorHash =
      receipt.successLocatorHash?.trim() || null;
    if (
      observedSuccessLocatorHash !== null &&
      receipt.notCreatedTerminalized === true
    ) {
      return false;
    }
    if (
      terminalNotCreatedTupleHashes.has(receipt.tupleHash) &&
      observedSuccessLocatorHash === null &&
      receipt.notCreatedTerminalized !== true
    ) {
      return false;
    }
    const expectedEvidence = expected.get(receipt.tupleHash);
    if ((expectedEvidence?.providerSuccessHashes.size ?? 0) > 1) return false;
    const providerSuccessHash = expectedEvidence
      ? [...expectedEvidence.providerSuccessHashes][0]
      : undefined;
    const allowedExpectedHashes = providerSuccessHash
      ? new Set<string | null>([providerSuccessHash])
      : expectedEvidence?.fallbackHashes;
    if (!allowedExpectedHashes) {
      if (
        observedSuccessLocatorHash === null
          ? receipt.notCreatedTerminalized !== true
          : !/^[a-f0-9]{64}$/u.test(observedSuccessLocatorHash) ||
            (!canonicalSuccessLocatorHashes.has(observedSuccessLocatorHash) &&
              receipt.deletionCleanupTerminalized !== true &&
              !matchingRetentionResolution)
      ) {
        return false;
      }
      if (
        (receipt.deletionCleanupTerminalized === true ||
          matchingRetentionResolution) &&
        observedSuccessLocatorHash !== null &&
        !canonicalSuccessLocatorHashes.has(observedSuccessLocatorHash)
      ) {
        if (deletingOwner === undefined) {
          const lifecycle = await ctx.db
            .query("cloud_owner_lifecycles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", operation.ownerId))
            .unique();
          deletingOwner = lifecycle?.state === "deleting";
        }
        if (!deletingOwner) return false;
      }
    } else if (!allowedExpectedHashes.has(observedSuccessLocatorHash)) {
      if (providerSuccessHash !== undefined) return false;
      if (
        (receipt.deletionCleanupTerminalized !== true &&
          !matchingRetentionResolution) ||
        observedSuccessLocatorHash === null ||
        !/^[a-f0-9]{64}$/u.test(observedSuccessLocatorHash)
      ) {
        return false;
      }
      if (deletingOwner === undefined) {
        const lifecycle = await ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", operation.ownerId))
          .unique();
        deletingOwner = lifecycle?.state === "deleting";
      }
      if (!deletingOwner) return false;
    }
    observed.add(receipt.tupleHash);
  }
  return [...expected.keys()].every((tupleHash) => observed.has(tupleHash));
};

/**
 * Rolling-upgrade repair for the enumerated pre-v3 lineage only. A current-v3
 * success receipt missing its result binding is an orphan and is never
 * inferred during reserve, migration, reset, or deletion.
 */
export const ensureLegacyStripeOperationPhysicalReceiptProvenance = async (
  ctx: MutationCtx,
  operation: StripeOperation,
): Promise<boolean> => {
  if (!hasLegacyStripeOperationIntegrityVersion(operation)) {
    return await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation);
  }
  const historicalTuple = operationHistoricalTuple(operation);
  const providerOwnerHash = await ownershipMigrationSourceDigest(
    operation.ownerId,
  );
  if (historicalTuple) {
    const succeeded = operation.lastStripeDisposition === "succeeded";
    const locators = operationHistoricalSuccessLocators(operation);
    if (
      succeeded &&
      !hasStepCompatibleSuccessLocators(historicalTuple.step, locators)
    ) {
      return false;
    }
    const tupleHash = await hashStripeDeletedOperationTuple(historicalTuple);
    let receipts = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
      .take(2);
    if (receipts.length > 1) {
      return false;
    }
    const canonicalSuccessLocatorHash = succeeded
      ? await hashStripePhysicalSuccessLocators(locators)
      : undefined;
    const expectedRecoveredResolution =
      historicalTuple.step === "customer_create"
        ? "recovered_customer"
        : historicalTuple.step === "checkout_create"
          ? "recovered_checkout"
          : "recovered_portal";
    const manualResolutionRows = succeeded
      ? await ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .take(MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION + 1)
      : [];
    if (
      manualResolutionRows.length >
      MAX_STRIPE_OPERATION_RESOLUTIONS_PER_OPERATION
    ) {
      return false;
    }
    const matchingManualRecoveries = succeeded
      ? manualResolutionRows.filter(
          (resolution) =>
            resolution.ownerId === operation.ownerId &&
            resolution.ownerGeneration === operation.ownerGeneration &&
            resolution.attemptId === historicalTuple.attemptId &&
            resolution.step === historicalTuple.step &&
            resolution.debtReason !== undefined &&
            resolution.debtKey ===
              `attempt:${historicalTuple.attemptId}:${resolution.debtReason}` &&
            resolution.resolution === expectedRecoveredResolution &&
            resolution.locatorHash === canonicalSuccessLocatorHash &&
            (historicalTuple.step === "customer_create" ||
              operation.terminalizedByManualResolutionId ===
                resolution.resolutionId),
        )
      : [];
    if (matchingManualRecoveries.length > 1) return false;
    // An operator-recovered locator is canonical local state, but it is not a
    // provider callback. Do not bind an unbound receipt until Stripe returns.
    const successLocatorHash =
      succeeded && matchingManualRecoveries.length === 0
        ? canonicalSuccessLocatorHash
        : undefined;
    if (receipts.length === 0) {
      if (
        !(await hasStripePhysicalReceiptCapacityForInsert(
          ctx,
          operation.operationId,
        ))
      ) {
        return false;
      }
      const receiptId = await ctx.db.insert(
        "billing_stripe_physical_receipts",
        {
          operationId: operation.operationId,
          tupleHash,
          providerOwnerHash,
          ...(successLocatorHash ? { successLocatorHash } : {}),
          createdAt: Date.now(),
        },
      );
      const inserted = await ctx.db.get(receiptId);
      if (!inserted) return false;
      receipts = [inserted];
    }
    if (receipts[0]!.operationId !== operation.operationId) return false;
    if (
      receipts[0]!.providerOwnerHash !== undefined &&
      receipts[0]!.providerOwnerHash !== providerOwnerHash
    ) {
      return false;
    }
    if (receipts[0]!.providerOwnerHash === undefined) {
      await ctx.db.patch(receipts[0]!._id, { providerOwnerHash });
    }
    if (
      successLocatorHash !== undefined &&
      receipts[0]!.successLocatorHash !== undefined &&
      receipts[0]!.successLocatorHash !== successLocatorHash
    ) {
      return false;
    }
    if (
      successLocatorHash !== undefined &&
      receipts[0]!.successLocatorHash === undefined
    ) {
      await ctx.db.patch(receipts[0]!._id, { successLocatorHash });
    }
    // A later exact success for a tuple previously observed as not-created is
    // represented by the late-result ledger/projection. Do not reject or mark
    // that receipt as not-created here; the exhaustive proof below requires
    // the exact success hash to be explained by that immutable evidence.
    if (
      !succeeded &&
      receipts[0]!.successLocatorHash === undefined &&
      receipts[0]!.notCreatedTerminalized !== true
    ) {
      await ctx.db.patch(receipts[0]!._id, { notCreatedTerminalized: true });
    }
  }
  return await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation);
};
