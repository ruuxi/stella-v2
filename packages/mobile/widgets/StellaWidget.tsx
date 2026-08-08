import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, padding } from "@expo/ui/swift-ui/modifiers";
import { createWidget } from "expo-widgets";
import type { WidgetEnvironment } from "expo-widgets/build/Widgets.types";

/**
 * Snapshot the app pushes to the home-screen widget: whether a desktop is
 * paired and the last known bridge availability.
 */
export type StellaWidgetProps = {
  paired: boolean;
  online: boolean;
  platform?: string;
};

const ACCENT_LIGHT = "#0A66FF";
const ACCENT_DARK = "#7AB8FF";

const statusFor = (props: StellaWidgetProps): string => {
  if (!props.paired) return "Tap to chat";
  const name = props.platform?.trim() || "Computer";
  return `${name} · ${props.online ? "Connected" : "Asleep"}`;
};

const StellaWidget = (
  props: StellaWidgetProps,
  environment: WidgetEnvironment,
) => {
  "widget";
  const accent =
    environment.colorScheme === "dark" ? ACCENT_DARK : ACCENT_LIGHT;
  const status = statusFor(props);

  if (environment.widgetFamily === "systemMedium") {
    return (
      <HStack modifiers={[padding({ all: 16 })]}>
        <VStack alignment="leading">
          <Text modifiers={[font({ weight: "semibold", size: 17 })]}>
            Ask Stella
          </Text>
          <Text
            modifiers={[
              font({ size: 13 }),
              foregroundStyle("secondary"),
              padding({ top: 2 }),
            ]}
          >
            {status}
          </Text>
        </VStack>
        <Spacer />
        <Image systemName="sparkles" color={accent} size={28} />
      </HStack>
    );
  }

  return (
    <VStack alignment="leading" modifiers={[padding({ all: 14 })]}>
      <Image systemName="sparkles" color={accent} size={22} />
      <Spacer />
      <Text modifiers={[font({ weight: "semibold", size: 15 })]}>
        Ask Stella
      </Text>
      <Text
        modifiers={[
          font({ size: 12 }),
          foregroundStyle("secondary"),
          padding({ top: 1 }),
        ]}
      >
        {status}
      </Text>
    </VStack>
  );
};

export default createWidget<StellaWidgetProps>("StellaWidget", StellaWidget);
