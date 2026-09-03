import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getThemeById,
  defaultTheme,
  deriveTokens,
  migrateLegacyThemeId,
  registerTheme,
  resolveThemeColors,
  subscribeThemes,
  getThemesSnapshot,
  type Theme,
  type ThemeColors,
  type ThemeTokens,
} from "@stella/theme";
import { uiState } from "../platform/ui-state";

type ColorMode = "light" | "dark" | "system";
type GradientMode = "soft" | "flat";
type GradientColor = "relative" | "strong";

// ─── Stable read-only context (rarely changes) ────────────────────────────

interface ThemeReadValue {
  theme: Theme;
  /** The effective active theme id ("custom" whenever Custom is unpopulated). */
  themeId: string;
  /**
   * The id a picker should show as selected. While Custom is unpopulated this
   * is the stock theme it's displaying (its base); otherwise it's the active id.
   */
  selectedThemeId: string;
  colorMode: ColorMode;
  resolvedColorMode: "light" | "dark";
  /**
   * The effective forced appearance, resolved through overlay themes (so the
   * Custom overlay reports its base theme's forced mode). Undefined for normal
   * themes that follow the user's Light/Dark choice.
   */
  forcedMode?: "light" | "dark";
  /**
   * Whether the active theme renders flat (gradient-suppressed). True for the
   * stock Default theme (solid macOS surface in both modes) and for any
   * `forcedMode`-pinned theme. Undefined-vs-false is coerced to boolean.
   */
  flat: boolean;
  gradientMode: GradientMode;
  gradientColor: GradientColor;
  colors: ThemeColors;
  themes: readonly Theme[];
}

// ─── Control context (mutators + preview, only used by ThemePicker/Onboarding) ─

interface ThemeControlValue {
  setTheme: (id: string) => void;
  setColorMode: (mode: ColorMode) => void;
  setGradientMode: (mode: GradientMode) => void;
  setGradientColor: (color: GradientColor) => void;
  previewTheme: (id: string) => void;
  cancelThemePreview: () => void;
  previewGradientMode: (mode: GradientMode) => void;
  cancelGradientModePreview: () => void;
  previewGradientColor: (color: GradientColor) => void;
  cancelGradientColorPreview: () => void;
  cancelPreview: () => void;
}

const ThemeReadContext = createContext<ThemeReadValue | null>(null);
const ThemeControlContext = createContext<ThemeControlValue | null>(null);

const THEME_STORAGE_KEY = "stella-theme-id";
// The stock theme the Custom overlay displays while it is unpopulated.
const CUSTOM_BASE_STORAGE_KEY = "stella-custom-base";
const COLOR_MODE_STORAGE_KEY = "stella-color-mode";
const GRADIENT_MODE_STORAGE_KEY = "stella-gradient-mode";
const GRADIENT_COLOR_STORAGE_KEY = "stella-gradient-color";

function getSystemColorMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// The old separate "light"/"dark" themes were `forcedMode`-pinned and are now a
// single mode-driven "Default" theme. Migrate any stored selection onto Default
// (the table lives with the catalog so mobile migrates identically).
const migrateThemeId = migrateLegacyThemeId;
// The pinned appearance a legacy "light"/"dark" selection was actually showing,
// so migration can carry it onto the Appearance mode toggle instead of silently
// flipping the look. Reads the raw stored ids (theme first, then Custom base).
function readLegacyForcedAppearance(): "light" | "dark" | null {
  const stored = uiState.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  const base = uiState.getItem(CUSTOM_BASE_STORAGE_KEY);
  if (base === "light" || base === "dark") return base;
  return null;
}

/**
 * Every derived token, keyed by the CSS custom property it lands on. The
 * derivation itself lives in `@stella/theme` so mobile reads the identical
 * values; this table is only the CSS naming.
 */
