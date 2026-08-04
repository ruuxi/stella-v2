import { useEffect, useState } from "react";

const unavailableSnapshot = {
    status: "disabled",
    channel: "latest-v2",
    currentVersion: "",
    availableVersion: null,
    downloadedVersion: null,
    releaseName: null,
    releaseDate: null,
    progress: null,
    checkedAt: null,
    error: null,
};

export const useDesktopUpdate = () => {
    const [snapshot, setSnapshot] = useState(unavailableSnapshot);
    useEffect(() => {
        const updates = window.electronAPI?.updates;
        if (!updates)
            return;
        let disposed = false;
        const unsubscribe = updates.onStateChanged((next) => {
            if (!disposed)
                setSnapshot(next);
        });
        void updates.getState().then((next) => {
            if (!disposed)
                setSnapshot(next);
        }).catch(() => { });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, []);
    return { snapshot };
};
