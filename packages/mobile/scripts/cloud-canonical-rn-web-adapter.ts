/**
 * Bun acceptance adapter for the React Native imports reached by the mobile
 * chat hook. Product code still consumes the normal `react-native` specifier;
 * the acceptance preload redirects only that specifier to this RN Web surface.
 */
// @ts-expect-error react-native-web ships runtime code without declarations.
export * from "react-native-web";
// @ts-expect-error react-native-web ships runtime code without declarations.
import * as ReactNativeWeb from "react-native-web";

export const LayoutAnimation =
  "LayoutAnimation" in ReactNativeWeb
    ? (ReactNativeWeb as unknown as { LayoutAnimation: unknown })
        .LayoutAnimation
    : {
        Types: { spring: "spring" },
        configureNext: () => undefined,
      };

export const TurboModuleRegistry = {
  get: () => null,
  getEnforcing: (name: string): never => {
    throw new Error(`Native TurboModule unavailable in RN Web: ${name}`);
  },
};