const TOKEN_VARS: ReadonlyArray<readonly [string, keyof ThemeTokens]> = [
  ["--background", "background"],
  ["--background-strong", "backgroundStrong"],
  ["--foreground", "foreground"],
  ["--card", "card"],
  ["--card-foreground", "cardForeground"],
  ["--popover", "card"],
  ["--popover-foreground", "cardForeground"],
  ["--surface-raised-stronger-non-alpha", "card"],
  ["--primary", "primary"],
  ["--primary-foreground", "primaryForeground"],
  ["--secondary", "muted"],
  ["--secondary-foreground", "foreground"],
  ["--muted", "muted"],
  ["--muted-foreground", "mutedForeground"],
  ["--accent", "accent"],
  ["--accent-foreground", "accentForeground"],
  ["--destructive", "destructive"],
  ["--border", "border"],
  ["--input", "border"],
  ["--ring", "interactive"],
  ["--stella-animation-color-1", "interactive"],
  ["--stella-animation-color-2", "success"],
  ["--stella-animation-color-3", "warning"],
  ["--text-interactive-base", "textInteractive"],

  ["--text-strong", "textStrong"],
  ["--text-base", "textBase"],
  ["--text-weak", "textWeak"],
  ["--text-weaker", "textWeaker"],
  ["--border-strong", "borderStrong"],
  ["--border-base", "borderBase"],
  ["--border-weak", "borderWeak"],
  ["--surface-inset", "surfaceInset"],
  ["--surface-raised", "surfaceRaised"],
  ["--surface-raised-hover", "surfaceRaisedHover"],
  ["--button-secondary-base", "buttonSecondaryBase"],
  ["--button-secondary-hover", "buttonSecondaryHover"],
  ["--overlay-surface", "overlaySurface"],
  ["--overlay-border", "overlayBorder"],
  ["--overlay-border-strong", "overlayBorderStrong"],
  ["--panel-surface-bg", "panelSurfaceBg"],
  ["--panel-surface-bg-top", "panelSurfaceBgTop"],
  ["--panel-surface-bg-bottom", "panelSurfaceBgBottom"],
  ["--panel-surface-border", "panelSurfaceBorder"],
  ["--panel-surface-border-hover", "panelSurfaceBorderHover"],
  ["--panel-surface-highlight-color", "panelSurfaceHighlight"],
  ["--select-fill", "selectFill"],
  ["--select-border", "selectBorder"],
  ["--chat-user-bubble-fill", "chatUserBubbleFill"],
  ["--chat-user-bubble-text", "chatUserBubbleText"],
  ["--chat-assistant-bubble-fill-top", "chatAssistantBubbleFillTop"],
  ["--chat-assistant-bubble-fill-bottom", "chatAssistantBubbleFillBottom"],
  ["--chat-assistant-bubble-text", "chatAssistantBubbleText"],
];

function applyThemeToDocument(
  colors: ThemeColors,
  isDark: boolean,
  flat: boolean,
  themeId: string,
  baseThemeId?: string,
) {
  const root = document.documentElement;

  root.classList.toggle("dark", isDark);
  root.dataset.theme = themeId;
  // Overlay themes (Custom) inherit the base theme's CSS tuning via
  // `data-base-theme`, while `data-theme="custom"` stays available for any
  // custom styling written on top.
  if (baseThemeId && baseThemeId !== themeId) {
    root.dataset.baseTheme = baseThemeId;
  } else {
    delete root.dataset.baseTheme;
  }
  root.style.setProperty("color-scheme", isDark ? "dark" : "light");

  const tokens = deriveTokens(colors, isDark, { flat });
  for (const [cssVar, key] of TOKEN_VARS) {
    root.style.setProperty(cssVar, tokens[key]);
  }
}

// ─── Persistence helpers ─────────────────────────────────────────────────

function readStorage<T extends string>(key: string, fallback: T): T {
  return (uiState.getItem(key) as T) ?? fallback;
}

// ─── useThemePersistence — shared UI state + storage-event sync ──────────

interface PersistedThemeState {
  themeId: string;
  customBase: string | null;
  colorMode: ColorMode;
  gradientMode: GradientMode;
  gradientColor: GradientColor;
  systemMode: "light" | "dark";
  setThemeId: (id: string) => void;
  setCustomBase: (id: string) => void;
  setColorMode: (mode: ColorMode) => void;
  setGradientMode: (mode: GradientMode) => void;
  setGradientColor: (color: GradientColor) => void;
}

