import * as SecureStore from "expo-secure-store";
import type { AutomaticExecutionTarget } from "./execution-placement";

const KEY = "stella-mobile.execution-target.v1";
export const AUTOMATIC_EXECUTION_TARGET: AutomaticExecutionTarget =
  Object.freeze({ mode: "automatic" });

const parse = (value: string | null): AutomaticExecutionTarget => {
  if (!value) return AUTOMATIC_EXECUTION_TARGET;
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
  } catch {
    // Default below.
  }
  return AUTOMATIC_EXECUTION_TARGET;
};

export const getMobileExecutionTarget = async () =>
  parse(await SecureStore.getItemAsync(KEY));

export const setMobileExecutionTarget = async (
  target: AutomaticExecutionTarget,
) => {
  const normalized = parse(JSON.stringify(target));
  await SecureStore.setItemAsync(KEY, JSON.stringify(normalized));
  return normalized;
};
