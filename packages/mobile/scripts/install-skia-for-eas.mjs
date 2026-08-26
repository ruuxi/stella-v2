if (process.env.EAS_BUILD === "true") {
  await import("../node_modules/@shopify/react-native-skia/scripts/install-skia.mjs");
}
