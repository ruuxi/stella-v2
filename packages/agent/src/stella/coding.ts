/**
 * The agent's file and shell tools: pi-durable's read, write, edit and bash
 * under the names Stella's prompts use. They reach files and processes only
 * through the conversation's ExecutionEnv, so the same tools work on this
 * computer, in a cloud container, or on another device.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export const STELLA_CODING_EXTENSION = "stella-coding";
export const STELLA_CODING_TOOL_NAMES = ["Bash", "Read", "Write", "Edit"] as const;

export const StellaCoding = defineExtension({
  name: STELLA_CODING_EXTENSION,
  tools: [
    { ...createBashTool(), name: "Bash" },
    { ...createReadTool(), name: "Read" },
    { ...createWriteTool(), name: "Write" },
    { ...createEditTool(), name: "Edit" },
  ],
});
