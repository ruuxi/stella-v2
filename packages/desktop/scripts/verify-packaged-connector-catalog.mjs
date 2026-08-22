import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const verifyPackagedConnectorCatalogAssets = ({ resources }) => {
  const catalogPath = path.join(
    resources,
    "runtime",
    "kernel",
    "connectors",
    "oauth-provider-catalog.json",
  );
  const smokePath = path.join(
    resources,
    "runtime",
    "worker",
    "connectors",
    "packaged-smoke.js",
  );

  if (!existsSync(catalogPath)) {
    throw new Error(`Packaged connector catalog is missing: ${catalogPath}`);
  }
  if (!existsSync(smokePath)) {
    throw new Error(
      `Packaged connector catalog smoke is missing: ${smokePath}`,
    );
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Packaged connector catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const outlook = Array.isArray(catalog)
    ? catalog.find((entry) => entry?.id === "outlook")
    : undefined;
  if (!Array.isArray(outlook?.tools) || outlook.tools.length === 0) {
    throw new Error(
      "Packaged connector catalog has no Outlook action catalog; refusing to verify the release.",
    );
  }
  return { catalogPath, smokePath };
};
