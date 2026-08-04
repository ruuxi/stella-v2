import { RuntimeHostAdapter, } from "./runtime-host-adapter.js";
export const createStellaHostRunner = (options) => new RuntimeHostAdapter(options);
