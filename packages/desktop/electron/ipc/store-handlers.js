import { promises as fs } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
const listInstalledThemes = async (stellaDataDir) => {
    const themesDir = path.join(stellaDataDir, "themes");
    try {
        const files = await fs.readdir(themesDir);
        const themes = [];
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const raw = await fs.readFile(path.join(themesDir, file), "utf-8");
                const theme = JSON.parse(raw);
                if (theme.id && theme.name && theme.light && theme.dark) {
                    themes.push(theme);
                }
            }
            catch {
                // Skip invalid theme files.
            }
        }
        return themes;
    }
    catch {
        return [];
    }
};
export const registerStoreHandlers = (options) => {
    const waitForRunner = (timeoutMs = 10_000) => waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs,
        unavailableMessage: "Store backend is unavailable.",
        onRunnerChanged: options.onStellaHostRunnerChanged,
    });
    const withStoreRunner = async (event, channel, action) => {
        assertPrivilegedRequest(options, event, channel);
        return await action(await waitForRunner());
    };
    const assertStoreWebRequest = (event, channel) => {
        if (!options.assertStoreWebSender?.(event, channel)) {
            throw new Error(`Blocked untrusted IPC call to ${channel}`);
        }
    };
    ipcMain.handle("storeWeb:getEmbedConfig", async (event) => {
        assertPrivilegedRequest(options, event, "storeWeb:getEmbedConfig");
        return options.getStoreWebEmbedConfig?.() ?? null;
    });
    ipcMain.handle("storeWeb:getAuthToken", async (event) => {
        assertStoreWebRequest(event, "storeWeb:getAuthToken");
        return (await options.getStoreAuthToken?.()) ?? null;
    });
    ipcMain.handle("storeWeb:openSignIn", async (event) => {
        assertStoreWebRequest(event, "storeWeb:openSignIn");
        if (!options.dispatchStoreWebLocalAction) {
            throw new Error("The local Store bridge is unavailable.");
        }
        return await options.dispatchStoreWebLocalAction({ type: "openSignIn" });
    });
    ipcMain.handle("storeWeb:showToast", async (event, payload) => {
        assertStoreWebRequest(event, "storeWeb:showToast");
        if (!options.dispatchStoreWebLocalAction) {
            throw new Error("The local Store bridge is unavailable.");
        }
        return await options.dispatchStoreWebLocalAction({
            type: "showToast",
            payload,
        });
    });
    ipcMain.handle("theme:listInstalled", async () => {
        const stellaDataDir = options.getStellaDataDir();
        return stellaDataDir ? await listInstalledThemes(stellaDataDir) : [];
    });
    ipcMain.handle("store:listPackages", async (event) => await withStoreRunner(event, "store:listPackages", async (runner) => (await runner.listStorePackages())));
    ipcMain.handle("store:getPackage", async (event, payload) => await withStoreRunner(event, "store:getPackage", async (runner) => (await runner.getStorePackage(payload.packageId))));
    ipcMain.handle("store:listReleases", async (event, payload) => await withStoreRunner(event, "store:listReleases", async (runner) => (await runner.listStorePackageReleases(payload.packageId))));
    ipcMain.handle("store:getRelease", async (event, payload) => await withStoreRunner(event, "store:getRelease", async (runner) => (await runner.getStorePackageRelease(payload.packageId, payload.releaseNumber))));
};
