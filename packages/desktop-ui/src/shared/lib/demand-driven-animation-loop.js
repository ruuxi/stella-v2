/** A restart-safe rAF loop whose callbacks are requested only at its FPS cap. */
export const createDemandDrivenAnimationLoop = ({ cancelFrame = cancelAnimationFrame, clearTimer = window.clearTimeout, maxFramesPerSecond, now = performance.now.bind(performance), onFrame, requestFrame = requestAnimationFrame, setTimer = window.setTimeout, }) => {
    const frameIntervalMs = 1000 / Math.max(1, maxFramesPerSecond);
    const displayFrameMs = 1000 / 60;
    let frameId;
    let timerId;
    let lastFrameAt;
    let running = false;
    const requestNextFrame = () => {
        timerId = undefined;
        if (!running || frameId !== undefined)
            return;
        frameId = requestFrame(runFrame);
    };
    const scheduleNextFrame = () => {
        if (!running)
            return;
        const elapsed = lastFrameAt === undefined ? frameIntervalMs : now() - lastFrameAt;
        // Wake before the next eligible display frame. Waiting the full interval
        // and then waiting for rAF would turn a 30 fps cap into roughly 15 fps.
        const wakeAheadMs = Math.min(displayFrameMs, frameIntervalMs / 2);
        const delayMs = Math.max(0, frameIntervalMs - elapsed - wakeAheadMs);
        if (delayMs <= 1) {
            requestNextFrame();
            return;
        }
        timerId = setTimer(requestNextFrame, delayMs);
    };
    function runFrame(time) {
        frameId = undefined;
        if (!running)
            return;
        lastFrameAt = time;
        onFrame(time);
        scheduleNextFrame();
    }
    return {
        isRunning: () => running,
        start: () => {
            if (running)
                return;
            running = true;
            lastFrameAt = undefined;
            requestNextFrame();
        },
        stop: () => {
            running = false;
            if (frameId !== undefined)
                cancelFrame(frameId);
            if (timerId !== undefined)
                clearTimer(timerId);
            frameId = undefined;
            timerId = undefined;
            lastFrameAt = undefined;
        },
    };
};
