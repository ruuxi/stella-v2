import {
  RuntimeHostAdapter,
} from "./runtime-host-adapter.js";
import type {
  RuntimeHostHandlers,
  StellaRuntimeHostOptions,
} from "@stella/runtime/host";

export type StellaHostRunner = RuntimeHostAdapter;

export type StellaHostRunnerOptions = StellaRuntimeHostOptions;

export const createStellaHostRunner = (
  options: StellaRuntimeHostOptions,
): StellaHostRunner => new RuntimeHostAdapter(options);

export type { RuntimeHostHandlers };
