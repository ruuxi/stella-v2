/**
 * Renderer-side type declarations for `window.electronAPI`.
 *
 * The API type is derived from the preload bridge object
 * (`@stella/contracts/desktop/electron-api`), whose payload and result types
 * come from the typed IPC contract (`@stella/contracts/desktop/ipc-contract`).
 * Only what cannot be derived from it is declared here.
 */
import type { ElectronAPI } from "@stella/contracts/desktop/electron-api";
import type { Theme } from "@stella/theme";

export type {
  ChatContext,
  ChatContextFile,
  ChatContextUpdate,
  LocalLlmCredentialSummary,
  VoiceRuntimeSnapshot,
} from "@stella/contracts";
export type { BrowserViewState } from "@stella/contracts/desktop/browser-view";
export type {
  LocalLlmOAuthProviderSummary,
  LockedComputerUseStatus,
  NativeIntegration as ElectronNativeIntegration,
} from "@stella/contracts/desktop/ipc-contract";

/**
 * Main reads installed theme files from disk and only checks that their
 * `id`, `name`, `light` and `dark` fields are present; the renderer registers
 * them as `Theme`s.
 */
export type ElectronApi = Omit<ElectronAPI, "theme"> & {
  theme: { listInstalled: () => Promise<Theme[]> };
};

export type ElectronBrowserViewApi = ElectronApi["browserView"];

declare global {
  interface Window {
    electronAPI?: ElectronApi;
    /**
     * Boot snapshot of the shared UI state KV, delivered before any app code
     * runs (Electron preload `sendSync`, or the Vite dev server's injected
     * inline script for plain-browser tabs).
     */
    __stellaUiState?: Record<string, string>;
  }
}

export {};
