import { useEffect } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import { hasMobileConfig } from "../src/config/env";
import { requestMainChat } from "../src/lib/main-chat-request";
import { useColors } from "../src/theme/theme-context";

export default function NotFound() {
  const colors = useColors();

  useEffect(() => {
    if (hasMobileConfig) requestMainChat();
  }, []);

  if (!hasMobileConfig) return <Redirect href="/" />;

  return <View style={{ flex: 1, backgroundColor: colors.background }} />;
}
