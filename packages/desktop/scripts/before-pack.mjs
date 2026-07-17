import { promises as fs } from "node:fs";
import path from "node:path";

import { stageHomeSeed } from "./stage-home-seed.mjs";

export default async function beforePack(context) {
  const platform = context.electronPlatformName;
  const { packagedIds, targetRoot } = await stageHomeSeed({ platform });
  await fs.writeFile(
    path.join(path.dirname(targetRoot), "platform.json"),
    `${JSON.stringify({ platform, packagedIds }, null, 2)}\n`,
    "utf-8",
  );
  console.log(
    `[beforePack] Staged ${packagedIds.length} bundled skills for ${platform}.`,
  );
}
