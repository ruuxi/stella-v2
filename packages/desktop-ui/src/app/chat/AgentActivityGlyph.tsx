/**
 * Leading glyph for the minimal in-chat agent activity rows.
 *
 * Stella's own agents get a lightweight vector echo of the aurora star —
 * the brand mark's six-ray pose (a tall vertical axis plus four shorter
 * diagonal arms, the shader's symmetrical rest pose) drawn as plain SVG
 * wedges in `currentColor`, no WebGL. When the agent runs on an external
 * provider (Claude / Codex / …) the provider's own icon takes the slot via
 * `AgentModelIcon`, which stays monochrome until the row is hovered.
 */
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import { AgentModelIcon, shouldShowAgentModelIcon } from "./AgentModelIcon";

/** One tapered wedge, tip-out, core-in — see the aurora shader's `starArm`. */
const AXIS_ARM = "M0 -11.2 L1.6 -1.7 L0 0 L-1.6 -1.7 Z";
const DIAGONAL_ARM = "M0 -7.4 L1.45 -1.55 L0 0 L-1.45 -1.55 Z";

export function StellaStarGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="agent-activity-star"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <g transform="translate(12 12)">
        <path d={AXIS_ARM} />
        <path transform="rotate(180)" d={AXIS_ARM} />
        <path transform="rotate(45)" d={DIAGONAL_ARM} />
        <path transform="rotate(135)" d={DIAGONAL_ARM} />
        <path transform="rotate(225)" d={DIAGONAL_ARM} />
        <path transform="rotate(315)" d={DIAGONAL_ARM} />
      </g>
    </svg>
  );
}

export function AgentActivityGlyph({
  snapshot,
  size = 14,
}: {
  snapshot?: AgentModelConfigSnapshot;
  size?: number;
}) {
  return shouldShowAgentModelIcon(snapshot) ? (
    <AgentModelIcon snapshot={snapshot} size={size} />
  ) : (
    <StellaStarGlyph size={size} />
  );
}
