import { getSynthesisPromptConfig } from "@/prompts";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type {
  OnboardingSynthesisResponse,
  OnboardingWelcomeHtmlResponse,
} from "@stella/contracts/desktop/onboarding";

type SynthesisResult = OnboardingSynthesisResponse;

type SynthesisRequestOptions = {
  includeAuth?: boolean;
  includeWelcomeHtml?: boolean;
};

export async function synthesizeCoreMemory(
  formattedSections: Partial<Record<DiscoveryCategory, string>>,
  options: SynthesisRequestOptions = {},
): Promise<SynthesisResult> {
  const onboardingApi = window.electronAPI?.onboarding;
  if (!onboardingApi?.synthesizeCoreMemory) {
    throw new Error(
      "Onboarding synthesis IPC is unavailable in this renderer context.",
    );
  }

  return await onboardingApi.synthesizeCoreMemory({
    formattedSections: formattedSections as Record<string, string>,
    promptConfig: getSynthesisPromptConfig() as Record<string, unknown>,
    includeAuth: options.includeAuth ?? true,
    includeWelcomeHtml: options.includeWelcomeHtml ?? true,
  });
}

export async function generateWelcomeHtml(
  coreMemory: string,
  options: Pick<SynthesisRequestOptions, "includeAuth"> = {},
): Promise<OnboardingWelcomeHtmlResponse> {
  const onboardingApi = window.electronAPI?.onboarding;
  if (!onboardingApi?.generateWelcomeHtml) {
    throw new Error(
      "Onboarding welcome HTML IPC is unavailable in this renderer context.",
    );
  }

  return await onboardingApi.generateWelcomeHtml({
    coreMemory,
    includeAuth: options.includeAuth ?? true,
  });
}
