import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, KeyRound, Lightbulb, LogIn, LogOut, RefreshCw, Search, Star, X, } from "@/ui/icons";
import { BrandIcon } from "@/ui/brand-icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, } from "@/ui/dropdown-menu";
import { readEngineModelFavorites, sortByFavorites, toggleEngineModelFavorite, } from "@/features/workspace-display/engine-model-favorites";
import {
  getStellaResolvedModelName,
  searchCatalogModels,
  type CatalogModel,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import {
  compareProviderRailOrder,
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
  type LlmProviderEntry,
} from "@/global/settings/lib/llm-providers";
import { findApiKey, findOauthCredential, findOauthProvider, useLlmCredentials, } from "@/global/settings/hooks/use-llm-credentials";
import { useT } from "@/shared/i18n";
import "./ProviderModelPicker.css";
export type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  labelKey: string;
}> = [
    { id: "default", labelKey: "settings.modelPicker.reasoning.default" },
    { id: "minimal", labelKey: "settings.modelPicker.reasoning.minimal" },
    { id: "low", labelKey: "settings.modelPicker.reasoning.low" },
    { id: "medium", labelKey: "settings.modelPicker.reasoning.medium" },
    { id: "high", labelKey: "settings.modelPicker.reasoning.high" },
    { id: "xhigh", labelKey: "settings.modelPicker.reasoning.xhigh" },
];
const STELLA_PROVIDER_KEY = "stella";
const LOCAL_PROVIDER_KEY = "local";
const OPENROUTER_PROVIDER_KEY = "openrouter";
const DEFAULT_TARGET = "__default__";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
export type ProviderTab = {
  key: string;
  label: string;
  models: CatalogModel[];
  llmEntry: LlmProviderEntry | undefined;
  runtimeManaged: boolean;
  runtimeManagedAuth: boolean;
  runtimeCredentialless: boolean;
};

type HeaderActionDescriptor = {
  connect: {
    label: string;
    onClick: () => void;
    disabled: boolean | undefined;
  } | null;
  signOut: {
    armed: boolean | undefined;
    disabled: boolean | undefined;
    label: string;
    title: string;
    onClick: () => void;
  } | null;
};

export type ProviderModelExtraSection = {
  key: string;
  label: string;
  brandKey?: string;
  badge?: string;
  selected?: boolean;
  content: () => ReactNode;
};

export interface ProviderModelPanelProps {
  value: string;
  defaultLabel: string;
  currentLabel: string;
  groups: readonly ProviderGroup[];
  onSelect: (value: string, anchor?: HTMLElement) => void;
  disabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  onSelectReasoning?: (modelId: string, effort: ReasoningEffort) => void;
  restrictStellaPicks?: boolean;
  restrictedPlanLabel?: string | null;
  ariaLabel?: string;
  hideDefaultRow?: boolean;
  selectedHeaderKicker?: string;
  hideSelectedTitle?: boolean;
  hideSearch?: boolean;
  hideSelectionCheck?: boolean;
  disableNonStellaProviders?: boolean;
  disabledProviderReason?: string;
  hideProviderLabel?: boolean;
  visibleProviders?: readonly string[];
  hiddenProviders?: readonly string[];
  favoriteScope?: string;
  hideGroupHead?: boolean;
  headerActionsTarget?: (descriptor: HeaderActionDescriptor | null) => void;
  authOpenRequest?: number;
  onRequestSearchClose?: () => void;
  collapsibleGroups?: boolean;
  activeSectionKey?: string | null;
  extraSections?: readonly ProviderModelExtraSection[];
  sectionOrder?: readonly string[] | null;
  onExtraSectionExpanded?: (sectionKey: string, open: boolean) => void;
  onRefresh?: () => void;
  refreshing?: boolean;

  catalogError?: string | null;
  selectedRowExtra?: ReactNode;
}

