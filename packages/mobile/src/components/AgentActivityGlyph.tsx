import Svg, { Path } from "react-native-svg";

/**
 * Star glyph for the minimal in-chat agent activity rows — the mobile port of
 * desktop `AgentActivityGlyph.tsx` (the locked-in "candidate A" sampler
 * glyph): a soft four-pointed sparkle with concave curved edges, same path,
 * same 13px default. Renders at FULL strength — solid strong ink, no opacity
 * dimming (desktop `.agent-activity-row__glyph` parity); a translucent grey
 * glyph was too ghostly to read as the row's status tell. Static by design —
 * while a row is running the title shimmer carries the motion, the star just
 * sits quietly in the leading slot.
 */
export const STELLA_STAR_PATH =
  "M12 2 C12.9 8.2 15.8 11.1 22 12 C15.8 12.9 12.9 15.8 12 22 C11.1 15.8 8.2 12.9 2 12 C8.2 11.1 11.1 8.2 12 2 Z";

export function StellaStarGlyph({
  size = 13,
  color,
}: {
  size?: number;
  /** Solid full-strength ink — the row's strong text color. */
  color: string;
}) {
  return (
    <Svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      <Path d={STELLA_STAR_PATH} fill={color} />
    </Svg>
  );
}
