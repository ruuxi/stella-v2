export type StripeBillingLocatorKind =
  | "customer"
  | "subscription"
  | "payment_method"
  | "checkout_session";

const textEncoder = new TextEncoder();

export type StripePhysicalSuccessLocators = {
  stripeCustomerId?: string;
  stripeCheckoutSessionId?: string;
  stripePortalSessionId?: string;
};

export const stripePhysicalSuccessLocatorEnvelope = (
  args: StripePhysicalSuccessLocators,
) => ({
  ...(args.stripeCustomerId?.trim()
    ? { stripeCustomerId: args.stripeCustomerId.trim() }
    : {}),
  ...(args.stripeCheckoutSessionId?.trim()
    ? { stripeCheckoutSessionId: args.stripeCheckoutSessionId.trim() }
    : {}),
  ...(args.stripePortalSessionId?.trim()
    ? { stripePortalSessionId: args.stripePortalSessionId.trim() }
    : {}),
});

/**
 * Permanent success-result binding for one physical Stripe tuple. The
 * provider request tuple alone is insufficient after its owner operation is
 * deleted: the same callback bytes with changed provider locators must not be
 * accepted as a second resource. This hash deliberately matches the locator
 * hash used by audited manual resolutions.
 */
export const hashStripePhysicalSuccessLocators = async (
  args: StripePhysicalSuccessLocators,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(
      `stella-stripe-resolution-v1\u0000locator\u0000${JSON.stringify(
        stripePhysicalSuccessLocatorEnvelope(args),
      )}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const hashStripeRetainedLocatorSet = async (
  locators: ReadonlyArray<{
    locatorKind: "customer" | "checkout_session";
    locatorHash: string;
    ownerHash: string;
  }>,
): Promise<string> => {
  const normalized = locators
    .map((locator) => ({
      locatorKind: locator.locatorKind,
      locatorHash: locator.locatorHash.trim(),
      ownerHash: (locator.ownerHash ?? "").trim(),
    }))
    .sort((left, right) => {
      const leftKey = `${left.locatorKind}\u0000${left.locatorHash}\u0000${left.ownerHash}`;
      const rightKey = `${right.locatorKind}\u0000${right.locatorHash}\u0000${right.ownerHash}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(
      `stella:billing-retained-locators:v1\u0000${JSON.stringify(normalized)}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export type StripeHistoricalResultFields = {
  lastStripeStep?: string;
  lastStripeAttemptId?: string;
  lastStripeRequestFingerprint?: string;
  lastStripeIdempotencyKey?: string;
  lastStripeProviderDeadlineAt?: number;
  lastStripeReconcileClaimId?: string;
  lastStripeDisposition?: string;
};

/**
 * One shared rolling-upgrade shape rule for the last physical Stripe result.
 * A disposition or reconcile claim is authority too, so neither may survive
 * without the complete five-field physical tuple. Conversely, a tuple without
 * its disposition has an unknown outcome and must fail closed.
 */
export const stripeHistoricalResultShape = (
  row: StripeHistoricalResultFields,
): "clean" | "complete" | "malformed" => {
  const values = [
    row.lastStripeStep,
    row.lastStripeAttemptId,
    row.lastStripeRequestFingerprint,
    row.lastStripeIdempotencyKey,
    row.lastStripeProviderDeadlineAt,
    row.lastStripeReconcileClaimId,
    row.lastStripeDisposition,
  ];
  if (values.every((value) => value === undefined)) return "clean";
  const validStep =
    row.lastStripeStep === "customer_create" ||
    row.lastStripeStep === "checkout_create" ||
    row.lastStripeStep === "portal_create";
  const validDisposition =
    row.lastStripeDisposition === "succeeded" ||
    row.lastStripeDisposition === "not_created";
  const validClaim =
    row.lastStripeReconcileClaimId === undefined ||
    row.lastStripeReconcileClaimId.trim().length > 0;
  return validStep &&
    Boolean(row.lastStripeAttemptId?.trim()) &&
    Boolean(row.lastStripeRequestFingerprint?.trim()) &&
    Boolean(row.lastStripeIdempotencyKey?.trim()) &&
    Number.isSafeInteger(row.lastStripeProviderDeadlineAt) &&
    validDisposition &&
    validClaim
    ? "complete"
    : "malformed";
};

/**
 * One-way suppression key for Stripe locators retained after account deletion.
 * The versioned domain separator prevents this digest from being confused with
 * hashes used by any other subsystem.
 */
export const hashStripeBillingLocator = async (
  kind: StripeBillingLocatorKind,
  value: string,
): Promise<string> => {
  const normalized = value.trim();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`stella:billing-delete:v1:${kind}:${normalized}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/**
 * Hash-minimized exact physical Stripe tuple retained after permanent account
 * deletion. It lets a platform-suspended action publish a late provider
 * locator into autonomous cleanup without retaining the deleted owner ID,
 * generation, provider key, or request bytes.
 */
export const hashStripeDeletedOperationTuple = async (args: {
  operationId: string;
  attemptId: string;
  step: "customer_create" | "checkout_create" | "portal_create";
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
}): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(
      [
        "stella:billing-deleted-operation:v1",
        args.operationId.trim(),
        args.attemptId.trim(),
        args.step,
        args.requestFingerprint.trim(),
        args.idempotencyKey.trim(),
        String(args.providerDeadlineAt),
      ].join("\u0000"),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
