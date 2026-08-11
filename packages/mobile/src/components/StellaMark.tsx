import { useId } from "react";
import Svg, {
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
  Use,
} from "react-native-svg";

/**
 * The Stella brand mark, as vector. Shares its geometry with the web
 * `stella-mark` component and `assets/stella-logo.svg`.
 *
 * The outline is painted twice: a fixed vertical hue ramp, then an elliptical
 * fade out to `color`. Passing the surrounding foreground colour is what lets
 * one asset read on both themes - the gradient core blends to black on light
 * and to white on dark, instead of always sinking into black.
 *
 * Web inlines the SVG and lets that fade take `currentColor`. React Native
 * cannot: react-native-svg rejects `currentColor` in gradient stops ("not a
 * valid color"), which drops the fade entirely and leaves the raw hue ramp
 * glowing pink. Hence the explicit `color` prop.
 */
export type StellaMarkProps = {
  /** Rendered edge length in px. */
  size?: number;
  /** Foreground colour the mark fades out to. Pass the theme's text colour. */
  color: string;
};

export function StellaMark({ size = 28, color }: StellaMarkProps) {
  // Gradient ids are per-instance: two marks sharing ids make the second
  // resolve against the first one's gradients, so a dark-theme copy next to a
  // light one silently paints with the wrong fade colour.
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const shape = `${uid}-shape`;
  const core = `${uid}-core`;
  const fade = `${uid}-fade`;
  return (
    <Svg viewBox="0 0 1024 1024" width={size} height={size}>
      <Defs>
        <Path id={shape} d="M474.1 154.1C269 172.2 211.6 334.4 372.3 442C377.4 445.4 377.7 445.3 362.3 447.8C215.3 471.8 127.8 569.9 162 672.2C210.1 816.2 463.2 910.8 632.5 848C759.2 801 768.8 684.2 653.7 590.5C642.2 581.1 641 582.3 665 579C815.2 558.3 903.1 453.7 861 345.6C815.4 228.5 636.1 139.7 474.1 154.1Z M601 245.4C860.8 283.4 917.2 523.1 678 572.4C638.3 580.6 643.8 581.7 610.7 558.7C582.1 538.9 559 531.1 522.5 529.1C490.2 527.2 464.6 518.6 442.6 502C436.1 497.1 435.7 497 438 501.8C453.8 534.5 450.4 575.2 427.6 626.2C424.8 632.5 425.3 633.5 429.1 629.4C490.6 562.9 565.8 559.2 635 619.2C762 729.4 590.3 855.3 383.2 803.9C190.7 756.1 118.4 604 241.5 505.5C284.9 470.7 369 441.2 388.8 453.8C393 456.5 399.3 460.3 402.8 462.4C406.3 464.4 412.6 468.7 416.8 471.9C454.3 500.4 484.7 512.2 527.5 515C547 516.2 560.7 519.2 575.9 525.4C582.1 527.9 587.3 530 587.5 530C587.7 530 586.3 526.7 584.5 522.7C569.2 489.7 572.5 449.2 594 403.3C597.9 394.9 597.9 394.9 592 400.2C588.7 403.1 582.1 409 577.3 413.3C527.7 457.5 472 461.5 420.7 424.6C326.8 357.2 382.1 259.5 523 244.1C535.9 242.7 588.4 243.6 601 245.4Z" />
        <LinearGradient
          id={core}
          x1="0"
          y1="397"
          x2="0"
          y2="631"
          gradientUnits="userSpaceOnUse"
        >
        <Stop offset="0" stopColor="#ff4ac0" />
        <Stop offset="0.1" stopColor="#ff45c3" />
        <Stop offset="0.2" stopColor="#ff46c0" />
        <Stop offset="0.3" stopColor="#a141ff" />
        <Stop offset="0.4" stopColor="#703cff" />
        <Stop offset="0.5" stopColor="#5243ff" />
        <Stop offset="0.6" stopColor="#3164ff" />
        <Stop offset="0.7" stopColor="#0e8aff" />
        <Stop offset="0.8" stopColor="#00b5ff" />
        <Stop offset="0.9" stopColor="#00eeff" />
        <Stop offset="1" stopColor="#4ffff7" />
        </LinearGradient>
        <RadialGradient
          id={fade}
          cx="502"
          cy="539"
          r="112"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(502 539) rotate(50) scale(1 3.05) translate(-502 -539)"
        >
        <Stop offset="0" stopColor={color} stopOpacity={0.0055} />
        <Stop offset="0.0714" stopColor={color} stopOpacity={0.0061} />
        <Stop offset="0.1429" stopColor={color} stopOpacity={0.0071} />
        <Stop offset="0.2143" stopColor={color} stopOpacity={0.0151} />
        <Stop offset="0.2857" stopColor={color} stopOpacity={0.0404} />
        <Stop offset="0.3571" stopColor={color} stopOpacity={0.0872} />
        <Stop offset="0.4286" stopColor={color} stopOpacity={0.164} />
        <Stop offset="0.5" stopColor={color} stopOpacity={0.25} />
        <Stop offset="0.5714" stopColor={color} stopOpacity={0.3639} />
        <Stop offset="0.6429" stopColor={color} stopOpacity={0.5495} />
        <Stop offset="0.7143" stopColor={color} stopOpacity={0.7111} />
        <Stop offset="0.7857" stopColor={color} stopOpacity={0.8253} />
        <Stop offset="0.8571" stopColor={color} stopOpacity={0.9155} />
        <Stop offset="0.9286" stopColor={color} stopOpacity={0.9739} />
        <Stop offset="1" stopColor={color} stopOpacity={0.9885} />
        </RadialGradient>
      </Defs>
      <Use href={`#${shape}`} fill={`url(#${core})`} />
      <Use href={`#${shape}`} fill={`url(#${fade})`} />
    </Svg>
  );
}
