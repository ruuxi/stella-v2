import * as SecureStore from "expo-secure-store";
import {
  AUTOMATIC_EXECUTION_TARGET,
  type AutomaticExecutionTarget,
} from "./execution-placement";

const KEY = "stella-mobile.execution-target.v1";
export { AUTOMATIC_EXECUTION_TARGET };

/**
 * The phone offers Cloud or a specific computer. Nothing saved, or the old
 * "Automatic" choice, means Cloud.
 */
export const CLOUD_EXECUTION_TARGET: AutomaticExecutionTarget = Object.freeze({
  mode: "cloud",
});
const CLOUD = CLOUD_EXECUTION_TARGET;

const parse = (value: string | null): AutomaticExecutionTarget => {
  if (!value) return CLOUD;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.mode === "cloud") return { mode: "cloud" };
    if (
      parsed.mode === "device" &&
      typeof parsed.deviceId === "string" &&
      parsed.deviceId.trim()
    ) {
      return { mode: "device", deviceId: parsed.deviceId.trim() };
    }
    return CLOUD;
  } catch {
    return CLOUD;
  }
};

const setAtOf = (value: string | null): number => {
  if (!value) return 0;
  try {
    const setAt = (JSON.parse(value) as Record<string, unknown>).setAt;
    return typeof setAt === "number" && Number.isFinite(setAt) ? setAt : 0;
  } catch {
    return 0;
  }
};

export const getMobileExecutionTarget = async () =>
  parse(await SecureStore.getItemAsync(KEY));

/** When the saved choice was made, so a later orchestrator switch can win. */
export const getMobileExecutionTargetSetAt = async () =>
  setAtOf(await SecureStore.getItemAsync(KEY));

export const setMobileExecutionTarget = async (
  target: AutomaticExecutionTarget,
  setAt: number = Date.now(),
) => {
  const normalized = parse(JSON.stringify(target));
  await SecureStore.setItemAsync(
    KEY,
    JSON.stringify({ ...normalized, setAt }),
  );
  return normalized;
};
