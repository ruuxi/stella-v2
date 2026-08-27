import type { MobileDisplayPayload } from "../types";
import type { Colors } from "../theme/colors";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

export const AGENT_ACTIVITY_INK = {
  glyphInk: "textStrong",
  titleInk: "text",
  runningRestAlpha: 0.8,
  pillBorderInk: "textMuted",
} as const satisfies {
  glyphInk: keyof Colors;
  titleInk: keyof Colors;
  runningRestAlpha: number;
  pillBorderInk: keyof Colors;
};

export type AgentActivityGlyph = "star" | "check" | "arrow";

export type AgentActivityRowModel = {

  working: boolean;

  glyph: AgentActivityGlyph;

  title: string;
};

export const FILE_PILL_CAP = 5;

export const deriveFilePillRow = <T>(
  files: readonly T[],
  expanded: boolean,
): { visible: T[]; hiddenCount: number } =>
  expanded || files.length <= FILE_PILL_CAP
    ? { visible: [...files], hiddenCount: 0 }
    : {
        visible: files.slice(0, FILE_PILL_CAP),
        hiddenCount: files.length - FILE_PILL_CAP,
      };

export const deriveAgentActivityRow = (
  payload: Pick<AgentWorkPayload, "state" | "title" | "followUp" | "failed">,
): AgentActivityRowModel => {
  const working = payload.state === "running";
  const glyph: AgentActivityGlyph =
    !working && payload.followUp === true
      ? "arrow"
      : !working && payload.failed !== true
        ? "check"
        : "star";
  return { working, glyph, title: payload.title };
};
