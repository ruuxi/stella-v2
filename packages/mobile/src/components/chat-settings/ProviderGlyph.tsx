import { StyleSheet, View } from "react-native";
import Svg, { Ellipse, Line, Path } from "react-native-svg";
import type { ModelEngine } from "../../lib/use-cloud-model-settings";
import { useColors, useTheme } from "../../theme/theme-context";

const CLAUDE_RAYS = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5];

/**
 * The mark on a provider card: Stella's star in the accent, Claude's burst in
 * its clay, ChatGPT's knot in ink. Drawn here rather than shipped as images so
 * the tiles follow the theme.
 */
export function ProviderGlyph({
  engine,
  size = 30,
}: {
  engine: ModelEngine;
  size?: number;
}) {
  const colors = useColors();
  const { isDark } = useTheme();
  const tile = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.3),
  };
  const mark = size * 0.62;

  if (engine === "stella") {
    return (
      <View style={[styles.tile, tile, { backgroundColor: colors.accentSoft }]}>
        <Svg width={mark} height={mark} viewBox="0 0 24 24">
          <Path
            d="M12 2.5c.6 4.9 2.6 7 9.5 9.5-6.9 2.5-8.9 4.6-9.5 9.5-.6-4.9-2.6-7-9.5-9.5 6.9-2.5 8.9-4.6 9.5-9.5z"
            fill={colors.accent}
          />
        </Svg>
      </View>
    );
  }

  if (engine === "anthropic") {
    const ink = isDark ? "#EC8B65" : "#C96442";
    return (
      <View
        style={[
          styles.tile,
          tile,
          { backgroundColor: isDark ? "#4A2E24" : "#F6E3DA" },
        ]}
      >
        <Svg width={mark} height={mark} viewBox="0 0 24 24">
          {CLAUDE_RAYS.map((angle, index) => (
            <Line
              key={angle}
              x1={12}
              y1={index % 2 ? 5.5 : 3}
              x2={12}
              y2={index % 2 ? 18.5 : 21}
              stroke={ink}
              strokeWidth={2.6}
              strokeLinecap="round"
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
        </Svg>
      </View>
    );
  }

  const ink = isDark ? "#000000" : "#FFFFFF";
  return (
    <View
      style={[
        styles.tile,
        tile,
        { backgroundColor: isDark ? "#F5F5F7" : "#1D1D1F" },
      ]}
    >
      <Svg width={mark} height={mark} viewBox="0 0 24 24">
        {[0, 60, 120].map((angle) => (
          <Ellipse
            key={angle}
            cx={12}
            cy={12}
            rx={8.5}
            ry={4.2}
            stroke={ink}
            strokeWidth={1.7}
            fill="none"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
});