const normalizeResolvedModelId = (modelId: string): string => modelId.trim().replace(/^stella\//, "").toLowerCase();
const resolvedModelIdentity = (model: CatalogModel): string => normalizeResolvedModelId(model.upstreamModel || getStellaResolvedModelName(model));
const modelMatchesDefault = (model: CatalogModel, defaultModel: string): boolean => Boolean(defaultModel) &&
    (model.id === defaultModel ||
        resolvedModelIdentity(model) === normalizeResolvedModelId(defaultModel) ||
        getStellaResolvedModelName(model).trim().toLowerCase() ===
            defaultModel.trim().toLowerCase());
const dedupeStellaModels = (models: readonly CatalogModel[], selectedModelId: string): CatalogModel[] => {
    const byResolvedModel = new Map<string, CatalogModel>();
    for (const model of models) {
        const identity = resolvedModelIdentity(model);
        const existing = byResolvedModel.get(identity);
        if (!existing ||
            model.id === selectedModelId ||
            (existing.id !== selectedModelId &&
                existing.allowedForAudience === false &&
                model.allowedForAudience !== false)) {
            byResolvedModel.set(identity, model);
        }
    }
    return Array.from(byResolvedModel.values());
};
export const providerUsesRuntimeManagedAuth = (tab: Pick<ProviderTab, "runtimeManagedAuth" | "runtimeCredentialless">): boolean => tab.runtimeManagedAuth || tab.runtimeCredentialless;
export function buildProviderTabs(groups: readonly ProviderGroup[], visibleProviders?: readonly string[], hiddenProviders?: readonly string[]): ProviderTab[] {
    const tabs = new Map<string, ProviderTab>();
    for (const entry of LLM_PROVIDERS) {
        if (visibleProviders && !visibleProviders.includes(entry.key)) {
            continue;
        }
        if (hiddenProviders?.includes(entry.key)) {
            continue;
        }
        tabs.set(entry.key, {
            key: entry.key,
            label: entry.label,
            models: [],
            llmEntry: entry,
            runtimeManaged: false,
            runtimeManagedAuth: false,
            runtimeCredentialless: false,
        });
    }
    for (const group of groups) {
        if (visibleProviders && !visibleProviders.includes(group.provider)) {
            continue;
        }
        if (hiddenProviders?.includes(group.provider)) {
            continue;
        }
        const models = group.models;
        tabs.set(group.provider, {
            key: group.provider,
            label: group.providerName,
            models,
            llmEntry: LLM_PROVIDERS.find((entry) => entry.key === group.provider),
            runtimeManaged: group.runtimeManaged,
            runtimeManagedAuth: group.runtimeManagedAuth,
            runtimeCredentialless: group.runtimeCredentialless,
        });
    }
    return Array.from(tabs.values()).sort((a, b) => compareProviderRailOrder(a.key, b.key, a.label, b.label));
}
export function ProviderModelPanel({ value, defaultLabel, currentLabel, groups, onSelect, disabled = false, reasoningEffort, onSelectReasoning, restrictStellaPicks = false, restrictedPlanLabel, ariaLabel, hideDefaultRow = false, selectedHeaderKicker, hideSelectedTitle = false, hideSearch = false, hideSelectionCheck = false, disableNonStellaProviders = false, disabledProviderReason, hideProviderLabel = false, visibleProviders, hiddenProviders, favoriteScope, hideGroupHead = false, headerActionsTarget, authOpenRequest = 0, onRequestSearchClose, collapsibleGroups = false, activeSectionKey = null, extraSections = [], sectionOrder = null, onExtraSectionExpanded, onRefresh, refreshing = false, catalogError = null, selectedRowExtra = null, }: ProviderModelPanelProps) {
    const t = useT();
    const credentials = useLlmCredentials();
    const cancelOAuth = credentials.cancelOAuth;
    const tabs = useMemo(() => buildProviderTabs(groups, visibleProviders, hiddenProviders), [groups, hiddenProviders, visibleProviders]);
    const [favorites, setFavorites] = useState<string[]>(() => favoriteScope ? readEngineModelFavorites(favoriteScope) : []);
    const disabledProviderSet = useMemo(() => new Set(disableNonStellaProviders
        ? tabs
            .map((tab) => tab.key)
            .filter((key) => key !== STELLA_PROVIDER_KEY)
        : []), [disableNonStellaProviders, tabs]);
    const [query, setQuery] = useState("");

    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchVisible = !hideSearch;
    useEffect(() => {
        if (searchVisible)
            searchInputRef.current?.focus();
    }, [searchVisible]);

    const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
    const [draftKey, setDraftKey] = useState("");
    const [savingProvider, setSavingProvider] = useState<string | null>(null);
    const [oauthProvider, setOauthProvider] = useState<string | null>(null);
    const oauthAttemptRef = useRef<{ provider: string; cancelled: boolean } | null>(null);
    const [authError, setAuthError] = useState<string | null>(null);
    const [openRouterCustomId, setOpenRouterCustomId] = useState("");
    const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
    const [localModelId, setLocalModelId] = useState("");
    const sections = useMemo(() => {
        const trimmed = hideSearch ? "" : query.trim();
        const result: Array<{ tab: ProviderTab; models: CatalogModel[] }> = [];
        for (const tab of tabs) {
            const searched = trimmed
                ? searchCatalogModels(tab.models, trimmed)
                : tab.models;
            const sorted = favoriteScope
                ? sortByFavorites(searched, favorites)
                : searched;
            let visibleModels = tab.key === STELLA_PROVIDER_KEY
                ? dedupeStellaModels(sorted, value)
                : sorted;

            if (tab.key === OPENROUTER_PROVIDER_KEY &&
                value.startsWith(`${OPENROUTER_PROVIDER_KEY}/`) &&
                !tab.models.some((model) => model.id === value) &&
                (!trimmed ||
                    value.toLowerCase().includes(trimmed.toLowerCase()))) {
                const customSlug = value.slice(`${OPENROUTER_PROVIDER_KEY}/`.length);
                const customModel: CatalogModel = {
                    id: value,
                    name: customSlug,
                    provider: OPENROUTER_PROVIDER_KEY,
                    providerName: tab.label,
                    modelId: customSlug,
                    source: "local",
                };
                visibleModels = [customModel, ...visibleModels];
            }

            if (trimmed && visibleModels.length === 0)
                continue;
            result.push({ tab, models: visibleModels });
        }
        return result;
    }, [tabs, favoriteScope, favorites, hideSearch, query, value]);
    const toggleFavorite = useCallback((modelId: string) => {
        if (!favoriteScope)
            return;
        setFavorites(toggleEngineModelFavorite(favoriteScope, modelId));
    }, [favoriteScope]);

    const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(activeSectionKey ? [activeSectionKey] : []));
    useEffect(() => {
        if (!activeSectionKey)
            return;
        setOpenSections((current) => {
            if (current.has(activeSectionKey))
                return current;
            const next = new Set(current);
            next.add(activeSectionKey);
            return next;
        });
    }, [activeSectionKey]);
    const toggleSection = useCallback((sectionKey: string, isExtra: boolean) => {
        const opening = !openSections.has(sectionKey);
        setOpenSections((current) => {
            const next = new Set(current);
            if (opening) {
                next.add(sectionKey);
            }
            else {
                next.delete(sectionKey);
            }
            return next;
        });
        if (isExtra)
            onExtraSectionExpanded?.(sectionKey, opening);
    }, [onExtraSectionExpanded, openSections]);
    const handlePick = useCallback((modelId: string, anchor?: HTMLElement) => {
        if (disabled)
            return;
        onSelect(modelId === DEFAULT_TARGET ? "" : modelId, anchor);
    }, [disabled, onSelect]);
    const cancelPendingOAuth = useCallback(async (providerKey?: string | null) => {
        const attempt = oauthAttemptRef.current;
        if (!attempt || (providerKey && attempt.provider !== providerKey))
            return;
        attempt.cancelled = true;
        setOauthProvider((current) => current === attempt.provider ? null : current);
        await cancelOAuth(attempt.provider);
    }, [cancelOAuth]);
    const toggleExpanded = useCallback((providerKey: string | null) => {
        const pendingProvider = oauthAttemptRef.current?.provider;
        if (pendingProvider && pendingProvider !== providerKey) {
            void cancelPendingOAuth(pendingProvider);
        }
        setExpandedProvider(providerKey);

        if (providerKey && collapsibleGroups) {
            setOpenSections((current) => current.has(providerKey)
                ? current
                : new Set(current).add(providerKey));
        }
        setDraftKey("");
        setAuthError(null);
    }, [cancelPendingOAuth, collapsibleGroups]);
    useEffect(() => () => {
        const attempt = oauthAttemptRef.current;
        if (attempt) {
            attempt.cancelled = true;
            void cancelOAuth(attempt.provider);
        }
    }, [cancelOAuth]);
    useEffect(() => {
        const pendingProvider = oauthAttemptRef.current?.provider;
        if (pendingProvider && !tabs.some((tab) => tab.key === pendingProvider)) {
            void cancelPendingOAuth(pendingProvider);
        }
    }, [cancelPendingOAuth, tabs]);

    const [signOutArmed, setSignOutArmed] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState<string | null>(null);
    const signOutTimerRef = useRef<number | null>(null);
    const handleSignOut = useCallback(async (providerKey: string) => {
        if (signOutArmed !== providerKey) {
            setSignOutArmed(providerKey);
            if (signOutTimerRef.current) {
                window.clearTimeout(signOutTimerRef.current);
            }
            signOutTimerRef.current = window.setTimeout(() => setSignOutArmed(null), 3000);
            return;
        }
        if (signOutTimerRef.current) {
            window.clearTimeout(signOutTimerRef.current);
            signOutTimerRef.current = null;
        }
        setSignOutArmed(null);
        setSigningOut(providerKey);
        try {
            if (findApiKey(credentials.apiKeys, providerKey)) {
                await credentials.removeApiKey(providerKey);
            }
            if (findOauthCredential(credentials.oauthCredentials, providerKey)) {
                await credentials.logoutOAuth(providerKey);
            }
        }
        catch {

        }
        finally {
            setSigningOut(null);
        }
    }, [credentials.apiKeys, credentials.oauthCredentials, credentials.logoutOAuth, credentials.removeApiKey, signOutArmed]);
    const handleSaveKey = useCallback(async (providerKey: string, label: string) => {
        const trimmed = draftKey.trim();
        if (!trimmed)
            return;
        setSavingProvider(providerKey);
        setAuthError(null);
        try {
            await credentials.saveApiKey(providerKey, label, trimmed);
            setDraftKey("");
            setExpandedProvider(null);
        }
        catch (caught) {
            setAuthError(caught instanceof Error
                ? caught.message
                : t("settings.modelPicker.errors.saveApiKey"));
        }
        finally {
            setSavingProvider(null);
        }
    }, [credentials, draftKey, t]);
    const handleLoginOAuth = useCallback(async (providerKey: string) => {
        const previousAttempt = oauthAttemptRef.current;
        if (previousAttempt) {
            await cancelPendingOAuth(previousAttempt.provider);
        }
        const attempt = { provider: providerKey, cancelled: false };
        oauthAttemptRef.current = attempt;
        setOauthProvider(providerKey);
        setAuthError(null);
        try {
            await credentials.loginOAuth(providerKey);
            if (!attempt.cancelled) {
                setExpandedProvider(null);
            }
        }
        catch (caught) {
            if (!attempt.cancelled) {
                setAuthError(caught instanceof Error
                    ? caught.message
                    : t("settings.modelPicker.errors.oauthLogin"));
            }
        }
        finally {
            if (oauthAttemptRef.current === attempt) {
                oauthAttemptRef.current = null;
                setOauthProvider(null);
            }
        }
    }, [cancelPendingOAuth, credentials, t]);
    const handleSubmitOpenRouter = useCallback(() => {
        const trimmed = openRouterCustomId.trim();
        if (!trimmed)
            return;
        const fullId = trimmed.startsWith("openrouter/")
            ? trimmed
            : `openrouter/${trimmed}`;
        onSelect(fullId);
    }, [onSelect, openRouterCustomId]);
    const handleSubmitLocal = useCallback(() => {
        const modelId = localModelId.trim();
        if (!modelId)
            return;
        const baseUrl = localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL;
        const encodedBaseUrl = encodeURIComponent(baseUrl);
        onSelect(modelId.startsWith(`${LOCAL_PROVIDER_KEY}/`)
            ? modelId
            : `${LOCAL_PROVIDER_KEY}/${encodedBaseUrl}/${modelId}`);
    }, [localBaseUrl, localModelId, onSelect]);
    const trimmedQuery = query.trim();
    const isDefaultSelected = !value;

    const inlineProviderActions = searchVisible && hideSelectedTitle && hideProviderLabel && tabs.length === 1;
    const renderSearchBar = () => (<div className="model-picker-search">
        <Search size={13} strokeWidth={1.75} aria-hidden/>
        <input ref={searchInputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Escape") {
                setQuery("");
                onRequestSearchClose?.();
            }
        }} placeholder={t("settings.modelPicker.searchPlaceholder")} spellCheck={false} autoComplete="off" aria-label={t("settings.modelPicker.searchAriaLabel")} disabled={disabled}/>
        {onRequestSearchClose ? (<button type="button" className="model-picker-search-close" aria-label={t("settings.modelPicker.closeSearch")} onClick={() => {
                setQuery("");
                onRequestSearchClose();
            }}>
            <X size={13} strokeWidth={1.75} aria-hidden/>
          </button>) : null}
      </div>);
    const getSectionContext = (tab: ProviderTab) => {
        const isStella = tab.key === STELLA_PROVIDER_KEY;
        const isLocal = tab.key === LOCAL_PROVIDER_KEY;
        const isOpenRouter = tab.key === "openrouter";
        const apiKey = findApiKey(credentials.apiKeys, tab.key);
        const oauthCred = findOauthCredential(credentials.oauthCredentials, tab.key);
        const oauthEntry = findOauthProvider(credentials.oauthProviders, tab.key);
        const llmEntry = tab.llmEntry ??
            (!isStella
                ? {
                    key: tab.key,
                    label: tab.label,
                    placeholder: t("settings.modelPicker.apiKeyPlaceholder"),
                }
                : undefined);
        const connected = isStella || Boolean(apiKey) || Boolean(oauthCred);

        const usesRuntimeManagedAuth = providerUsesRuntimeManagedAuth(tab);
        const requiresAuth = !isStella &&
            !isLocal &&
            !usesRuntimeManagedAuth &&
            !connected &&
            Boolean(llmEntry);
        const supportsApiKey = Boolean(llmEntry) &&
            !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");
        const supportsOAuth = Boolean(oauthEntry);
        const sectionDisabled = disabled || disabledProviderSet.has(tab.key);
        const removable = Boolean(apiKey) || Boolean(oauthCred);
        const armed = signOutArmed === tab.key;
        const isSigningOut = signingOut === tab.key;
        const expanded = expandedProvider === tab.key;

        const hasCustomInputs = isLocal || isOpenRouter;
        const authDescription = supportsOAuth && supportsApiKey
            ? t("settings.modelPicker.authHint.both")
            : supportsOAuth
                ? t("settings.modelPicker.authHint.oauth")
                : t("settings.modelPicker.authHint.apiKey");
        return {
            tab,
            isStella,
            isLocal,
            isOpenRouter,
            llmEntry,
            requiresAuth,
            supportsApiKey,
            supportsOAuth,
            sectionDisabled,
            removable,
            armed,
            isSigningOut,
            expanded,
            hasCustomInputs,
            authDescription,
        };
    };
    const renderGroupActions = ({ tab, requiresAuth, supportsOAuth, sectionDisabled, removable, armed, isSigningOut, expanded, hasCustomInputs, }: ReturnType<typeof getSectionContext>) => requiresAuth ? (<button type="button" className="model-picker-group-connect" data-open={expanded || undefined} onClick={() => toggleExpanded(expanded ? null : tab.key)} disabled={sectionDisabled}>
        {expanded
            ? t("settings.modelPicker.actions.cancel")
            : supportsOAuth
                ? t("settings.modelPicker.actions.signIn")
                : t("settings.modelPicker.actions.addKey")}
      </button>) : (<>
        {hasCustomInputs ? (<button type="button" className="model-picker-group-connect" data-open={expanded || undefined} onClick={() => toggleExpanded(expanded ? null : tab.key)} disabled={sectionDisabled}>
            {expanded
                ? t("settings.modelPicker.actions.cancel")
                : t("settings.modelPicker.actions.custom")}
          </button>) : null}
        {removable ? (<button type="button" className="model-picker-group-signout" data-armed={armed || undefined} disabled={isSigningOut} aria-label={armed
                ? t("settings.modelPicker.signOut.confirmAriaLabel", { provider: tab.label })
                : t("settings.modelPicker.signOut.ariaLabel", { provider: tab.label })} title={armed
                ? t("settings.modelPicker.signOut.confirmTitle")
                : t("settings.modelPicker.signOut.ariaLabel", { provider: tab.label })} onClick={(event) => {
                event.stopPropagation();
                void handleSignOut(tab.key);
            }}>
            {armed ? (<Check size={13} strokeWidth={2} aria-hidden/>) : (<LogOut size={13} strokeWidth={1.75} aria-hidden/>)}
          </button>) : null}
      </>);

    const liftActionsToHeader = Boolean(headerActionsTarget) && tabs.length === 1;
    const section = tabs.length === 1 ? getSectionContext(tabs[0]) : null;
    useEffect(() => {
        if (!authOpenRequest || !section?.requiresAuth)
            return;
        setAuthError(null);
        setDraftKey("");
        setExpandedProvider(section.tab.key);
    }, [authOpenRequest, section?.requiresAuth, section?.tab.key]);
    const { requiresAuth: liftedRequiresAuth, supportsOAuth: liftedSupportsOAuth, expanded: liftedExpanded, sectionDisabled: liftedSectionDisabled, removable: liftedRemovable, armed: liftedArmed, isSigningOut: liftedIsSigningOut, hasCustomInputs: liftedHasCustomInputs, } = section ?? {};
    const liftedTabKey = section?.tab.key;
    const liftedTabLabel = section?.tab.label;
    const liftedDescriptor = useMemo(() => {
        if (!liftedTabKey)
            return null;
        const connect = liftedRequiresAuth || liftedHasCustomInputs
            ? {
                label: liftedExpanded
                    ? t("settings.modelPicker.actions.cancel")
                    : liftedRequiresAuth
                        ? liftedSupportsOAuth
                            ? t("settings.modelPicker.actions.signIn")
                            : t("settings.modelPicker.actions.addKey")
                        : t("settings.modelPicker.actions.custom"),
                onClick: () => toggleExpanded(liftedExpanded ? null : liftedTabKey),
                disabled: liftedSectionDisabled,
            }
            : null;
        const signOut = liftedRemovable
            ? {
                armed: liftedArmed,
                disabled: liftedIsSigningOut,
                label: liftedArmed
                    ? t("settings.modelPicker.signOut.confirmAriaLabel", { provider: liftedTabLabel ?? "" })
                    : t("settings.modelPicker.signOut.ariaLabel", { provider: liftedTabLabel ?? "" }),
                title: liftedArmed
                    ? t("settings.modelPicker.signOut.confirmTitle")
                    : t("settings.modelPicker.signOut.ariaLabel", { provider: liftedTabLabel ?? "" }),
                onClick: () => void handleSignOut(liftedTabKey),
            }
            : null;
        return connect || signOut ? { connect, signOut } : null;
    }, [handleSignOut, liftedArmed, liftedExpanded, liftedHasCustomInputs, liftedIsSigningOut, liftedRemovable, liftedRequiresAuth, liftedSectionDisabled, liftedSupportsOAuth, liftedTabKey, liftedTabLabel, t, toggleExpanded]);
    useEffect(() => {
        if (!headerActionsTarget || tabs.length !== 1)
            return undefined;
        headerActionsTarget(liftedDescriptor);
        return () => headerActionsTarget(null);
    }, [headerActionsTarget, liftedDescriptor, tabs.length]);
    const renderSearch = renderSearchBar;
    const renderSection = (tab: ProviderTab, models: CatalogModel[]) => {
        const section = getSectionContext(tab);
        const { isStella, isLocal, isOpenRouter, llmEntry, requiresAuth, supportsApiKey, supportsOAuth, sectionDisabled, expanded, authDescription, } = section;
        const restrictThisStella = isStella && restrictStellaPicks;
        const resolveDefaultToModel = isStella &&
            (hideDefaultRow ||
                (hideSelectedTitle &&
                    visibleProviders?.length === 1 &&
                    visibleProviders[0] === STELLA_PROVIDER_KEY));
        const showDefaultRow = !resolveDefaultToModel && isStella && !trimmedQuery;

        const handleRowPick = requiresAuth
            ? () => toggleExpanded(expanded ? null : tab.key)
            : handlePick;
        const showGroupHead = collapsibleGroups ||
            (!hideGroupHead &&
                !inlineProviderActions &&
                !liftActionsToHeader &&
                (!hideProviderLabel || requiresAuth || section.hasCustomInputs || section.removable));

        const open = !collapsibleGroups || Boolean(trimmedQuery) || openSections.has(tab.key);
        const sectionHoldsSelection = isStella
            ? isDefaultSelected || (value ?? "").startsWith("stella/")
            : models.some((model) => model.id === value);
        return (<div key={tab.key} className="model-picker-group" role="group" aria-label={tab.label} data-open={open || undefined}>
        {showGroupHead ? (<div className="model-picker-group-head" data-label-hidden={(!collapsibleGroups && hideProviderLabel) || undefined} data-collapsible={collapsibleGroups || undefined} title={disabledProviderSet.has(tab.key)
                ? disabledProviderReason
                : undefined}>
          {collapsibleGroups ? (<button type="button" className="model-picker-group-toggle" aria-expanded={open} onClick={() => {
                toggleSection(tab.key, false);
                if (!open && requiresAuth && models.length === 0) {

                    toggleExpanded(tab.key);
                }
                else if (open && expanded) {
                    toggleExpanded(null);
                }
            }} disabled={Boolean(trimmedQuery)}>
              <span className="model-picker-group-icon" aria-hidden>
                <BrandIcon brand={tab.key} size={13}/>
              </span>
              <span className="model-picker-group-label">{tab.label}</span>
              {!open && sectionHoldsSelection ? (<Check size={12} strokeWidth={2} className="model-picker-group-check" aria-hidden/>) : null}
              <ChevronDown size={13} strokeWidth={1.75} className="model-picker-group-chevron" data-open={open || undefined} aria-hidden/>
            </button>) : hideProviderLabel ? null : (<>
              <span className="model-picker-group-icon" aria-hidden>
                <BrandIcon brand={tab.key} size={13}/>
              </span>
              <span className="model-picker-group-label">{tab.label}</span>
            </>)}
          {

}
          <span className="model-picker-group-actions">{renderGroupActions(section)}</span>
        </div>) : null}

        {open && requiresAuth && expanded ? (<div className="model-picker-connect">
            <p className="model-picker-connect-hint">{authDescription}</p>
            {supportsOAuth ? (<button type="button" className="model-picker-connect-oauth" onClick={() => oauthProvider === tab.key
                    ? void cancelPendingOAuth(tab.key)
                    : void handleLoginOAuth(tab.key)} disabled={sectionDisabled && oauthProvider !== tab.key}>
                <LogIn size={13} strokeWidth={1.75} aria-hidden/>
                {oauthProvider === tab.key
                        ? t("settings.modelPicker.cancelSignIn")
                        : t("settings.modelPicker.signInWith", { provider: tab.label })}
              </button>) : null}
            {supportsApiKey ? (<div className="model-picker-connect-field">
                <KeyRound size={13} strokeWidth={1.75} aria-hidden/>
                <input type="password" placeholder={llmEntry?.placeholder ?? t("settings.modelPicker.apiKeyPlaceholder")} value={draftKey} onChange={(e) => setDraftKey(e.target.value)} onKeyDown={(e) => {
                        if (e.key === "Enter")
                            handleSaveKey(tab.key, tab.label);
                    }} autoFocus={!supportsOAuth} disabled={sectionDisabled} aria-label={t("settings.modelPicker.apiKeyAriaLabel", { provider: tab.label })} spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={() => handleSaveKey(tab.key, tab.label)} disabled={!draftKey.trim() ||
                        savingProvider === tab.key ||
                        sectionDisabled}>
                  {savingProvider === tab.key
                    ? t("settings.modelPicker.saving")
                    : t("common.save")}
                </button>
              </div>) : null}
            {authError ? (<p className="model-picker-connect-error" role="alert">
                {authError}
              </p>) : null}
          </div>) : null}
        {!open ? null : <>
          {isLocal && expanded ? (<div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                {t("settings.modelPicker.local.hint")}
              </p>
              <div className="model-picker-connect-field">
                <input placeholder={DEFAULT_LOCAL_BASE_URL} value={localBaseUrl} onChange={(e) => setLocalBaseUrl(e.target.value)} disabled={sectionDisabled} aria-label={t("settings.modelPicker.local.serverUrlAriaLabel")} spellCheck={false} autoComplete="off"/>
              </div>
              <div className="model-picker-connect-field">
                <input placeholder="llama3.2" value={localModelId} onChange={(e) => setLocalModelId(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter")
                        handleSubmitLocal();
                }} disabled={sectionDisabled} aria-label={t("settings.modelPicker.local.modelNameAriaLabel")} spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={handleSubmitLocal} disabled={!localModelId.trim() || sectionDisabled}>
                  {t("settings.modelPicker.use")}
                </button>
              </div>
            </div>) : null}

          {isOpenRouter && expanded ? (<div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                {t("settings.modelPicker.openRouter.hintBefore")}{" "}
                <code>vendor/model</code>{" "}
                {t("settings.modelPicker.openRouter.hintAfter")}
              </p>
              <div className="model-picker-connect-field">
                <input placeholder="anthropic/claude-opus-4.7" value={openRouterCustomId} onChange={(e) => setOpenRouterCustomId(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter")
                        handleSubmitOpenRouter();
                }} disabled={sectionDisabled} aria-label={t("settings.modelPicker.openRouter.modelIdAriaLabel")} spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={handleSubmitOpenRouter} disabled={!openRouterCustomId.trim() || sectionDisabled}>
                  {t("settings.modelPicker.use")}
                </button>
              </div>
            </div>) : null}

          <div className="model-picker-models">
            {showDefaultRow ? (<button type="button" role="option" aria-selected={isDefaultSelected} className="model-picker-model model-picker-model--default" data-selected={isDefaultSelected || undefined} onClick={(event) => handlePick(DEFAULT_TARGET, event.currentTarget)} disabled={sectionDisabled}>
                <span className="model-picker-model-text">
                  <span className="model-picker-model-name">
                    {defaultLabel}
                  </span>
                </span>
                {!hideSelectionCheck && isDefaultSelected ? (<Check size={13} className="model-picker-model-check"/>) : null}
              </button>) : null}
            {showDefaultRow && isDefaultSelected && selectedRowExtra ? (<div className="model-picker-selected-extra">{selectedRowExtra}</div>) : null}
            {models.map((model) => {
                const selected = isDefaultSelected
                    ? resolveDefaultToModel && modelMatchesDefault(model, currentLabel)
                    : model.id === value;
                const rowRestricted = restrictThisStella &&
                    model.provider === STELLA_PROVIDER_KEY &&
                    !selected &&
                    model.allowedForAudience === false;
                return (<div key={model.id} className="model-picker-row-slot">
                    <ModelRow model={model} selected={selected} rowRestricted={rowRestricted} restrictedPlanLabel={restrictedPlanLabel ?? null} restrictedReason={rowRestricted && !restrictedPlanLabel
                        ? (disabledProviderReason ?? null)
                        : null} onPick={handleRowPick} disabled={sectionDisabled} favorite={favorites.includes(model.id)} showFavorite={Boolean(favoriteScope)} onToggleFavorite={toggleFavorite} reasoningEffort={reasoningEffort} onSelectReasoning={onSelectReasoning} hideSelectionCheck={hideSelectionCheck}/>
                    {selected && selectedRowExtra ? (<div className="model-picker-selected-extra">{selectedRowExtra}</div>) : null}
                  </div>);
            })}
          </div>
        </>}
      </div>);
    };

    const renderExtraSection = (extra: ProviderModelExtraSection) => {
        const open = openSections.has(extra.key);
        return (<div key={extra.key} className="model-picker-group" role="group" aria-label={extra.label} data-open={open || undefined}>
        <div className="model-picker-group-head" data-collapsible>
          <button type="button" className="model-picker-group-toggle" aria-expanded={open} onClick={() => toggleSection(extra.key, true)}>
            <span className="model-picker-group-icon" aria-hidden>
              <BrandIcon brand={extra.brandKey ?? extra.key} size={13}/>
            </span>
            <span className="model-picker-group-label">{extra.label}</span>
            {extra.badge ? (<span className="model-picker-group-note">{extra.badge}</span>) : null}
            {!open && extra.selected ? (<Check size={12} strokeWidth={2} className="model-picker-group-check" aria-hidden/>) : null}
            <ChevronDown size={13} strokeWidth={1.75} className="model-picker-group-chevron" data-open={open || undefined} aria-hidden/>
          </button>
        </div>
        {open ? extra.content() : null}
      </div>);
    };

    const orderedSections = useMemo(() => {
        const entries: Array<
          | { kind: "catalog"; key: string; tab: ProviderTab; models: CatalogModel[] }
          | { kind: "extra"; key: string; extra: ProviderModelExtraSection }
        > = sections.map(({ tab, models }) => ({
            kind: "catalog",
            key: tab.key,
            tab,
            models,
        }));
        if (!trimmedQuery) {
            for (const extra of extraSections) {
                entries.push({ kind: "extra", key: extra.key, extra });
            }
        }
        if (sectionOrder?.length) {
            const rank = new Map(sectionOrder.map((key, index) => [key, index]));
            entries.sort((a, b) => (rank.get(a.key) ?? sectionOrder.length) -
                (rank.get(b.key) ?? sectionOrder.length));
        }
        return entries;
    }, [extraSections, sections, sectionOrder, trimmedQuery]);
    return (<div className="model-picker-shell" data-disabled={disabled || undefined} role="group" aria-label={ariaLabel}>
      <div className="model-picker-pane-inner">
        {hideSelectedTitle ? null : (<header className="model-picker-pane-header">
            <div className="model-picker-pane-title">
              <span className="model-picker-pane-kicker">
                {selectedHeaderKicker ?? t("settings.modelPicker.selected")}
              </span>
              <span className="model-picker-pane-current" title={currentLabel}>
                {currentLabel}
              </span>
            </div>
          </header>)}

        {!searchVisible ? null : inlineProviderActions || onRefresh ? (<div className="model-picker-search-row">
            {renderSearch()}
            {inlineProviderActions ? (<div className="model-picker-search-action">
                {renderGroupActions(getSectionContext(tabs[0]))}
              </div>) : null}
            {onRefresh ? (<button type="button" className="model-picker-refresh" onClick={onRefresh} disabled={disabled || refreshing} aria-label={t("settings.modelPicker.refresh")} title={t("settings.modelPicker.refresh")}>
                <RefreshCw size={13} strokeWidth={1.75} data-spinning={refreshing || undefined}/>
              </button>) : null}
          </div>) : renderSearch()}

        {catalogError ? (<p className="model-picker-load-error" role="status">
            <span>{t("settings.modelPicker.loadFailed")}</span>
            {onRefresh ? (<button type="button" className="model-picker-load-error-retry" onClick={onRefresh} disabled={disabled || refreshing}>
                {t("settings.modelPicker.retry")}
              </button>) : null}
          </p>) : null}

        <div className="model-picker-groups" role="listbox" aria-live="polite">
          {orderedSections.length === 0 ? (<div className="model-picker-empty">
              {tabs.length === 0
                ? t("settings.modelPicker.empty.none")
                : t("settings.modelPicker.empty.noMatch")}
            </div>) : (orderedSections.map((entry) => entry.kind === "extra"
                ? renderExtraSection(entry.extra)
                : renderSection(entry.tab, entry.models)))}
        </div>
      </div>
    </div>);
}
type ModelRowProps = {
    model: CatalogModel;
    selected: boolean;
    rowRestricted: boolean;
    restrictedPlanLabel: string | null;
    restrictedReason: string | null;
    onPick: (modelId: string, anchor?: HTMLElement) => void;
    disabled: boolean;
    favorite: boolean;
    showFavorite: boolean;
    onToggleFavorite: (modelId: string) => void;
    reasoningEffort?: ReasoningEffort;
    onSelectReasoning?: (modelId: string, effort: ReasoningEffort) => void;
    hideSelectionCheck: boolean;
};

