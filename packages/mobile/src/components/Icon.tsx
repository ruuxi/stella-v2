import { Platform, View, type ViewStyle, type StyleProp } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import Feather from "@expo/vector-icons/Feather";

export type IconName =
  | "menu"
  | "plus"
  | "x"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "arrow-up"
  | "arrow-up-right"
  | "arrow-right"
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
  | "rewind-15"
  | "forward-15"
  | "waveform"
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
  | "rotate-ccw"
  | "text-cursor"
  | "quote"
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
  "arrow-right": "arrow-right",
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

  "rewind-15": "rotate-ccw",
  "forward-15": "rotate-cw",
  waveform: "activity",
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
  "rotate-ccw": "rotate-ccw",

  "text-cursor": "type",
  quote: "corner-up-left",
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
  "arrow-right": "arrow.right",
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
  "rewind-15": "gobackward.15",
  "forward-15": "goforward.15",
  waveform: "waveform",
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
  "rotate-ccw": "arrow.counterclockwise",
  "text-cursor": "textformat",
  quote: "text.quote",
  "alert-circle": "exclamationmark.circle",
};

type IconProps = {
  name: IconName;
  size: number;
  color: string;

  tintMode?: "monochrome" | "hierarchical" | "multicolor";

  effect?: "bounce" | "pulse";

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
