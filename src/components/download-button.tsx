"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { reportGoogleAdsDownload } from "@/components/google-ads-tag";

function AppleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
    >
      <path d="M16.365 12.86c-.023-2.36 1.93-3.49 2.018-3.546-1.099-1.606-2.81-1.826-3.42-1.852-1.456-.148-2.84.86-3.58.86-.74 0-1.881-.838-3.094-.815-1.59.024-3.057.926-3.874 2.351-1.652 2.863-.422 7.094 1.188 9.418.787 1.138 1.724 2.418 2.954 2.373 1.187-.048 1.636-.768 3.07-.768 1.434 0 1.84.768 3.094.744 1.28-.024 2.09-1.16 2.872-2.303.906-1.32 1.279-2.6 1.301-2.667-.029-.013-2.495-.957-2.529-3.795zM14.07 5.638c.655-.793 1.097-1.895.976-2.99-.944.038-2.085.628-2.762 1.42-.607.7-1.139 1.82-.995 2.894 1.052.082 2.126-.534 2.781-1.324z" />
    </svg>
  );
}

function WindowsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
    >
      <path d="M3 5.4 11.2 4.3v7.4H3V5.4zm0 13.2v-6.3h8.2v7.4L3 18.6zm9.2-14.4L21 3v8.7h-8.8V4.2zm0 16.8v-8.4H21V21l-8.8-1.2z" />
    </svg>
  );
}

function LinuxIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
    >
      <path d="M12 2c-1.9 0-3.2 1.6-3.2 3.9 0 1.2.3 2.2.3 3.1 0 .9-.6 1.6-1.4 2.7-.9 1.2-2 2.6-2 4.6 0 .5.1.9.3 1.2-.3.3-.5.7-.5 1.2 0 .8.6 1.3 1.4 1.6.8.3 1.8.4 2.7.9.8.5 1.6.9 2.4.9s1.6-.4 2.4-.9c.9-.5 1.9-.6 2.7-.9.8-.3 1.4-.8 1.4-1.6 0-.5-.2-.9-.5-1.2.2-.3.3-.7.3-1.2 0-2-1.1-3.4-2-4.6-.8-1.1-1.4-1.8-1.4-2.7 0-.9.3-1.9.3-3.1C15.2 3.6 13.9 2 12 2zm-1.5 4c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm3 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zM12 9.2c.9 0 1.9.5 1.9 1 0 .3-.4.5-.9.8-.4.2-.7.5-1 .5s-.6-.3-1-.5c-.5-.3-.9-.5-.9-.8 0-.5 1-1 1.9-1z" />
    </svg>
  );
}

// User-facing download URLs live on the trusted stella.sh domain (handled by
// `src/app/download/[platform]/route.ts`) instead of the raw, no-reputation
// Cloudflare R2 bucket host. The route 302-redirects to the real R2 asset, so
// the bytes are unchanged but the click origin the browser sees is stella.sh —
// which reduces SmartScreen friction for the still-unsigned Windows build.
const DOWNLOADS = {
  macArm64: "/download/mac-arm64",
  macX64: "/download/mac-x64",
  windows: "/download/windows",
  linux: "/download/linux",
  arch: "/download/arch",
} as const;

type Platform = "macArm64" | "macX64" | "windows" | "linux";

const ariaLabels: Record<Platform, string> = {
  macArm64: "Download for Mac",
  macX64: "Download for Mac",
  windows: "Download for Windows",
  linux: "Choose a Linux download",
};

type NavigatorUAData = {
  platform?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string; platform?: string }>;
};

function subscribeNoop() {
  return () => {};
}

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "macArm64";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macArm64";
  // Desktop Linux only: exclude Android (and ChromeOS), which report "linux"
  // in the userAgent but should keep their existing mobile/generic path.
  if (
    ua.includes("linux") &&
    !ua.includes("android") &&
    !ua.includes("cros")
  ) {
    return "linux";
  }
  return "windows";
}

// Client-only platform resolution shared by the download button and the
// Windows install-warning note. useSyncExternalStore keeps the SSR markup
// stable ("macArm64") and swaps to the real platform after hydration without a
// cascading setState-in-useEffect re-render.
export function usePlatform(): Platform {
  return useSyncExternalStore<Platform>(
    subscribeNoop,
    detectPlatform,
    () => "macArm64",
  );
}

export function DownloadButton() {
  const platform = usePlatform();

  const [macArchitecture, setMacArchitecture] = useState<"arm64" | "x64">(
    "arm64",
  );
  const resolvedPlatform: Platform =
    platform === "macArm64" && macArchitecture === "x64" ? "macX64" : platform;

  useEffect(() => {
    if (typeof navigator === "undefined" || platform !== "macArm64") {
      return;
    }

    const userAgentData = (navigator as Navigator & { userAgentData?: NavigatorUAData })
      .userAgentData;

    userAgentData
      ?.getHighEntropyValues?.(["architecture", "platform"])
      .then((hints) => {
        const hintPlatform = hints.platform ?? userAgentData.platform ?? "";
        const isMac = hintPlatform.toLowerCase().includes("mac");
        const isIntel = hints.architecture?.toLowerCase() === "x86";

        if (isMac && isIntel) {
          setMacArchitecture("x64");
        }
      })
      .catch(() => {});
  }, [platform]);

  function handleClick(
    e: React.MouseEvent,
    url: (typeof DOWNLOADS)[keyof typeof DOWNLOADS] = DOWNLOADS[resolvedPlatform],
  ) {
    e.preventDefault();
    reportGoogleAdsDownload(url);
  }

  if (resolvedPlatform === "linux") {
    return (
      <details className="download-menu">
        <summary
          className="button button--primary button--download"
          aria-label={ariaLabels.linux}
          title={ariaLabels.linux}
        >
          Download Stella
          <LinuxIcon size={18} />
        </summary>

        <div className="download-menu__options">
          <a
            className="download-menu__option"
            href={DOWNLOADS.linux}
            onClick={(event) => handleClick(event, DOWNLOADS.linux)}
          >
            <strong>AppImage</strong>
            <span>Works on most Linux distributions</span>
          </a>
          <a
            className="download-menu__option"
            href={DOWNLOADS.arch}
            onClick={(event) => handleClick(event, DOWNLOADS.arch)}
          >
            <strong>Arch / Omarchy</strong>
            <span>Native pacman package</span>
          </a>
        </div>
      </details>
    );
  }

  const PlatformIcon =
    resolvedPlatform === "windows"
      ? WindowsIcon
      : AppleIcon;

  return (
    <button
      className="button button--primary button--download"
      onClick={handleClick}
      type="button"
      aria-label={ariaLabels[resolvedPlatform]}
      title={ariaLabels[resolvedPlatform]}
    >
      Download Stella
      <PlatformIcon size={18} />
    </button>
  );
}
