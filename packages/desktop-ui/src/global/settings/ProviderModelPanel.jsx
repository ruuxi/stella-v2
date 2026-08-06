import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, KeyRound, Lightbulb, LogIn, LogOut, Search, Star, X, } from "@/ui/icons";
import { BrandIcon } from "@/ui/brand-icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, } from "@/ui/dropdown-menu";
import { readEngineModelFavorites, sortByFavorites, toggleEngineModelFavorite, } from "@/features/workspace-display/engine-model-favorites";
import { getStellaResolvedModelName, searchCatalogModels, } from "@/global/settings/lib/model-catalog";
import { compareProviderRailOrder, LLM_PROVIDERS, isApiKeyOnlyPlaceholder, } from "@/global/settings/lib/llm-providers";
import { findApiKey, findOauthCredential, findOauthProvider, useLlmCredentials, } from "@/global/settings/hooks/use-llm-credentials";
import "./ProviderModelPicker.css";
const REASONING_OPTIONS = [
    { id: "default", label: "Auto" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Max" },
];
const STELLA_PROVIDER_KEY = "stella";
const LOCAL_PROVIDER_KEY = "local";
const DEFAULT_TARGET = "__default__";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const normalizeResolvedModelId = (modelId) => modelId.trim().replace(/^stella\//, "").toLowerCase();
const resolvedModelIdentity = (model) => normalizeResolvedModelId(model.upstreamModel || getStellaResolvedModelName(model));
const modelMatchesDefault = (model, defaultModel) => Boolean(defaultModel) &&
    (model.id === defaultModel ||
        resolvedModelIdentity(model) === normalizeResolvedModelId(defaultModel) ||
        getStellaResolvedModelName(model).trim().toLowerCase() ===
            defaultModel.trim().toLowerCase());
const dedupeStellaModels = (models, selectedModelId) => {
    const byResolvedModel = new Map();
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
export const providerUsesRuntimeManagedAuth = (tab) => tab.runtimeManagedAuth || tab.runtimeCredentialless;
export function buildProviderTabs(groups, visibleProviders) {
    const tabs = new Map();
    for (const entry of LLM_PROVIDERS) {
        if (visibleProviders && !visibleProviders.includes(entry.key)) {
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
export function ProviderModelPanel({ value, defaultLabel, currentLabel, groups, onSelect, disabled = false, reasoningEffort, onSelectReasoning, restrictStellaPicks = false, restrictedPlanLabel, ariaLabel, hideDefaultRow = false, selectedHeaderKicker, hideSelectedTitle = false, hideSearch = false, hideSelectionCheck = false, disableNonStellaProviders = false, disabledProviderReason, hideProviderLabel = false, visibleProviders, favoriteScope, hideGroupHead = false, headerActionsTarget, authOpenRequest = 0, onRequestSearchClose, }) {
    const credentials = useLlmCredentials();
    const cancelOAuth = credentials.cancelOAuth;
    const tabs = useMemo(() => buildProviderTabs(groups, visibleProviders), [groups, visibleProviders]);
    const [favorites, setFavorites] = useState(() => favoriteScope ? readEngineModelFavorites(favoriteScope) : []);
    const disabledProviderSet = useMemo(() => new Set(disableNonStellaProviders
        ? tabs
            .map((tab) => tab.key)
            .filter((key) => key !== STELLA_PROVIDER_KEY)
        : []), [disableNonStellaProviders, tabs]);
    const [query, setQuery] = useState("");
    // The scoped picker view keeps the search field behind a header search
    // icon (`hideSearch` toggles it); autofocus on reveal so it reads as the
    // icon expanding into the bar.
    const searchInputRef = useRef(null);
    const searchVisible = !hideSearch;
    useEffect(() => {
        if (searchVisible)
            searchInputRef.current?.focus();
    }, [searchVisible]);
    // Which provider's inline form (connect / API key, or the local /
    // OpenRouter custom-model inputs) is expanded. Only one is open at a time
    // so the shared draft/api-key state stays unambiguous, and nothing opens
    // by default — sections collapse to just their model list.
    const [expandedProvider, setExpandedProvider] = useState(null);
    const [draftKey, setDraftKey] = useState("");
    const [savingProvider, setSavingProvider] = useState(null);
    const [oauthProvider, setOauthProvider] = useState(null);
    const oauthAttemptRef = useRef(null);
    const [authError, setAuthError] = useState(null);
    const [openRouterCustomId, setOpenRouterCustomId] = useState("");
    const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
    const [localModelId, setLocalModelId] = useState("");
    const sections = useMemo(() => {
        const trimmed = hideSearch ? "" : query.trim();
        const result = [];
        for (const tab of tabs) {
            const searched = trimmed
                ? searchCatalogModels(tab.models, trimmed)
                : tab.models;
            const sorted = favoriteScope
                ? sortByFavorites(searched, favorites)
                : searched;
            const visibleModels = tab.key === STELLA_PROVIDER_KEY
                ? dedupeStellaModels(sorted, value)
                : sorted;
            // Hide sections with no matching models while searching so the list
            // narrows to relevant providers instead of leaving empty headers.
            if (trimmed && visibleModels.length === 0)
                continue;
            result.push({ tab, models: visibleModels });
        }
        return result;
    }, [tabs, favoriteScope, favorites, hideSearch, query, value]);
    const toggleFavorite = useCallback((modelId) => {
        if (!favoriteScope)
            return;
        setFavorites(toggleEngineModelFavorite(favoriteScope, modelId));
    }, [favoriteScope]);
    const handlePick = useCallback((modelId, anchor) => {
        if (disabled)
            return;
        onSelect(modelId === DEFAULT_TARGET ? "" : modelId, anchor);
    }, [disabled, onSelect]);
    const cancelPendingOAuth = useCallback(async (providerKey) => {
        const attempt = oauthAttemptRef.current;
        if (!attempt || (providerKey && attempt.provider !== providerKey))
            return;
        attempt.cancelled = true;
        setOauthProvider((current) => current === attempt.provider ? null : current);
        await cancelOAuth(attempt.provider);
    }, [cancelOAuth]);
    const toggleExpanded = useCallback((providerKey) => {
        const pendingProvider = oauthAttemptRef.current?.provider;
        if (pendingProvider && pendingProvider !== providerKey) {
            void cancelPendingOAuth(pendingProvider);
        }
        setExpandedProvider(providerKey);
        setDraftKey("");
        setAuthError(null);
    }, [cancelPendingOAuth]);
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
    // Sign-out: a connected provider shows a hover log-out icon in its section
    // header. First click arms it (visual confirm), a second click within the
    // window actually drops the API key + OAuth session for that provider.
    const [signOutArmed, setSignOutArmed] = useState(null);
    const [signingOut, setSigningOut] = useState(null);
    const signOutTimerRef = useRef(null);
    const handleSignOut = useCallback(async (providerKey) => {
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
            // Failures surface via the credentials hook's `error` state.
        }
        finally {
            setSigningOut(null);
        }
    }, [credentials.apiKeys, credentials.oauthCredentials, credentials.logoutOAuth, credentials.removeApiKey, signOutArmed]);
    const handleSaveKey = useCallback(async (providerKey, label) => {
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
            setAuthError(caught instanceof Error ? caught.message : "Failed to save API key.");
        }
        finally {
            setSavingProvider(null);
        }
    }, [credentials, draftKey]);
    const handleLoginOAuth = useCallback(async (providerKey) => {
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
                setAuthError(caught instanceof Error ? caught.message : "OAuth login failed.");
            }
        }
        finally {
            if (oauthAttemptRef.current === attempt) {
                oauthAttemptRef.current = null;
                setOauthProvider(null);
            }
        }
    }, [cancelPendingOAuth, credentials]);
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
    // Scoped single-provider view (the sidebar picker's brand rail already
    // chose the provider): the provider label row is redundant. When search
    // is visible the connect / custom / sign-out actions ride its row; when
    // the embedder hides the head entirely (or lifts the actions into its
    // own header via `headerActionsTarget`), the list renders with no
    // heading row at all so it doesn't leave a one-sided gap.
    const inlineProviderActions = searchVisible && hideSelectedTitle && hideProviderLabel && tabs.length === 1;
    const renderSearchBar = () => (<div className="model-picker-search">
        <Search size={13} strokeWidth={1.75} aria-hidden/>
        <input ref={searchInputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Escape") {
                setQuery("");
                onRequestSearchClose?.();
            }
        }} placeholder="Search models…" spellCheck={false} autoComplete="off" aria-label="Search models" disabled={disabled}/>
        {onRequestSearchClose ? (<button type="button" className="model-picker-search-close" aria-label="Close search" onClick={() => {
                setQuery("");
                onRequestSearchClose();
            }}>
            <X size={13} strokeWidth={1.75} aria-hidden/>
          </button>) : null}
      </div>);
    const getSectionContext = (tab) => {
        const isStella = tab.key === STELLA_PROVIDER_KEY;
        const isLocal = tab.key === LOCAL_PROVIDER_KEY;
        const isOpenRouter = tab.key === "openrouter";
        const apiKey = findApiKey(credentials.apiKeys, tab.key);
        const oauthCred = findOauthCredential(credentials.oauthCredentials, tab.key);
        const oauthEntry = findOauthProvider(credentials.oauthProviders, tab.key);
        const llmEntry = tab.llmEntry ??
            (!isStella
                ? { key: tab.key, label: tab.label, placeholder: "API key" }
                : undefined);
        const connected = isStella || Boolean(apiKey) || Boolean(oauthCred);
        // Providers introduced by models.json/extensions own their auth and may
        // be intentionally credentialless (Ollama, local proxies). Do not block
        // their model rows behind Stella's built-in provider login UI.
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
        // Local + connected OpenRouter offer a custom-model entry, tucked behind
        // a header toggle so the section doesn't open expanded by default.
        const hasCustomInputs = isLocal || isOpenRouter;
        const authDescription = supportsOAuth && supportsApiKey
            ? "Sign in or paste an API key. Credentials stay on this device."
            : supportsOAuth
                ? "Credentials stay on this device."
                : "Your API key stays on this device.";
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
    const renderGroupActions = ({ tab, requiresAuth, supportsOAuth, sectionDisabled, removable, armed, isSigningOut, expanded, hasCustomInputs, }) => requiresAuth ? (<button type="button" className="model-picker-group-connect" data-open={expanded || undefined} onClick={() => toggleExpanded(expanded ? null : tab.key)} disabled={sectionDisabled}>
        {expanded ? "Cancel" : supportsOAuth ? "Sign in" : "Add key"}
      </button>) : (<>
        {hasCustomInputs ? (<button type="button" className="model-picker-group-connect" data-open={expanded || undefined} onClick={() => toggleExpanded(expanded ? null : tab.key)} disabled={sectionDisabled}>
            {expanded ? "Cancel" : "Custom"}
          </button>) : null}
        {removable ? (<button type="button" className="model-picker-group-signout" data-armed={armed || undefined} disabled={isSigningOut} aria-label={armed
                ? `Click again to sign out of ${tab.label}`
                : `Sign out of ${tab.label}`} title={armed
                ? "Click again to confirm"
                : `Sign out of ${tab.label}`} onClick={(event) => {
                event.stopPropagation();
                void handleSignOut(tab.key);
            }}>
            {armed ? (<Check size={13} strokeWidth={2} aria-hidden/>) : (<LogOut size={13} strokeWidth={1.75} aria-hidden/>)}
          </button>) : null}
      </>);
    // Lift the scoped provider's connect / custom / sign-out actions into
    // the embedder's header so the list doesn't need its own head row. The
    // embedder owns the button styling, so we hand it a descriptor, not
    // rendered JSX (the in-list action is a labeled pill, which looked
    // mismatched beside the header's icon buttons).
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
                    ? "Cancel"
                    : liftedRequiresAuth
                        ? liftedSupportsOAuth
                            ? "Sign in"
                            : "Add key"
                        : "Custom",
                onClick: () => toggleExpanded(liftedExpanded ? null : liftedTabKey),
                disabled: liftedSectionDisabled,
            }
            : null;
        const signOut = liftedRemovable
            ? {
                armed: liftedArmed,
                disabled: liftedIsSigningOut,
                label: liftedArmed
                    ? `Click again to sign out of ${liftedTabLabel}`
                    : `Sign out of ${liftedTabLabel}`,
                title: liftedArmed
                    ? "Click again to confirm"
                    : `Sign out of ${liftedTabLabel}`,
                onClick: () => void handleSignOut(liftedTabKey),
            }
            : null;
        return connect || signOut ? { connect, signOut } : null;
    }, [handleSignOut, liftedArmed, liftedExpanded, liftedHasCustomInputs, liftedIsSigningOut, liftedRemovable, liftedRequiresAuth, liftedSectionDisabled, liftedSupportsOAuth, liftedTabKey, liftedTabLabel, toggleExpanded]);
    useEffect(() => {
        if (!headerActionsTarget || tabs.length !== 1)
            return undefined;
        headerActionsTarget(liftedDescriptor);
        return () => headerActionsTarget(null);
    }, [headerActionsTarget, liftedDescriptor, tabs.length]);
    const renderSearch = renderSearchBar;
    const renderSection = (tab, models) => {
        const section = getSectionContext(tab);
        const { isStella, isLocal, isOpenRouter, llmEntry, requiresAuth, supportsApiKey, supportsOAuth, sectionDisabled, expanded, authDescription, } = section;
        const restrictThisStella = isStella && restrictStellaPicks;
        const resolveDefaultToModel = isStella &&
            (hideDefaultRow ||
                (hideSelectedTitle &&
                    visibleProviders?.length === 1 &&
                    visibleProviders[0] === STELLA_PROVIDER_KEY));
        const showDefaultRow = !resolveDefaultToModel && isStella && !trimmedQuery;
        // Models stay visible before the provider is connected; picking one
        // opens the connect flow instead of selecting.
        const handleRowPick = requiresAuth
            ? () => toggleExpanded(expanded ? null : tab.key)
            : handlePick;
        const showGroupHead = !hideGroupHead &&
            !inlineProviderActions &&
            !liftActionsToHeader &&
            (!hideProviderLabel || requiresAuth || section.hasCustomInputs || section.removable);
        return (<div key={tab.key} className="model-picker-group" role="group" aria-label={tab.label}>
        {showGroupHead ? (<div className="model-picker-group-head" data-label-hidden={hideProviderLabel || undefined} title={disabledProviderSet.has(tab.key)
                ? disabledProviderReason
                : undefined}>
          {hideProviderLabel ? null : (<>
              <span className="model-picker-group-icon" aria-hidden>
                <BrandIcon brand={tab.key} size={13}/>
              </span>
              <span className="model-picker-group-label">{tab.label}</span>
            </>)}
          {renderGroupActions(section)}
        </div>) : null}

        {requiresAuth && expanded ? (<div className="model-picker-connect">
            <p className="model-picker-connect-hint">{authDescription}</p>
            {supportsOAuth ? (<button type="button" className="model-picker-connect-oauth" onClick={() => oauthProvider === tab.key
                    ? void cancelPendingOAuth(tab.key)
                    : void handleLoginOAuth(tab.key)} disabled={sectionDisabled && oauthProvider !== tab.key}>
                <LogIn size={13} strokeWidth={1.75} aria-hidden/>
                {oauthProvider === tab.key
                        ? "Cancel sign-in"
                        : `Sign in with ${tab.label}`}
              </button>) : null}
            {supportsApiKey ? (<div className="model-picker-connect-field">
                <KeyRound size={13} strokeWidth={1.75} aria-hidden/>
                <input type="password" placeholder={llmEntry?.placeholder ?? "API key"} value={draftKey} onChange={(e) => setDraftKey(e.target.value)} onKeyDown={(e) => {
                        if (e.key === "Enter")
                            handleSaveKey(tab.key, tab.label);
                    }} autoFocus={!supportsOAuth} disabled={sectionDisabled} aria-label={`${tab.label} API key`} spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={() => handleSaveKey(tab.key, tab.label)} disabled={!draftKey.trim() ||
                        savingProvider === tab.key ||
                        sectionDisabled}>
                  {savingProvider === tab.key ? "Saving…" : "Save"}
                </button>
              </div>) : null}
            {authError ? (<p className="model-picker-connect-error" role="alert">
                {authError}
              </p>) : null}
          </div>) : null}
        <>
          {isLocal && expanded ? (<div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                Use any local OpenAI-compatible server. Ollama usually runs at
                the URL below.
              </p>
              <div className="model-picker-connect-field">
                <input placeholder={DEFAULT_LOCAL_BASE_URL} value={localBaseUrl} onChange={(e) => setLocalBaseUrl(e.target.value)} disabled={sectionDisabled} aria-label="Local server URL" spellCheck={false} autoComplete="off"/>
              </div>
              <div className="model-picker-connect-field">
                <input placeholder="llama3.2" value={localModelId} onChange={(e) => setLocalModelId(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter")
                        handleSubmitLocal();
                }} disabled={sectionDisabled} aria-label="Local model name" spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={handleSubmitLocal} disabled={!localModelId.trim() || sectionDisabled}>
                  Use
                </button>
              </div>
            </div>) : null}

          {isOpenRouter && expanded ? (<div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                OpenRouter accepts any <code>vendor/model</code> id. Type one to
                use it directly.
              </p>
              <div className="model-picker-connect-field">
                <input placeholder="anthropic/claude-opus-4.7" value={openRouterCustomId} onChange={(e) => setOpenRouterCustomId(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter")
                        handleSubmitOpenRouter();
                }} disabled={sectionDisabled} aria-label="OpenRouter model id" spellCheck={false} autoComplete="off"/>
                <button type="button" className="model-picker-connect-go" onClick={handleSubmitOpenRouter} disabled={!openRouterCustomId.trim() || sectionDisabled}>
                  Use
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
            {models.map((model) => {
                const selected = isDefaultSelected
                    ? resolveDefaultToModel && modelMatchesDefault(model, currentLabel)
                    : model.id === value;
                const rowRestricted = restrictThisStella &&
                    model.provider === STELLA_PROVIDER_KEY &&
                    !selected &&
                    model.allowedForAudience === false;
                return (<ModelRow key={model.id} model={model} selected={selected} rowRestricted={rowRestricted} restrictedPlanLabel={restrictedPlanLabel ?? null} restrictedReason={rowRestricted && !restrictedPlanLabel
                        ? (disabledProviderReason ?? null)
                        : null} onPick={handleRowPick} disabled={sectionDisabled} favorite={favorites.includes(model.id)} showFavorite={Boolean(favoriteScope)} onToggleFavorite={toggleFavorite} reasoningEffort={reasoningEffort} onSelectReasoning={onSelectReasoning} hideSelectionCheck={hideSelectionCheck}/>);
            })}
          </div>
        </>
      </div>);
    };
    return (<div className="model-picker-shell" data-disabled={disabled || undefined} role="group" aria-label={ariaLabel}>
      <div className="model-picker-pane-inner">
        {hideSelectedTitle ? null : (<header className="model-picker-pane-header">
            <div className="model-picker-pane-title">
              <span className="model-picker-pane-kicker">
                {selectedHeaderKicker ?? "Selected"}
              </span>
              <span className="model-picker-pane-current" title={currentLabel}>
                {currentLabel}
              </span>
            </div>
          </header>)}

        {!searchVisible ? null : inlineProviderActions ? (<div className="model-picker-search-row">
            {renderSearch()}
            <div className="model-picker-search-action">
              {renderGroupActions(getSectionContext(tabs[0]))}
            </div>
          </div>) : renderSearch()}

        <div className="model-picker-groups" role="listbox" aria-live="polite">
          {sections.length === 0 ? (<div className="model-picker-empty">
              {tabs.length === 0
                ? "No models available yet."
                : "No models match."}
            </div>) : (sections.map(({ tab, models }) => renderSection(tab, models)))}
        </div>
      </div>
    </div>);
}
const ModelRow = memo(function ModelRow({ model, selected, rowRestricted, restrictedPlanLabel, restrictedReason, onPick, disabled, favorite, showFavorite, onToggleFavorite, reasoningEffort, onSelectReasoning, hideSelectionCheck, }) {
    const [reasoningOpen, setReasoningOpen] = useState(false);
    const showReasoning = Boolean(onSelectReasoning);
    const hasActions = showReasoning || showFavorite;
    const isStellaModel = model.provider === STELLA_PROVIDER_KEY;
    const displayName = isStellaModel
        ? getStellaResolvedModelName(model)
        : model.name;
    return (<div className="model-picker-model-row">
      <button type="button" role="option" aria-selected={selected} aria-disabled={rowRestricted || undefined} className="model-picker-model" data-selected={selected || undefined} data-restricted={rowRestricted || undefined} title={rowRestricted && restrictedPlanLabel
            ? `Not available on the ${restrictedPlanLabel} plan`
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
                    undefined} aria-label="Reasoning effort" title="Reasoning effort" disabled={disabled || rowRestricted} onClick={(event) => event.stopPropagation()}>
                  <Lightbulb size={14} strokeWidth={1.75}/>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
                <DropdownMenuRadioGroup value={reasoningEffort ?? "default"} onValueChange={(value) => onSelectReasoning?.(model.id, value)}>
                  {REASONING_OPTIONS.map((option) => (<DropdownMenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </DropdownMenuRadioItem>))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>) : null}
          {showFavorite ? (<button type="button" className="model-picker-model-star" data-favorite={favorite || undefined} aria-pressed={favorite} aria-label={favorite ? "Remove favorite" : "Add favorite"} title={favorite ? "Remove favorite" : "Favorite — pin to top"} disabled={disabled || rowRestricted} onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(model.id);
                }}>
              <Star size={14} strokeWidth={1.75}/>
            </button>) : null}
        </div>) : null}
    </div>);
});
