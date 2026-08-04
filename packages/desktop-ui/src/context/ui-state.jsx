import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getElectronApi } from '@/platform/electron/electron';
const defaultState = {
    mode: 'chat',
    conversationId: null,
    isVoiceRtcActive: false,
};
const UiStateContext = createContext(null);
export const UiStateProvider = ({ children }) => {
    const [state, setState] = useState(defaultState);
    const hasHydratedFromMainRef = useRef(false);
    const pendingLocalStateRef = useRef({});
    const applyHydratedState = useCallback((nextState) => {
        if (hasHydratedFromMainRef.current) {
            return;
        }
        hasHydratedFromMainRef.current = true;
        const pendingLocalState = pendingLocalStateRef.current;
        pendingLocalStateRef.current = {};
        setState({ ...nextState, ...pendingLocalState });
    }, []);
    useEffect(() => {
        const api = getElectronApi();
        if (!api) {
            return;
        }
        void api.ui.getState().then(applyHydratedState).catch(() => {
            applyHydratedState(defaultState);
        });
        const unsubscribe = api.ui.onState((nextState) => {
            hasHydratedFromMainRef.current = true;
            pendingLocalStateRef.current = {};
            setState({ ...nextState });
        });
        return () => {
            unsubscribe();
        };
    }, [applyHydratedState]);
    const updateState = useCallback((partial) => {
        setState((prev) => ({ ...prev, ...partial }));
        if (!hasHydratedFromMainRef.current) {
            pendingLocalStateRef.current = {
                ...pendingLocalStateRef.current,
                ...partial,
            };
        }
        const api = getElectronApi();
        if (api) {
            void api.ui.setState(partial);
        }
    }, []);
    const setMode = useCallback((mode) => {
        updateState({ mode });
    }, [updateState]);
    const setConversationId = useCallback((conversationId) => {
        updateState({ conversationId });
    }, [updateState]);
    const value = useMemo(() => ({
        state,
        setMode,
        setConversationId,
        updateState,
    }), [state, setMode, setConversationId, updateState]);
    return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>;
};
export const useUiState = () => {
    const context = useContext(UiStateContext);
    if (!context) {
        throw new Error('useUiState must be used within UiStateProvider');
    }
    return context;
};
export const useOptionalUiState = () => useContext(UiStateContext);
