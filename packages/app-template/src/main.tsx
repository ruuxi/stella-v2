import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { stella } from "@stella/apps-sdk";

void stella?.user.get().then((user) => {
  document.documentElement.dataset.stellaUser = user.anonymous
    ? "anonymous"
    : "signed-in";
});

if (new URLSearchParams(window.location.search).has("stella-platform-check") && stella) {
  void (async () => {
    const output = document.createElement("output");
    output.id = "stella-platform-check";
    output.setAttribute("aria-live", "polite");
    output.hidden = true;
    document.body.append(output);
    try {
      const user = await stella.user.get();
      await stella.storage.set("platform-check", { roundTrip: true });
      const stored = await stella.storage.get<{ roundTrip: boolean }>("platform-check");
      const proxied = await stella.fetch(new URL("/healthz", window.location.origin).href, {
        binary: true,
      });
      const proxyBytes = (await proxied.arrayBuffer()).byteLength;
      let quotaError = "";
      try {
        await stella.storage.set("platform-check-too-large", "x".repeat(17 * 1024));
      } catch (error) {
        quotaError = error instanceof Error ? error.message : String(error);
      }
      output.value = JSON.stringify({
        user,
        storageRoundTrip: stored?.roundTrip === true,
        proxyStatus: proxied.status,
        proxyMarker: proxied.headers.get("x-stella-proxy"),
        proxyBytes,
        quotaError,
      });
    } catch (error) {
      output.value = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
