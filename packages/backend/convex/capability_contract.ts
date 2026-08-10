/**
 * Backend mirror of `packages/contracts/capabilities.ts`.
 *
 * Convex bundles only from `convex/`, so the shared capability matrix cannot
 * be imported here — it is duplicated instead, exactly as
 * `stella_prompt_contract.ts` duplicates `contracts/stella-prompts.ts`.
 * `packages/backend/tests/capability-contract.test.ts` diffs the two and
 * fails if they drift, so the contract stays the single place a capability
 * is reshuffled between plans.
 *
 * This module is pure data + pure functions: no ctx, no auth, no billing.
 * The enforcement wrappers live in `lib/managed_billing.ts` (Convex
 * functions) and `http_shared/capability.ts` (HTTP routes).
 *
 * Every row here is enforced. Anything Pro is merely *marketed* with —
 * orchestrator mode, for instance, which any plan may use but which burns
 * enough usage that Pro is the sensible home for it — belongs in the
 * billing screen's presentational copy, not in this table.
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
 * Free and Go are text-only: assistant + coding agent. Everything
 * generative (image / video / voice / 3D) is what Pro sells — Pro's pitch
 * is capabilities, not a bigger token bucket.
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

/**
 * Which capability a media-catalog entry belongs to, or `null` when the
 * entry is not a generative surface at all.
 *
 * Keyed by capability id rather than by `MediaCapability.category` because
 * the category buckets transcription and stem-separation in with real
 * audio synthesis. Speech-to-text is an *input* path — it is how the
 * assistant hears you, not something it generates — so gating it behind
 * `audio_generation` would take dictation away from Go, which is meant to
 * be a full text assistant. Unlisted ids are ungated by design.
 */
const MEDIA_CAPABILITY_GATES: Record<string, Capability> = {
  text_to_image: "image_generation",
  icon: "image_generation",
  image_edit: "image_generation",
  text_to_video: "video_generation",
  image_to_video: "video_generation",
  video_extend: "video_generation",
  video_to_video: "video_generation",
  audio_generation: "audio_generation",
  text_to_music: "audio_generation",
  text_to_3d: "three_d_generation",
};

export const capabilityForMediaCapabilityId = (
  mediaCapabilityId: string,
): Capability | null => MEDIA_CAPABILITY_GATES[mediaCapabilityId] ?? null;