const ModelRow = memo(function ModelRow({ model, selected, rowRestricted, restrictedPlanLabel, restrictedReason, onPick, disabled, favorite, showFavorite, onToggleFavorite, reasoningEffort, onSelectReasoning, hideSelectionCheck, }: ModelRowProps) {
    const t = useT();
    const [reasoningOpen, setReasoningOpen] = useState(false);
    const showReasoning = Boolean(onSelectReasoning);
    const hasActions = showReasoning || showFavorite;
    const isStellaModel = model.provider === STELLA_PROVIDER_KEY;
    const displayName = isStellaModel
        ? getStellaResolvedModelName(model)
        : model.name;
    return (<div className="model-picker-model-row">
      <button type="button" role="option" aria-selected={selected} aria-disabled={rowRestricted || undefined} className="model-picker-model" data-selected={selected || undefined} data-restricted={rowRestricted || undefined} title={rowRestricted && restrictedPlanLabel
            ? t("settings.modelPicker.restrictedPlan", { plan: restrictedPlanLabel })
            : rowRestricted
                ? (restrictedReason ?? undefined)
                : undefined} onClick={(event) => onPick(model.id, event.currentTarget)} disabled={disabled || rowRestricted}>
        <span className="model-picker-model-text">
          <span className="model-picker-model-name">{displayName}</span>
        </span>
        {!hideSelectionCheck && selected ? (<Check size={13} className="model-picker-model-check"/>) : null}
      </button>
      {hasActions ? (<div className="model-picker-model-actions" data-open={reasoningOpen || undefined}>
          {showReasoning ? (<DropdownMenu open={reasoningOpen} onOpenChange={setReasoningOpen}>
              <DropdownMenuTrigger asChild>
                <button type="button" className="model-picker-model-reason" data-active={(selected &&
                    reasoningEffort &&
                    reasoningEffort !== "default") ||
                    undefined} aria-label={t("settings.modelPicker.reasoning.label")} title={t("settings.modelPicker.reasoning.label")} disabled={disabled || rowRestricted} onClick={(event) => event.stopPropagation()}>
                  <Lightbulb size={14} strokeWidth={1.75}/>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
                <DropdownMenuRadioGroup value={reasoningEffort ?? "default"} onValueChange={(value) => onSelectReasoning?.(model.id, value as ReasoningEffort)}>
                  {REASONING_OPTIONS.map((option) => (<DropdownMenuRadioItem key={option.id} value={option.id}>
                      {t(option.labelKey)}
                    </DropdownMenuRadioItem>))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>) : null}
          {showFavorite ? (<button type="button" className="model-picker-model-star" data-favorite={favorite || undefined} aria-pressed={favorite} aria-label={favorite
                    ? t("settings.modelPicker.favorite.remove")
                    : t("settings.modelPicker.favorite.add")} title={favorite
                    ? t("settings.modelPicker.favorite.remove")
                    : t("settings.modelPicker.favorite.addTitle")} disabled={disabled || rowRestricted} onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(model.id);
                }}>
              <Star size={14} strokeWidth={1.75}/>
            </button>) : null}
        </div>) : null}
    </div>);
});
