import type { MobileDisplayPayload } from "../types";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

/** What the minimal agent row's leading slot shows. */
export type AgentActivityGlyph = "star" | "check" | "arrow";

export type AgentActivityRowModel = {
  /** Row is live — the title shimmers (the star stays static; no spinner). */
  working: boolean;
  /**
   * Leading-slot status tell, mirroring desktop `BackgroundWorkCard`:
   * star while running (the shimmer alone carries progress), an arrow for a
   * settled `send_input` follow-up, a quiet grey check once done, and the
   * star again for other settled rows — failed/canceled stay plain, with no
   * status glyph.
   */
  glyph: AgentActivityGlyph;
  /** The task DESCRIPTION — the only text on the row face. */
  title: string;
};

/**
 * Presentation model for one minimal agent activity row. Pure — keeps the
 * glyph/shimmer decisions testable away from the component tree.
 */
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
