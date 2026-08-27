import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { uiState } from "@/platform/ui-state";
import { BROWSER_PROFILE_KEY, BROWSER_SELECTION_KEY, DISCOVERY_CATEGORIES_CHANGED_EVENT, DISCOVERY_CATEGORIES_KEY, } from "@stella/contracts/discovery";
import { BROWSERS, DISCOVERY_CATEGORIES, } from "./onboarding-flow";
const createDiscoveryCategoryStates = () => {
    const initial = {};
    for (const category of DISCOVERY_CATEGORIES) {
        initial[category.id] = category.defaultEnabled;
    }
    return initial;
};
const getSelectedDiscoveryCategories = (states) => DISCOVERY_CATEGORIES.filter((category) => states[category.id]).map((category) => category.id);
const getFirstEnabledDiscoveryCategory = (states) => DISCOVERY_CATEGORIES.find((category) => states[category.id])?.id ?? null;
export function useOnboardingDiscovery({ isAuthenticated, onDiscoveryConfirm, onSelectionChange, phase, nextSplitStep, }) {
    const [browserEnabled, setBrowserEnabled] = useState(false);
    const [selectedBrowser, setSelectedBrowser] = useState(null);
    const [detectedBrowser, setDetectedBrowser] = useState(null);
    const [availableProfiles, setAvailableProfiles] = useState([]);
    const [selectedProfile, setSelectedProfile] = useState(null);
    const [showNoneWarning, setShowNoneWarning] = useState(false);
    const [activeMockId, setActiveMockId] = useState(null);
    const [categoryStates, setCategoryStates] = useState(createDiscoveryCategoryStates);
    const savePreferredBrowser = useMutation(api.data.preferences.setPreferredBrowser);
    useEffect(() => {
        if (!browserEnabled || detectedBrowser) {
            return;
        }
        let cancelled = false;
        const detectBrowser = async () => {
            try {
                const detected = await window.electronAPI?.discovery.detectPreferred?.();
                if (cancelled || !detected?.browser) {
                    return;
                }
                const supportedBrowserIds = new Set(BROWSERS.map((browser) => browser.id));
                const detectedId = detected.browser;
                if (!supportedBrowserIds.has(detectedId)) {
                    return;
                }
                setDetectedBrowser(detectedId);
                setSelectedBrowser(detectedId);
            }
            catch {

            }
        };
        void detectBrowser();
        return () => {
            cancelled = true;
        };
    }, [browserEnabled, detectedBrowser]);
    useEffect(() => {
        if (!selectedBrowser) {
            return;
        }
        let cancelled = false;
        const loadProfiles = async () => {
            try {
                const profiles = await window.electronAPI?.discovery.listProfiles?.(selectedBrowser);
                if (!cancelled && profiles) {
                    setAvailableProfiles(profiles);
                    setSelectedProfile((currentProfile) => {
                        if (currentProfile &&
                            profiles.some((profile) => profile.id === currentProfile)) {
                            return currentProfile;
                        }
                        return profiles.length > 0 ? profiles[0].id : null;
                    });
                }
            }
            catch {
                if (!cancelled) {
                    setAvailableProfiles([]);
                    setSelectedProfile(null);
                }
            }
        };
        void loadProfiles();
        return () => {
            cancelled = true;
        };
    }, [selectedBrowser]);
    const confirmDiscovery = useCallback(() => {
        const selected = getSelectedDiscoveryCategories(categoryStates);
        const nothingSelected = selected.length === 0 && !browserEnabled;
        if (nothingSelected && !showNoneWarning) {
            setShowNoneWarning(true);
            return;
        }
        uiState.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(selected));
        window.dispatchEvent(new Event(DISCOVERY_CATEGORIES_CHANGED_EVENT));
        if (browserEnabled && selectedBrowser) {
            uiState.setItem(BROWSER_SELECTION_KEY, selectedBrowser);
            if (selectedProfile) {
                uiState.setItem(BROWSER_PROFILE_KEY, selectedProfile);
            }
            else {
                uiState.removeItem(BROWSER_PROFILE_KEY);
            }
        }
        else {
            uiState.removeItem(BROWSER_SELECTION_KEY);
            uiState.removeItem(BROWSER_PROFILE_KEY);
        }
        if (isAuthenticated) {
            const preferredBrowser = browserEnabled && selectedBrowser ? selectedBrowser : "none";
            void savePreferredBrowser({
                browser: preferredBrowser,
            }).catch(() => {

            });
        }
        onDiscoveryConfirm?.(selected);
        nextSplitStep();
    }, [
        browserEnabled,
        categoryStates,
        isAuthenticated,
        nextSplitStep,
        onDiscoveryConfirm,
        savePreferredBrowser,
        selectedBrowser,
        selectedProfile,
        showNoneWarning,
    ]);
    const toggleCategory = useCallback((id) => {
        const wasEnabled = categoryStates[id];
        const nextCategoryStates = { ...categoryStates, [id]: !wasEnabled };
        setCategoryStates(nextCategoryStates);
        setShowNoneWarning(false);
        if (phase === "browser") {
            onSelectionChange?.(Object.values(nextCategoryStates).some(Boolean) || browserEnabled);
        }
        if (!wasEnabled) {
            setActiveMockId(id);
        }
        else if (activeMockId === id) {
            setActiveMockId(browserEnabled
                ? "browser"
                : getFirstEnabledDiscoveryCategory(nextCategoryStates));
        }
    }, [
        activeMockId,
        browserEnabled,
        categoryStates,
        onSelectionChange,
        phase,
    ]);
    const toggleBrowser = useCallback(() => {
        const wasEnabled = browserEnabled;
        setBrowserEnabled((current) => !current);
        setShowNoneWarning(false);
        if (phase === "browser") {
            onSelectionChange?.(!wasEnabled || Object.values(categoryStates).some(Boolean));
        }
        if (wasEnabled) {
            setSelectedBrowser(null);
            setDetectedBrowser(null);
            setAvailableProfiles([]);
            setSelectedProfile(null);
            if (activeMockId === "browser") {
                setActiveMockId(getFirstEnabledDiscoveryCategory(categoryStates));
            }
            return;
        }
        setActiveMockId("browser");
    }, [
        activeMockId,
        browserEnabled,
        categoryStates,
        onSelectionChange,
        phase,
    ]);
    const selectBrowser = useCallback((browserId) => {
        setAvailableProfiles([]);
        setSelectedProfile(null);
        setSelectedBrowser(browserId);
    }, []);
    const hasSelections = Object.values(categoryStates).some(Boolean) || browserEnabled;
    return {
        activeMockId,
        availableProfiles,
        browserEnabled,
        categoryStates,
        hasSelections,
        selectedBrowser,
        selectedProfile,
        showNoneWarning,
        confirmDiscovery,
        selectBrowser,
        setSelectedProfile,
        toggleBrowser,
        toggleCategory,
    };
}
