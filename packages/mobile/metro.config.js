// Expo's default Metro config, plus one resolver fallback: shared workspace
// packages (e.g. @stella/contracts) use NodeNext-style `./x.js` specifiers for
// TypeScript sources, which Metro does not map to `./x.ts` on its own.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = config;
