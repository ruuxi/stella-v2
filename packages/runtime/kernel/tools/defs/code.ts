/**
 * Public Code tool entrypoint. The implementation retains its legacy module
 * and class names only for transcript/protocol compatibility.
 */
export { createCodeTool } from "./node-repl.js";
export type { CodeToolOptions } from "./node-repl.js";
export { NodeReplKernelRegistry as CodeKernelRegistry } from "../../computer-use/kernel.js";
