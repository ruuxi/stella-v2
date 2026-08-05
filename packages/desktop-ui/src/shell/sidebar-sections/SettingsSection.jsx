import { lazy, Suspense, useCallback, useEffect, useState, } from "react";
import { sidebarSections, useActiveSidebarSection, useSidebarSections, } from "@/features/workspace-display/sidebar-sections";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { useFeedbackPrompt } from "@/shell/sidebar/use-feedback-prompt";
import { getVisibleSettingsDestinations, isSettingsLocation, SETTINGS_DESTINATIONS, } from "./settings-navigation";
import { ArrowLeft, ChevronRight } from "@/ui/icons";
import "./settings-section.css";
const SettingsScreen = lazy(() => import("@/global/settings/SettingsView").then((module) => ({
    default: module.SettingsScreen,
})));
const ConnectPanel = lazy(() => import("@/global/integrations/ConnectDialog").then((module) => ({
    default: module.ConnectPanel,
})));
const FeedbackPanel = lazy(() => import("@/shell/sidebar/FeedbackDialog").then((module) => ({
    default: module.FeedbackPanel,
})));
const BillingPanel = lazy(() => import("@/global/billing/BillingScreen").then((module) => ({
    default: module.BillingPanel,
})));
export function SettingsSection() {
    const active = useActiveSidebarSection() === "settings";
    const location = useSidebarSections().locations.settings;
    const { hasConnectedAccount } = useAuthSessionState();
    const [hasOpened, setHasOpened] = useState(active);
    const connectHint = usePostOnboardingHint("connect");
    const { acknowledge: acknowledgeFeedbackPrompt } = useFeedbackPrompt();
    useEffect(() => {
        if (active)
            setHasOpened(true);
    }, [active]);
    useEffect(() => {
        if (location !== null && !isSettingsLocation(location)) {
            sidebarSections.clearLocation("settings");
        }
    }, [location]);
    useEffect(() => {
        if (!hasConnectedAccount && location === "billing") {
            sidebarSections.clearLocation("settings");
        }
    }, [hasConnectedAccount, location]);
    const handleSignOut = useCallback(() => {
        void secureSignOut();
    }, []);
    const handleOpen = useCallback((next) => {
        if (next === "connect" && connectHint.active)
            connectHint.dismiss();
        sidebarSections.setLocation("settings", next);
    }, [connectHint]);
    const handleBack = useCallback(() => {
        sidebarSections.clearLocation("settings");
    }, []);
    if (!hasOpened && !active)
        return null;
    const resolvedLocation = isSettingsLocation(location) &&
        (hasConnectedAccount || location !== "billing")
        ? location
        : null;
    const visibleHomeItems = getVisibleSettingsDestinations(hasConnectedAccount);
    const detailTitle = SETTINGS_DESTINATIONS.find((item) => item.id === resolvedLocation)?.label;
    return (<div className="settings-section-view">
      {resolvedLocation === null ? (<div className="settings-section-home">
          <div className="settings-section-home__title">Settings</div>
          <div className="settings-section-home__list">
            {visibleHomeItems.map(({ id, label, description, Icon }) => (<button key={id} type="button" className="settings-section-home__item" onClick={() => handleOpen(id)}>
                <span className="settings-section-home__item-icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75}/>
                </span>
                <span className="settings-section-home__item-copy">
                  <span className="settings-section-home__item-label">
                    {label}
                  </span>
                  <span className="settings-section-home__item-description">
                    {description}
                  </span>
                </span>
                <ChevronRight size={15} strokeWidth={1.75} aria-hidden="true"/>
              </button>))}
          </div>
        </div>) : (<>
          <header className="settings-section-detail__header">
            <button type="button" className="settings-section-detail__back" onClick={handleBack} aria-label="Back to Settings" title="Back to Settings">
              <ArrowLeft size={16} strokeWidth={1.75}/>
            </button>
            <span className="settings-section-detail__title">
              {detailTitle}
            </span>
          </header>
          <div className="settings-section-detail__body">
            <Suspense fallback={null}>
              {resolvedLocation === "settings" ? (<SettingsScreen embedded onSignOut={handleSignOut}/>) : resolvedLocation === "theme" ? (<ThemePicker inline/>) : resolvedLocation === "connect" ? (<ConnectPanel />) : resolvedLocation === "billing" ? (<BillingPanel />) : (<FeedbackPanel onDone={handleBack} onSubmitted={acknowledgeFeedbackPrompt}/>)}
            </Suspense>
          </div>
        </>)}
    </div>);
}
