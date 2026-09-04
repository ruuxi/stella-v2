/** Website vs desktop vs Vite-without-preload. Vite remaining a desktop
 * renderer host is intentional: do not infer website from a missing preload. */
export type StellaHostKind = "desktop" | "website" | "browser-dev";

const websiteBuild = import.meta.env.VITE_STELLA_WEB_BUILD === "1";

export const stellaHostKind = (): StellaHostKind => {
  if (websiteBuild) return "website";
  if (typeof window !== "undefined" && window.electronAPI) return "desktop";
  return "browser-dev";
};

export const isWebsiteHost = (): boolean => stellaHostKind() === "website";
export const isDesktopHost = (): boolean => stellaHostKind() === "desktop";

const browserCanSelectSpeaker = (): boolean =>
  typeof HTMLMediaElement !== "undefined" &&
  "setSinkId" in HTMLMediaElement.prototype;

export const platformCapabilities = Object.freeze({
  website: websiteBuild,
  onboarding: !websiteBuild,
  nativeBridges: !websiteBuild,
  phoneAccess: !websiteBuild,
  shortcuts: !websiteBuild,
  nativeSettings: !websiteBuild,
  localFiles: !websiteBuild,
  localModels: !websiteBuild,
  realtimeVoice: !websiteBuild,
  browserUploads: websiteBuild,
  automaticExecutionLabel: websiteBuild ? "Automatic" : "This computer",
  canSelectSpeaker: browserCanSelectSpeaker,
});
