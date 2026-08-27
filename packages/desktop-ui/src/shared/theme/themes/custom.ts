import type { Theme } from "./types";
import defaultTheme from "./default";

const custom: Theme = {
  id: "custom",
  name: "Custom",
  base: "default",
  overrides: { light: {}, dark: {} },
  populated: false,

  light: defaultTheme.light,
  dark: defaultTheme.dark,
};

export default custom;
