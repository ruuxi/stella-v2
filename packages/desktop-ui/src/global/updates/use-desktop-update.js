import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
/**
 * Reactive desktop-update awareness.
 *
 * - `installManifest` is the parsed `stella-install.json` written by the
 *   launcher (contains `desktopReleaseCommit` — the upstream GitHub SHA
 *   cloned for the installation).
 * - `currentRelease` is the latest published release for this platform,
 *   pushed reactively over Convex by the CI publish job.
 * - `updateAvailable` is true when the published commit differs from the
 *   commit that's installed locally.
 *
 * The hook is intentionally read-only — applying the update spawns an
 * `install_update` agent thread (see `applyDesktopUpdate.ts`).
 */
const platformKeyForCurrentEnv = (electronPlatform, arch) => {
    if (electronPlatform === "darwin") {
        return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    }
    if (electronPlatform === "win32") {
        return "win-x64";
    }
    return "linux-x64";
};
const detectPlatformKey = () => {
    // `electronAPI.platform` and `electronAPI.arch` are forwarded from
    // `process.platform` / `process.arch` by the preload script — the
    // authoritative source. UA sniffing for "ARM" was guesswork; if it
    // returned the wrong key the install would silently report no
    // updates available because the Convex `currentDesktopRelease` query
    // is keyed by exact platform.
    const electronApi = (typeof window !== "undefined" ? window.electronAPI : null) ?? null;
    const electronPlatform = electronApi?.platform ?? "darwin";
    const arch = electronApi?.arch ?? "x64";
    return platformKeyForCurrentEnv(electronPlatform, arch);
};
export const useDesktopUpdate = () => {
    const platform = useMemo(() => detectPlatformKey(), []);
    const [installManifest, setInstallManifest] = useState(null);
    const refreshManifest = useCallback(async (knownManifest) => {
        if (knownManifest) {
            setInstallManifest(knownManifest);
            return;
        }
        const electronApi = window.electronAPI;
        if (!electronApi?.updates?.getInstallManifest) {
            setInstallManifest(null);
            return;
        }
        try {
            const next = await electronApi.updates.getInstallManifest();
            setInstallManifest(next);
        }
        catch {
            setInstallManifest(null);
        }
    }, []);
    useEffect(() => {
        void refreshManifest();
    }, [refreshManifest]);
    const currentRelease = useQuery(api.data.desktop_releases.currentDesktopRelease, { platform });
    const installedCommit = installManifest?.installState?.desktopReleaseCommit ??
        installManifest?.desktopReleaseCommit ??
        null;
    const publishedCommit = currentRelease?.commit ?? null;
    const updateAvailable = Boolean(publishedCommit && installedCommit && publishedCommit !== installedCommit);
    // If the install-update agent restarted Electron before the renderer's
    // run-finished handler could record the applied commit, the manifest is
    // left stale on next launch and the pill keeps nagging. Reconcile by
    // asking the main process to record the published commit. The IPC handler
    // accepts either real Git ancestry or a clean locally promoted build whose
    // tracked package version covers the published release; otherwise it
    // throws and the pill remains visible.
    const reconcileAttemptedFor = useRef(null);
    useEffect(() => {
        if (!updateAvailable || !publishedCommit || !currentRelease)
            return;
        if (reconcileAttemptedFor.current === publishedCommit)
            return;
        reconcileAttemptedFor.current = publishedCommit;
        const electronApi = window.electronAPI;
        const recordAppliedCommit = electronApi?.updates?.recordAppliedCommit;
        if (!recordAppliedCommit)
            return;
        void (async () => {
            try {
                const manifest = await recordAppliedCommit(publishedCommit, currentRelease.tag);
                setInstallManifest(manifest);
            }
            catch {
                // Expected when HEAD really isn't at the target yet — leave the
                // pill visible so the user can apply the update normally.
            }
        })();
    }, [updateAvailable, publishedCommit, currentRelease]);
    return {
        installManifest,
        currentRelease: currentRelease ?? null,
        installedCommit,
        publishedCommit,
        updateAvailable,
        refreshManifest,
    };
};
