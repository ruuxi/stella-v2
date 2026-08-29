import { StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import {
  STELLA_MARK_CENTER,
  STELLA_MARK_VIEWBOX,
  STELLA_MARK_VIEWBOX_SPAN,
} from "./geometry";

export const VIEWBOX_SPAN = STELLA_MARK_VIEWBOX_SPAN;
export const VIEWBOX_MIN = -15;

export function MarkLayer({
  d,
  size,
  gradientId,
}: {
  d: string;
  size: number;
  gradientId: string;
}) {
  return (
    <Svg
      pointerEvents="none"
      width={size}
      height={size}
      viewBox={STELLA_MARK_VIEWBOX}
      style={StyleSheet.absoluteFill}
    >
      <Defs>
        <LinearGradient
          id={gradientId}
          x1={STELLA_MARK_CENTER}
          y1={VIEWBOX_MIN + VIEWBOX_SPAN}
          x2={STELLA_MARK_CENTER}
          y2={VIEWBOX_MIN}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset={0} stopColor="#00aad8" />
          <Stop offset={0.25} stopColor="#3493d9" />
          <Stop offset={0.5} stopColor="#4878db" />
          <Stop offset={0.75} stopColor="#7449c5" />
          <Stop offset={1} stopColor="#be57a4" />
        </LinearGradient>
      </Defs>
      <Path d={d} fill={`url(#${gradientId})`} />
    </Svg>
  );
}
