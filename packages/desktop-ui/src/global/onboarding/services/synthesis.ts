/**
 * Core Memory Synthesis Service
 *
 * Delegates synthesis through Electron host IPC, which runs the model work
 * on this device through the runtime.
 */

import { getSynthesisPromptConfig } from "@/prompts";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type { OnboardingSynthesisResponse } from "@stella/contracts/desktop/onboarding";

export async function synthesizeCoreMemory(
  formattedSections: Partial<Record<DiscoveryCategory, string>>,
): Promise<OnboardingSynthesisResponse> {
  const onboardingApi = window.electronAPI?.onboarding;
  if (!onboardingApi?.synthesizeCoreMemory) {
    throw new Error(
      "Onboarding synthesis IPC is unavailable in this renderer context.",
    );
  }

  return await onboardingApi.synthesizeCoreMemory({
    formattedSections: formattedSections as Record<string, string>,
    promptConfig: getSynthesisPromptConfig(),
  });
}
