let cachedLowPower: boolean | undefined;

const hasForcedLowPowerFlag = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("lowPower") === "1";
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isLowPowerDevice(): boolean {
  if (cachedLowPower !== undefined) return cachedLowPower;
  if (hasForcedLowPowerFlag()) {
    cachedLowPower = true;
    return true;
  }
  if (typeof navigator === "undefined") return false;

  const cores =
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 0;
  const memory =
    typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as { deviceMemory?: number }).deviceMemory!
      : 0;
  const platform =
    typeof navigator.platform === "string" ? navigator.platform : "";
  const userAgent =
    typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const isWindows = /^Win/i.test(platform) || /\bWindows\b/i.test(userAgent);

  cachedLowPower =
    (cores > 0 && cores <= 4) ||
    (memory > 0 && memory <= 4) ||
    (isWindows && memory > 0 && memory <= 8);
  return cachedLowPower;
}

export function shouldUseLowPowerEffects(): boolean {
  return prefersReducedMotion() || isLowPowerDevice();
}

export function applyLowPowerDocumentFlag(): void {
  if (typeof document === "undefined") return;
  if (shouldUseLowPowerEffects()) {
    document.documentElement.dataset.lowPower = "true";
  } else {
    delete document.documentElement.dataset.lowPower;
  }
}
