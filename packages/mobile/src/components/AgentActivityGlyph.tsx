import Svg, { Path } from "react-native-svg";

export const STELLA_STAR_PATH =
  "M12 2 C12.9 8.2 15.8 11.1 22 12 C15.8 12.9 12.9 15.8 12 22 C11.1 15.8 8.2 12.9 2 12 C8.2 11.1 11.1 8.2 12 2 Z";

export function StellaStarGlyph({
  size = 13,
  color,
}: {
  size?: number;

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