function useThemePersistence(clearPreviews: () => void): PersistedThemeState {
  const [themeId, setThemeIdRaw] = useState(() =>
    migrateThemeId(readStorage(THEME_STORAGE_KEY, defaultTheme.id)),
  );
  const [customBase, setCustomBaseRaw] = useState<string | null>(() =>
    migrateThemeId(uiState.getItem(CUSTOM_BASE_STORAGE_KEY)),
  );
  const [colorMode, setColorModeRaw] = useState<ColorMode>(
    () =>
      readLegacyForcedAppearance() ??
      readStorage<ColorMode>(COLOR_MODE_STORAGE_KEY, "light"),
  );
  const [gradientMode, setGradientModeRaw] = useState(() =>
    readStorage<GradientMode>(GRADIENT_MODE_STORAGE_KEY, "soft"),
  );
  const [gradientColor, setGradientColorRaw] = useState(() =>
    readStorage<GradientColor>(GRADIENT_COLOR_STORAGE_KEY, "relative"),
  );
  const [systemMode, setSystemMode] = useState<"light" | "dark">(
    getSystemColorMode,
  );

  useEffect(() => {
    if (!window.electronAPI) return;
    if (!window.electronAPI.theme.listInstalled) return;
    window.electronAPI.theme
      .listInstalled()
      .then((installed) => {
        if (Array.isArray(installed)) {
          for (const t of installed) registerTheme(t);
        }
      })
      .catch((err) => {
        console.debug(
          "[theme] Failed to load installed themes:",
          (err as Error).message,
        );
      });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setSystemMode(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // One-time migration of legacy "light"/"dark" theme selections. The init
  // state above already reflects the migrated values; here we persist them so
  // the migration is durable and does not re-fire, carrying the pinned
  // appearance onto the Appearance mode toggle to preserve the current look.
  useEffect(() => {
    const legacy = readLegacyForcedAppearance();
    if (!legacy) return;
    const rawTheme = uiState.getItem(THEME_STORAGE_KEY);
    if (rawTheme === "light" || rawTheme === "dark")
      uiState.setItem(THEME_STORAGE_KEY, "default");
    const rawBase = uiState.getItem(CUSTOM_BASE_STORAGE_KEY);
    if (rawBase === "light" || rawBase === "dark")
      uiState.setItem(CUSTOM_BASE_STORAGE_KEY, "default");
    uiState.setItem(COLOR_MODE_STORAGE_KEY, legacy);
    setColorModeRaw(legacy);
  }, []);

  // Cross-window and cross-host changes arrive as synthetic `storage` events
  // dispatched by the shared UI state client.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && e.newValue) {
        setThemeIdRaw(migrateThemeId(e.newValue));
        clearPreviews();
      } else if (e.key === CUSTOM_BASE_STORAGE_KEY && e.newValue) {
        setCustomBaseRaw(migrateThemeId(e.newValue));
        clearPreviews();
      } else if (e.key === COLOR_MODE_STORAGE_KEY && e.newValue)
        setColorModeRaw(e.newValue as ColorMode);
      else if (e.key === GRADIENT_MODE_STORAGE_KEY && e.newValue) {
        setGradientModeRaw(e.newValue as GradientMode);
        clearPreviews();
      } else if (e.key === GRADIENT_COLOR_STORAGE_KEY && e.newValue) {
        setGradientColorRaw(e.newValue as GradientColor);
        clearPreviews();
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [clearPreviews]);

  const setThemeId = useCallback((id: string) => {
    setThemeIdRaw(id);
    uiState.setItem(THEME_STORAGE_KEY, id);
  }, []);
  const setCustomBase = useCallback((id: string) => {
    setCustomBaseRaw(id);
    uiState.setItem(CUSTOM_BASE_STORAGE_KEY, id);
  }, []);
  const setColorMode = useCallback((mode: ColorMode) => {
    setColorModeRaw(mode);
    uiState.setItem(COLOR_MODE_STORAGE_KEY, mode);
  }, []);
  const setGradientMode = useCallback((mode: GradientMode) => {
    setGradientModeRaw(mode);
    uiState.setItem(GRADIENT_MODE_STORAGE_KEY, mode);
  }, []);
  const setGradientColor = useCallback((color: GradientColor) => {
    setGradientColorRaw(color);
    uiState.setItem(GRADIENT_COLOR_STORAGE_KEY, color);
  }, []);

  return {
    themeId,
    customBase,
    colorMode,
    gradientMode,
    gradientColor,
    systemMode,
    setThemeId,
    setCustomBase,
    setColorMode,
    setGradientMode,
    setGradientColor,
  };
}

// ─── useThemePreview — temporary preview state ───────────────────────────

interface ThemePreviewState {
  previewThemeId: string | null;
  previewGradientMode: GradientMode | null;
  previewGradientColor: GradientColor | null;
  setPreviewTheme: (id: string) => void;
  cancelThemePreview: () => void;
  setPreviewGradientMode: (mode: GradientMode) => void;
  cancelGradientModePreview: () => void;
  setPreviewGradientColor: (color: GradientColor) => void;
  cancelGradientColorPreview: () => void;
  clearAll: () => void;
}

function useThemePreview(): ThemePreviewState {
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
  const [previewGradientMode, setPreviewGradientModeRaw] =
    useState<GradientMode | null>(null);
  const [previewGradientColor, setPreviewGradientColorRaw] =
    useState<GradientColor | null>(null);

  const setPreviewTheme = useCallback((id: string) => {
    if (getThemeById(id)) setPreviewThemeId(id);
  }, []);
  const cancelThemePreview = useCallback(() => setPreviewThemeId(null), []);
  const setPreviewGradientMode = useCallback(
    (mode: GradientMode) => setPreviewGradientModeRaw(mode),
    [],
  );
  const cancelGradientModePreview = useCallback(
    () => setPreviewGradientModeRaw(null),
    [],
  );
  const setPreviewGradientColor = useCallback(
    (color: GradientColor) => setPreviewGradientColorRaw(color),
    [],
  );
  const cancelGradientColorPreview = useCallback(
    () => setPreviewGradientColorRaw(null),
    [],
  );
  const clearAll = useCallback(() => {
    setPreviewThemeId(null);
    setPreviewGradientModeRaw(null);
    setPreviewGradientColorRaw(null);
  }, []);

  return {
    previewThemeId,
    previewGradientMode,
    previewGradientColor,
    setPreviewTheme,
    cancelThemePreview,
    setPreviewGradientMode,
    cancelGradientModePreview,
    setPreviewGradientColor,
    cancelGradientColorPreview,
    clearAll,
  };
}

// ─── ThemeProvider ───────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preview = useThemePreview();
  const persisted = useThemePersistence(preview.clearAll);
  const availableThemes = useSyncExternalStore(
    subscribeThemes,
    getThemesSnapshot,
    getThemesSnapshot,
  );

  // ─ Custom overlay two-phase model ─
  // Phase 1 (Custom unpopulated): the user is always on Custom; picking a theme
  // only changes the base it displays. Phase 2 (an agent populated Custom): the
  // stored id is literal, so picking a stock theme actually leaves Custom.
  const customTheme = getThemeById("custom");
  const customPopulated = customTheme?.populated === true;

  // The base Custom displays: the user's saved pick, else a legacy stored stock
  // id, else Custom's declared default base.
  const customBaseId =
    persisted.customBase && getThemeById(persisted.customBase)
      ? persisted.customBase
      : persisted.themeId !== "custom" && getThemeById(persisted.themeId)
        ? persisted.themeId
        : (customTheme?.base ?? defaultTheme.id);

  const effectiveActiveId = customPopulated ? persisted.themeId : "custom";
  const selectedThemeId = customPopulated ? persisted.themeId : customBaseId;

  const activeThemeId = preview.previewThemeId ?? effectiveActiveId;
  const theme = getThemeById(activeThemeId) ?? defaultTheme;
  const userResolvedColorMode =
    persisted.colorMode === "system"
      ? persisted.systemMode
      : persisted.colorMode;
  // Custom inherits colors, forced mode, and flatness from the base it
  // currently displays. The stock Default theme is `flat` (solid surface, no
  // blob) but has no `forcedMode`, so its light↔dark follows the mode toggle.
  // Any `forcedMode`-pinned theme still ignores the mode toggle and the
  // Gradient controls.
  const { colors, baseThemeId, forcedMode, flat } = resolveThemeColors(
    theme,
    userResolvedColorMode === "dark",
    theme.id === "custom" ? customBaseId : undefined,
  );
  const resolvedColorMode = forcedMode ?? userResolvedColorMode;
  const effectiveGradientMode = flat
    ? "flat"
    : (preview.previewGradientMode ?? persisted.gradientMode);
  const effectiveGradientColor =
    preview.previewGradientColor ?? persisted.gradientColor;

  // Normalize legacy/stock selections onto Custom while it is unpopulated, so
  // the instant a redesign populates Custom the user is already on it.
  const { themeId: rawThemeId, setCustomBase, setThemeId } = persisted;
  useEffect(() => {
    if (customPopulated) return;
    if (rawThemeId === "custom") return;
    setCustomBase(rawThemeId);
    setThemeId("custom");
  }, [customPopulated, rawThemeId, setCustomBase, setThemeId]);

  // Layout effect: the derived tokens are the only definition of the text,
  // border, and surface ramps (the stylesheet no longer computes them), so
  // they must be on the root before the first paint.
  useLayoutEffect(() => {
    applyThemeToDocument(
      colors,
      resolvedColorMode === "dark",
      flat,
      theme.id,
      baseThemeId,
    );
  }, [colors, resolvedColorMode, flat, theme.id, baseThemeId]);

  const readValue = useMemo<ThemeReadValue>(
    () => ({
      theme,
      themeId: effectiveActiveId,
      selectedThemeId,
      colorMode: persisted.colorMode,
      resolvedColorMode,
      forcedMode,
      flat,
      gradientMode: effectiveGradientMode,
      gradientColor: effectiveGradientColor,
      colors,
      themes: availableThemes,
    }),
    [
      theme,
      effectiveActiveId,
      selectedThemeId,
      persisted.colorMode,
      resolvedColorMode,
      forcedMode,
      flat,
      effectiveGradientMode,
      effectiveGradientColor,
      colors,
      availableThemes,
    ],
  );

  const controlValue = useMemo<ThemeControlValue>(
    () => ({
      setTheme: (id: string) => {
        if (customPopulated) {
          persisted.setThemeId(id);
        } else {
          // Phase 1: picking a theme just changes what Custom displays.
          persisted.setCustomBase(id);
          if (persisted.themeId !== "custom") persisted.setThemeId("custom");
        }
        preview.cancelThemePreview();
      },
      setColorMode: persisted.setColorMode,
      setGradientMode: (mode: GradientMode) => {
        persisted.setGradientMode(mode);
        preview.cancelGradientModePreview();
      },
      setGradientColor: (color: GradientColor) => {
        persisted.setGradientColor(color);
        preview.cancelGradientColorPreview();
      },
      previewTheme: preview.setPreviewTheme,
      cancelThemePreview: preview.cancelThemePreview,
      previewGradientMode: preview.setPreviewGradientMode,
      cancelGradientModePreview: preview.cancelGradientModePreview,
      previewGradientColor: preview.setPreviewGradientColor,
      cancelGradientColorPreview: preview.cancelGradientColorPreview,
      cancelPreview: preview.clearAll,
    }),
    [persisted, preview, customPopulated],
  );

  return (
    <ThemeReadContext.Provider value={readValue}>
      <ThemeControlContext.Provider value={controlValue}>
        {children}
      </ThemeControlContext.Provider>
    </ThemeReadContext.Provider>
  );
}

/** Read-only theme values. Most components should use this. */
export function useTheme(): ThemeReadValue {
  const context = useContext(ThemeReadContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

/** Theme mutation and preview controls. Only used by theme pickers. */
export function useThemeControl(): ThemeControlValue {
  const context = useContext(ThemeControlContext);
  if (!context) {
    throw new Error("useThemeControl must be used within a ThemeProvider");
  }
  return context;
}
