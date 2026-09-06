"use node";

import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { R2 } from "@convex-dev/r2";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalAction } from "./_generated/server";

// CopyObject returns XML. The AWS browser bundle needs DOMParser, which is
// unavailable in Convex's default runtime; Node selects its server XML parser.
// Only the owner-scoped Drive finalizer calls this internal action.
export const copyDriveObject = internalAction({
  args: { stagingR2Key: v.string(), finalR2Key: v.string() },
  returns: v.null(),
  handler: async (_ctx, { stagingR2Key, finalR2Key }) => {
    const r2 = new R2(components.r2);
    const copySource = [r2.config.bucket, ...stagingR2Key.split("/")]
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    await r2.client.send(
      new CopyObjectCommand({
        Bucket: r2.config.bucket,
        CopySource: copySource,
        Key: finalR2Key,
        MetadataDirective: "COPY",
      }),
    );
    return null;
  },
});
