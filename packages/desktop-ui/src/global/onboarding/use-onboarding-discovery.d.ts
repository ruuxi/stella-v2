import type { Dispatch, SetStateAction } from "react";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type { BrowserId, Phase } from "./onboarding-flow";

type OnboardingDiscoveryOptions = {
  isAuthenticated?: boolean;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
  phase: Phase;
  nextSplitStep: () => void;
};

export declare function useOnboardingDiscovery(
  options: OnboardingDiscoveryOptions,
): {
  activeMockId: DiscoveryCategory | "browser" | null;
  availableProfiles: { id: string; name: string }[];
  browserEnabled: boolean;
  categoryStates: Record<DiscoveryCategory, boolean>;
  hasSelections: boolean;
  selectedBrowser: BrowserId | null;
  selectedProfile: string | null;
  showNoneWarning: boolean;
  confirmDiscovery: () => void;
  selectBrowser: (browserId: BrowserId) => void;
  setSelectedProfile: Dispatch<SetStateAction<string | null>>;
  toggleBrowser: () => void;
  toggleCategory: (id: DiscoveryCategory) => void;
};
