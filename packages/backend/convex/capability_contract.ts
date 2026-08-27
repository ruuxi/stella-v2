export const CAPABILITIES = [
  "image_generation",
  "video_generation",
  "audio_generation",
  "three_d_generation",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityAudience = "anonymous" | "free" | "go" | "pro";

export const CAPABILITY_AUDIENCE_ORDER: readonly CapabilityAudience[] = [
  "anonymous",
  "free",
  "go",
  "pro",
];

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

export const minimumPlanForCapability = (
  capability: Capability,
): CapabilityAudience | null =>
  CAPABILITY_AUDIENCE_ORDER.find((audience) =>
    hasCapability(audience, capability),
  ) ?? null;

export const isCapability = (value: unknown): value is Capability =>
  typeof value === "string" &&
  (CAPABILITIES as readonly string[]).includes(value);

export type ManagedCapabilityAudience =
  | CapabilityAudience
  | "go_fallback"
  | "pro_fallback";

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

export const CAPABILITY_DENIED_CODE = "CAPABILITY_REQUIRED" as const;

export const capabilityDenialMarker = (capability: Capability): string =>
  `[capability/${capability}]`;

export type CapabilityDenial = {
  code: typeof CAPABILITY_DENIED_CODE;
  capability: Capability;

  audience: CapabilityAudience;

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
