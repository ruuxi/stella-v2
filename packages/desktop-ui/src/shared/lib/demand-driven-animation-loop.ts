export type DemandDrivenAnimationLoop = {
  isRunning: () => boolean;
  start: () => void;
  stop: () => void;
};

type DemandDrivenAnimationLoopOptions = {
  cancelFrame?: (id: number) => void;
  clearTimer?: (id: number) => void;
  maxFramesPerSecond: number;
  now?: () => number;
  onFrame: (time: number) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
};

export const createDemandDrivenAnimationLoop = ({
  cancelFrame = cancelAnimationFrame,
  clearTimer = window.clearTimeout,
  maxFramesPerSecond,
  now = performance.now.bind(performance),
  onFrame,
  requestFrame = requestAnimationFrame,
  setTimer = window.setTimeout,
}: DemandDrivenAnimationLoopOptions): DemandDrivenAnimationLoop => {
  const frameIntervalMs = 1000 / Math.max(1, maxFramesPerSecond);
  const displayFrameMs = 1000 / 60;
  let frameId: number | undefined;
  let timerId: number | undefined;
  let lastFrameAt: number | undefined;
  let running = false;

  const requestNextFrame = () => {
    timerId = undefined;
    if (!running || frameId !== undefined) return;
    frameId = requestFrame(runFrame);
  };

  const scheduleNextFrame = () => {
    if (!running) return;
    const elapsed =
      lastFrameAt === undefined ? frameIntervalMs : now() - lastFrameAt;

    const wakeAheadMs = Math.min(displayFrameMs, frameIntervalMs / 2);
    const delayMs = Math.max(0, frameIntervalMs - elapsed - wakeAheadMs);
    if (delayMs <= 1) {
      requestNextFrame();
      return;
    }
    timerId = setTimer(requestNextFrame, delayMs);
  };

  function runFrame(time: number) {
    frameId = undefined;
    if (!running) return;
    lastFrameAt = time;
    onFrame(time);
    scheduleNextFrame();
  }

  return {
    isRunning: () => running,
    start: () => {
      if (running) return;
      running = true;
      lastFrameAt = undefined;
      requestNextFrame();
    },
    stop: () => {
      running = false;
      if (frameId !== undefined) cancelFrame(frameId);
      if (timerId !== undefined) clearTimer(timerId);
      frameId = undefined;
      timerId = undefined;
      lastFrameAt = undefined;
    },
  };
};
