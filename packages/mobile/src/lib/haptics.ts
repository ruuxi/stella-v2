import * as Haptics from "expo-haptics";

export const tapLight = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

export const tapMedium = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

export const notifySuccess = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

export const notifyError = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
