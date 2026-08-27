import { I18nManager } from "react-native";
import { isRtlLocale, type Locale } from "./locales";

export const isNativeRTL = (): boolean => I18nManager.isRTL;

export const needsDirectionFlip = (locale: Locale): boolean =>
  isRtlLocale(locale) !== I18nManager.isRTL;

const reload = async (): Promise<void> => {
  try {

    const Updates = await import("expo-updates");
    await Updates.reloadAsync();
    return;
  } catch {

  }
  try {
    const { DevSettings } = await import("react-native");
    DevSettings.reload();
  } catch {

  }
};

export const applyLayoutDirection = async (
  locale: Locale,
): Promise<boolean> => {
  const shouldBeRTL = isRtlLocale(locale);
  if (shouldBeRTL === I18nManager.isRTL) return false;
  I18nManager.allowRTL(shouldBeRTL);
  I18nManager.forceRTL(shouldBeRTL);
  await reload();
  return true;
};

export const syncLayoutDirection = (locale: Locale): void => {
  if (isRtlLocale(locale) === I18nManager.isRTL) return;
  void applyLayoutDirection(locale);
};
