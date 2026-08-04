import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { markMediaJobMaterialized, publishMaterializedMediaPayload, useMaterializedMediaPayload, } from "@/app/media/media-materializer-state";
import { extractOutput, saveOutputToStella } from "@/app/media/media-store";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { InlineGeneratedImageCardFrame, requestedSizeFromInput, } from "./InlineGeneratedImageCard";
const normalizeNumImages = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    const rounded = Math.floor(value);
    return rounded >= 1 ? Math.min(rounded, 4) : null;
};
const numImagesFromJobRequest = (input) => normalizeNumImages(input?.num_images);
const mediaPayloadFromJob = async (job) => {
    if (job.output === undefined)
        return null;
    const extracted = extractOutput(job.output);
    if (extracted.kind === "unknown")
        return null;
    const saved = await saveOutputToStella(extracted, job.jobId);
    switch (saved.kind) {
        case "image": {
            const filePaths = saved.localPaths?.filter((p) => typeof p === "string" && p.length > 0);
            if (!filePaths || filePaths.length === 0)
                return null;
            return {
                kind: "media",
                asset: { kind: "image", filePaths },
                jobId: job.jobId,
                capability: job.capability,
                ...(job.request?.prompt ? { prompt: job.request.prompt } : {}),
                ...(job.request?.aspectRatio
                    ? { aspectRatio: job.request.aspectRatio }
                    : {}),
                ...(requestedSizeFromInput(job.request?.input)
                    ? { requestedSize: requestedSizeFromInput(job.request?.input) }
                    : {}),
                ...(numImagesFromJobRequest(job.request?.input)
                    ? { numImages: numImagesFromJobRequest(job.request?.input) }
                    : {}),
                createdAt: job.completedAt ?? job.updatedAt,
            };
        }
        default:
            return null;
    }
};
export function InlineGeneratedImageCardWithJob({ payload, imageIndex = 0, materializeJob = true, layout = "single", sharedStripPending = false, }) {
    const materializedPayload = useMaterializedMediaPayload(payload.jobId);
    const hasResolvedAssets = payload.asset.kind === "image" && payload.asset.filePaths.length > 0;
    const job = useQuery(api.media_jobs.getByJobId, payload.jobId &&
        materializeJob &&
        !materializedPayload &&
        !hasResolvedAssets
        ? { jobId: payload.jobId }
        : "skip");
    useEffect(() => {
        if (!materializeJob)
            return;
        if (!job || job.status !== "succeeded" || !job.output)
            return;
        let cancelled = false;
        void (async () => {
            const completedPayload = await mediaPayloadFromJob(job);
            if (cancelled || !completedPayload)
                return;
            if (publishMaterializedMediaPayload(completedPayload)) {
                openDisplayPayloadTab(completedPayload, {
                    activate: false,
                });
            }
            markMediaJobMaterialized(job.jobId);
        })();
        return () => {
            cancelled = true;
        };
    }, [job, materializeJob]);
    return (<InlineGeneratedImageCardFrame payload={payload} imageIndex={imageIndex} materializeJob={materializeJob} layout={layout} sharedStripPending={sharedStripPending} job={job} materializedPayload={materializedPayload}/>);
}
