import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { Widget } from "expo-widgets";

type StellaWidgetProps = {
  paired: boolean;
  online: boolean;
  platform?: string;
};

let cachedWidget: Widget<StellaWidgetProps> | null = null;
let widgetFailed = false;

const loadWidget = (): Widget<StellaWidgetProps> | null => {
  if (cachedWidget) return cachedWidget;
  if (widgetFailed) return null;
  // expo-widgets is iOS-only and ExpoWidgets is unavailable in Expo Go;
  // degrade gracefully when the native module is missing.
  if (Platform.OS !== "ios") {
    widgetFailed = true;
    return null;
  }
  if (!requireOptionalNativeModule("ExpoWidgets")) {
    widgetFailed = true;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../widgets/StellaWidget") as {
      default: Widget<StellaWidgetProps>;
    };
    cachedWidget = mod.default;
    return cachedWidget;
  } catch {
    widgetFailed = true;
    return null;
  }
};

/**
 * Push the latest pairing/bridge snapshot to the home-screen widget.
 * No-ops when widgets aren't available on this build/device.
 */
export function updateStellaWidget(props: StellaWidgetProps): void {
  const widget = loadWidget();
  if (!widget) return;
  try {
    widget.updateSnapshot(props);
  } catch {
    // best-effort
  }
}
