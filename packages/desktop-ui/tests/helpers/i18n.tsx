import type { ReactElement, ReactNode } from "react";

import { LocalI18nProvider } from "@/shared/i18n/I18nProvider";

export function withI18n(node: ReactNode): ReactElement {
  return <LocalI18nProvider>{node}</LocalI18nProvider>;
}

export function I18nWrapper({ children }: { children: ReactNode }) {
  return <LocalI18nProvider>{children}</LocalI18nProvider>;
}
