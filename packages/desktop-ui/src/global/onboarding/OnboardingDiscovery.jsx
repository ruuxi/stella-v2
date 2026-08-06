import React from "react";
import { DISCOVERY_CATEGORIES } from "./onboarding-flow";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";
import { useT } from "@/shared/i18n";
export const OnboardingDiscovery = ({ categoryStates, onToggleCategory, }) => {
    const t = useT();
    return (<div className="onboarding-discovery" data-visible={true}>
      <div className="onboarding-discovery-list">
        {DISCOVERY_CATEGORIES.map((cat) => (<OnboardingSelectionTile key={cat.id} className="onboarding-discovery-row" labelClassName="onboarding-discovery-row-label" descriptionClassName="onboarding-discovery-row-desc" active={categoryStates[cat.id]} onClick={() => onToggleCategory(cat.id)} label={t(cat.labelKey)} description={t(cat.descriptionKey)}/>))}
      </div>
    </div>);
};
