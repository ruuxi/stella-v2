import { Platform, View, type ViewStyle, type StyleProp } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import Feather from "@expo/vector-icons/Feather";

/**
 * Cross-platform icon wrapper that renders SF Symbols on iOS and falls
 * back to Feather on Android / web. Every call site passes a single
 * `name` from `IconName` which we translate to both libraries.
 */
export type IconName =
  | "menu"
  | "plus"
  | "x"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "arrow-up"
  | "arrow-up-right"
  | "mic"
  | "mic-off"
  | "check"
  | "image"
  | "video"
  | "file"
  | "file-text"
  | "git-branch"
  | "box"
  | "panel-top"
  | "message-square"
  | "monitor"
  | "cpu"
  | "volume-2"
  | "volume-x"
  | "pause"
  | "play"
  | "settings"
  | "more-horizontal"
  | "search"
  | "user"
  | "stop"
  | "eye"
  | "eye-off"
  | "copy"
  | "share"
  | "wifi-off"
  | "camera"
  | "smartphone"
  | "edit-3"
  | "globe"
  | "terminal"
  | "sparkles"
  | "clock"
  | "refresh-cw"
  | "alert-circle";

const FEATHER_NAMES: Record<
  IconName,
  React.ComponentProps<typeof Feather>["name"]
> = {
  menu: "menu",
  plus: "plus",
  x: "x",
  "chevron-down": "chevron-down",
  "chevron-left": "chevron-left",
  "chevron-right": "chevron-right",
  "arrow-up": "arrow-up",
  "arrow-up-right": "arrow-up-right",
  mic: "mic",
  "mic-off": "mic-off",
  check: "check",
  image: "image",
  video: "video",
  file: "file",
  "file-text": "file-text",
  "git-branch": "git-branch",
  box: "box",
  "panel-top": "monitor",
  "message-square": "message-square",
  monitor: "monitor",
  cpu: "cpu",
  "volume-2": "volume-2",
  "volume-x": "volume-x",
  pause: "pause",
  play: "play",
  settings: "settings",
  "more-horizontal": "more-horizontal",
  search: "search",
  user: "user",
  stop: "square",
  eye: "eye",
  "eye-off": "eye-off",
  copy: "copy",
  share: "share",
  "wifi-off": "wifi-off",
  camera: "camera",
  smartphone: "smartphone",
  "edit-3": "edit-3",
  globe: "globe",
  terminal: "terminal",
  sparkles: "zap",
  clock: "clock",
  "refresh-cw": "refresh-cw",
  "alert-circle": "alert-circle",
};

const SYMBOL_NAMES: Record<IconName, SymbolViewProps["name"]> = {
  menu: "line.3.horizontal",
  plus: "plus",
  x: "xmark",
  "chevron-down": "chevron.down",
  "chevron-left": "chevron.left",
  "chevron-right": "chevron.right",
  "arrow-up": "arrow.up",
  "arrow-up-right": "arrow.up.right",
  mic: "mic",
  "mic-off": "mic.slash",
  check: "checkmark",
  image: "photo",
  video: "video",
  file: "doc",
  "file-text": "doc.text",
  "git-branch": "arrow.triangle.branch",
  box: "cube",
  "panel-top": "rectangle.topthird.inset.filled",
  "message-square": "message",
  monitor: "desktopcomputer",
  cpu: "cpu",
  "volume-2": "speaker.wave.2",
  "volume-x": "speaker.slash",
  pause: "pause.fill",
  play: "play.fill",
  settings: "gearshape",
  "more-horizontal": "ellipsis",
  search: "magnifyingglass",
  user: "person.crop.circle",
  stop: "stop.fill",
  eye: "eye",
  "eye-off": "eye.slash",
  copy: "doc.on.doc",
  share: "square.and.arrow.up",
  "wifi-off": "wifi.slash",
  camera: "camera",
  smartphone: "iphone",
  "edit-3": "pencil",
  globe: "globe",
  terminal: "terminal",
  sparkles: "sparkles",
  clock: "clock",
  "refresh-cw": "arrow.clockwise",
  "alert-circle": "exclamationmark.circle",
};

type IconProps = {
  name: IconName;
  size: number;
  color: string;
  /** Pass "monochrome" (default), "hierarchical", or "multicolor" for SF Symbols. */
  tintMode?: "monochrome" | "hierarchical" | "multicolor";
  /** Symbol effect for SF Symbols (e.g. "bounce", "pulse"). iOS 17+. */
  effect?: "bounce" | "pulse";
  /** Use the filled variant on iOS when available (we tack on `.fill`). */
  filled?: boolean;
  weight?: SymbolViewProps["weight"];
  style?: StyleProp<ViewStyle>;
};

export function Icon({
  name,
  size,
  color,
  tintMode = "monochrome",
  effect,
  filled,
  weight = "medium",
  style,
}: IconProps) {
  if (Platform.OS === "ios") {
    const base = SYMBOL_NAMES[name];
    // SF Symbol filled variants follow the `<name>.fill` convention; we only
    // tack it on for symbols that genuinely have a filled glyph.
    const filledName =
      filled &&
      (name === "mic" ||
        name === "x" ||
        name === "user" ||
        name === "message-square")
        ? (`${base}.fill` as SymbolViewProps["name"])
        : base;
    return (
      <View
        style={[
          {
            width: size,
            height: size,
            alignItems: "center",
            justifyContent: "center",
          },
          style,
        ]}
      >
        <SymbolView
          name={filledName}
          size={size}
          tintColor={color}
          type={
            tintMode === "hierarchical"
              ? "hierarchical"
              : tintMode === "multicolor"
                ? "multicolor"
                : "monochrome"
          }
          weight={weight}
          {...(effect ? { animationSpec: { effect: { type: effect } } } : {})}
        />
      </View>
    );
  }
  return (
    <Feather
      name={FEATHER_NAMES[name]}
      size={size}
      color={color}
      style={style}
    />
  );
}
