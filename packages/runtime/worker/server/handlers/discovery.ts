import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { WorkerNotInitializedError } from "../errors.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

// Discovery (onboarding signal collection) loads on first call: its modules,
// with json5 and the browser-data zod schemas, are ~180 KB of bundled JS the
// worker would otherwise parse at every boot.
const initializedSession = WorkerSessions.sessionOrFail(
  () => new WorkerNotInitializedError(),
);

export const discoveryHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA]: (params) =>
    Effect.flatMap(initializedSession, (session) =>
      fromPromise(async () => {
        const payload =
          (params as
            | { selectedBrowser?: string; selectedProfile?: string }
            | undefined) ?? {};
        const { collectBrowserData, formatBrowserDataForSynthesis } =
          await import("../../../discovery/browser-data.js");
        const data = await collectBrowserData(
          session.config.get().stellaDataDirPath,
          {
            selectedBrowser: payload.selectedBrowser as
              | import("../../../discovery/browser-data.js").BrowserType
              | undefined,
            selectedProfile: payload.selectedProfile,
          },
        );
        return { data, formatted: formatBrowserDataForSynthesis(data) };
      }),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS]: (params) =>
    Effect.flatMap(initializedSession, (session) =>
      fromPromise(async () => {
        const payload =
          (params as
            | {
                categories?: string[];
                selectedBrowser?: string;
                selectedProfile?: string;
              }
            | undefined) ?? {};
        const { collectAllSignals } = await import(
          "../../../discovery/collect-all.js"
        );
        return await collectAllSignals(
          session.config.get().stellaDataDirPath,
          payload.categories as
            | import("@stella/contracts/discovery").DiscoveryCategory[]
            | undefined,
          payload.selectedBrowser,
          payload.selectedProfile,
        );
      }),
    ),
};
