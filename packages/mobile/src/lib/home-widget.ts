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

  if (Platform.OS !== "ios") {
    widgetFailed = true;
    return null;
  }
  if (!requireOptionalNativeModule("ExpoWidgets")) {
    widgetFailed = true;
    return null;
  }
  try {

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

export function updateStellaWidget(props: StellaWidgetProps): void {
  const widget = loadWidget();
  if (!widget) return;
  try {
    widget.updateSnapshot(props);
  } catch {

  }
}
