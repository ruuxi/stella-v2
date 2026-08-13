import { app } from 'electron';

/**
 * Windows-only compositor workarounds for monitor-level flicker.
 *
 * Symptom being addressed: with Stella focused on Windows (observed on a
 * Ryzen 9 9950X3D + RTX 5090, high-refresh display), the ENTIRE monitor
 * flickers while typing / while text streams in. macOS is unaffected.
 *
 * Root-cause hypothesis (cannot be reproduced on macOS, so this is the
 * highest-probability diagnosis from the known Chromium/Electron issue
 * class): Chromium on Windows presents through DirectComposition, and DWM
 * opportunistically promotes the app's swap chains to hardware overlay
 * planes (MPO — Multi-Plane Overlay). On many NVIDIA driver + high-refresh
 * (especially G-Sync/VRR) setups, the display engine re-latches the whole
 * scanout pipeline every time an overlay plane engages or disengages, which
 * shows up as literal display-level flicker/blackouts. Constant redraw
 * (typing, streamed text, shimmer animations) while focused makes DWM
 * repeatedly re-evaluate overlay promotion — exactly the observed pattern.
 * NVIDIA's own advisory for this issue class is to disable MPO.
 *
 * Fix: pass `--disable-direct-composition` to Chromium on Windows only.
 * Chromium then presents through the plain DXGI path with no DComp visual
 * tree, so DWM never gets overlay-eligible content from Stella and MPO
 * stays out of the picture for our windows. Hardware acceleration, GPU
 * rasterization, and vsync are all unaffected — this only changes the
 * final presentation path. The practical costs (DComp video overlay power
 * savings, delegated-ink latency) are irrelevant for Stella's workload and
 * negligible on the hardware that exhibits the bug.
 *
 * The switch name is current for Electron 43 / Chromium 150
 * (`kDisableDirectComposition` in ui/gl/gl_switches.cc, copied to the GPU
 * process via kGLSwitchesCopiedFromGpuProcessHost).
 *
 * A/B escape hatch: set `STELLA_DISABLE_MPO_FIX=1` in the environment to
 * launch with stock compositing (no switches appended). If the flicker
 * returns with the env var set and disappears without it, the diagnosis is
 * confirmed. Deliberately NOT used: `app.disableHardwareAcceleration()` —
 * a global perf nuke that is not warranted by the evidence.
 *
 * Must be called before the `ready` event (before the GPU process starts).
 */
export const applyWindowsCompositionWorkarounds = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  const disable = process.env.STELLA_DISABLE_MPO_FIX?.trim();
  if (disable === '1' || disable?.toLowerCase() === 'true') {
    console.log(
      '[composition] STELLA_DISABLE_MPO_FIX set — leaving DirectComposition/MPO at Chromium defaults',
    );
    return false;
  }
  app.commandLine.appendSwitch('disable-direct-composition');
  console.log(
    '[composition] Windows MPO flicker workaround active (--disable-direct-composition); set STELLA_DISABLE_MPO_FIX=1 to revert',
  );
  return true;
};
