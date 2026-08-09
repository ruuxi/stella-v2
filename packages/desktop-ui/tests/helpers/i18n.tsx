import type { ReactElement, ReactNode } from "react";
// Deep import, not the `@/shared/i18n` barrel: the barrel re-exports
// `RemoteI18nProvider`, which pulls in `convex/react` and the auth
// provider. A test helper must not drag those into every suite that
// only needs English strings — several suites mock `convex/react`
// partially and would fail at module load.
import { LocalI18nProvider } from "@/shared/i18n/I18nProvider";

/**
 * Wrap a tree in the local (English, eagerly-loaded) i18n provider.
 *
 * `useI18n()` deliberately throws when no `<I18nProvider>` is above it — that
 * invariant catches a real production misconfiguration, so tests supply the
 * missing context rather than weakening the contract. `LocalI18nProvider` takes
 * no props and needs no Convex/auth context, unlike the default
 * `I18nProvider`, which pulls a remote preference from Convex.
 *
 * Usage with a raw `react-dom/client` root:
 *
 *   root.render(withI18n(<AppsSection />));
 *
 * Usage as an RTL wrapper:
 *
 *   render(<AppsSection />, { wrapper: I18nWrapper });
 */
export function withI18n(node: ReactNode): ReactElement {
  return <LocalI18nProvider>{node}</LocalI18nProvider>;
}

/** RTL-compatible `wrapper` option / generic provider component. */
export function I18nWrapper({ children }: { children: ReactNode }) {
  return <LocalI18nProvider>{children}</LocalI18nProvider>;
}
