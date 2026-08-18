/**
 * Which plan gets which capability — the single table the whole app reads.
 *
 * Tiers are differentiated by *what you can do*, not by how much of it you
 * can do: Go buys the coding agent and the text assistant, Pro adds the
 * generative surfaces (image / video / audio / 3D). Usage volume is a
 * separate axis owned by `billing_plans.ts` — a capability check answers
 * "is this surface yours at all", never "have you spent too much this week".
 *
 * Reshuffling the lineup is a one-file edit: flip a boolean in
 * `CAPABILITY_MATRIX` and the gates, the upgrade copy, and the toasts all
 * follow. Nothing downstream is allowed to hardcode a plan name.
 *
 * Every row here is enforced. Anything Pro is merely *marketed* with —
 * orchestrator mode, for instance, which any plan may use but which burns
 * enough usage that Pro is the sensible home for it — belongs in the
 * billing screen's presentational copy, not in this table. A matrix where
 * some rows gate and others are decorative is a trap: the next person to
 * read it cannot tell which is which, and wires up the wrong one.
 *
 * The Convex backend cannot import this package (it bundles only from
 * `convex/`), so it carries a byte-equivalent mirror in
 * `packages/backend/convex/capability_contract.ts` — the same arrangement
 * `stella-prompts.ts` has with `stella_prompt_contract.ts`. A parity test in
 * `packages/backend/tests/capability-contract.test.ts` fails the build if the
 * two drift.
 */

export const CAPABILITIES = [
  "image_generation",
  "video_generation",
  "audio_generation",
  "three_d_generation",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityAudience = "anonymous" | "free" | "go" | "pro";

/** Weakest plan first — `minimumPlanForCapability` walks this order. */
export const CAPABILITY_AUDIENCE_ORDER: readonly CapabilityAudience[] = [
  "anonymous",
  "free",
  "go",
  "pro",
];

/**
 * Free and Go include the assistant and coding workflows. Media generation
 * (image / video / voice / 3D) is what Pro adds; dictation and read-aloud are
 * all-plan features and therefore do not belong in this gate.
 */
export const CAPABILITY_MATRIX: Record<
  Capability,
  Record<CapabilityAudience, boolean>
> = {
  image_generation: {
    anonymous: false,
    free: false,
    go: false,
    pro: true,
  },
  video_generation: {
    anonymous: false,
    free: false,
    go: false,
    pro: true,
  },
  audio_generation: {
    anonymous: false,
    free: false,
    go: false,
    pro: true,
  },
  three_d_generation: {
    anonymous: false,
    free: false,
    go: false,
    pro: true,
  },
};

export const hasCapability = (
  audience: CapabilityAudience,
  capability: Capability,
): boolean => CAPABILITY_MATRIX[capability]?.[audience] === true;

/**
 * The cheapest audience that unlocks `capability`, or `null` when no plan
 * grants it (a capability switched off everywhere). Drives the
 * "upgrade to X" copy, so it must never be a hardcoded "pro".
 */
export const minimumPlanForCapability = (
  capability: Capability,
): CapabilityAudience | null =>
  CAPABILITY_AUDIENCE_ORDER.find((audience) =>
    hasCapability(audience, capability),
  ) ?? null;

export const isCapability = (value: unknown): value is Capability =>
  typeof value === "string" &&
  (CAPABILITIES as readonly string[]).includes(value);

/**
 * The backend's richer audience notion (`agent/model.ts`), which splits
 * paying users into "within budget" and "over budget" halves.
 */
export type ManagedCapabilityAudience =
  | CapabilityAudience
  | "go_fallback"
  | "pro_fallback";

/**
 * Collapse a managed audience onto the four the matrix is keyed by.
 *
 * The `_fallback` audiences mean "paying, but currently over the usage
 * cap" — that is a usage problem, not an entitlement one. A Pro user who
 * has burned through this week's budget still *has* image generation, so
 * they collapse onto their plan rather than dropping a tier. Callers get
 * this helper instead of each reimplementing the collapse and eventually
 * disagreeing about it.
 */
export const toCapabilityAudience = (
  audience: ManagedCapabilityAudience | null | undefined,
): CapabilityAudience | null => {
  switch (audience) {
    case "anonymous":
    case "free":
    case "go":
    case "pro":
      return audience;
    case "go_fallback":
      return "go";
    case "pro_fallback":
      return "pro";
    default:
      return null;
  }
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  image_generation: "Image generation",
  video_generation: "Video generation",
  audio_generation: "Audio generation",
  three_d_generation: "3D generation",
};

export const CAPABILITY_PLAN_LABELS: Record<CapabilityAudience, string> = {
  anonymous: "Free",
  free: "Free",
  go: "Go",
  pro: "Pro",
};

/**
 * Machine-readable code carried by every capability denial, on both the
 * HTTP envelope (`code`) and the `ConvexError` data payload.
 */
export const CAPABILITY_DENIED_CODE = "CAPABILITY_REQUIRED" as const;

/**
 * Stable marker appended to denial prose so a client that only ever sees a
 * flattened `Error.message` — which is all the runtime hands the renderer
 * once a relay response has been turned into a throw — can still recover
 * which capability was denied. See
 * `desktop-ui/src/features/chat/streaming/stella-provider-error-classifier.ts`.
 */
export const capabilityDenialMarker = (capability: Capability): string =>
  `[capability/${capability}]`;

/**
 * The wire shape of a denial. Everything the desktop needs to build its
 * toast — what was denied, who the caller is right now, and the cheapest
 * plan that would have allowed it — travels here, so no client has to
 * re-derive an entitlement decision the backend already made.
 */
export type CapabilityDenial = {
  code: typeof CAPABILITY_DENIED_CODE;
  capability: Capability;
  /** The caller's collapsed audience at denial time. */
  audience: CapabilityAudience;
  /** `null` when the capability is switched off for every plan. */
  minimumPlan: CapabilityAudience | null;
  message: string;
};

export const buildCapabilityDenial = (
  capability: Capability,
  audience: CapabilityAudience,
): CapabilityDenial => {
  const minimumPlan = minimumPlanForCapability(capability);
  const label = CAPABILITY_LABELS[capability];
  const marker = capabilityDenialMarker(capability);
  const message = minimumPlan
    ? `${label} requires the ${CAPABILITY_PLAN_LABELS[minimumPlan]} plan. ${marker}`
    : `${label} is not available on any plan right now. ${marker}`;
  return {
    code: CAPABILITY_DENIED_CODE,
    capability,
    audience,
    minimumPlan,
    message,
  };
};
