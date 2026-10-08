/**
 * Subscribes to every succeeded media job for the current viewer and
 * materializes its outputs into `~/.stella/media/outputs/`. This is the single
 * place that turns a remote media job (started by `image_gen`, by an
 * agent's `stella-media`, by the music player, …) into a local file plus a
 * `DisplayPayload` the sidebar can render when the user opens it.
 *
 * Decoupling production from materialization is what makes "all generated
 * media is available in the workspace panel" robust: it doesn't matter who
 * `curl`'d the managed media API — every job lives in the owner's backend
 * object (`media.jobs`), this hook drains the queue, and downstream UI
 * subscribes to a single payload stream.
 */

import { useEffect, useMemo, useRef } from "react"
import { useBackendView } from "@/platform/backend/use-backend-view"
import type { MediaJob } from "@stella/contracts/backend/media"
import { mediaModel } from "@stella/contracts/media-models"
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state"
import type {
  DisplayPayload,
  DisplayTabPayload,
  MediaAsset,
} from "@stella/contracts/desktop/display-payload"
import {
  extractOutput,
  saveOutputToStella,
  type OutputMedia,
} from "./media-output"
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload"
import { showToast } from "@/ui/toast"
import { imageGenerationFailureKey } from "./media-error-copy"
import { useT } from "@/shared/i18n"
import {
  capInMemory,
  failedNotifiedJobs,
  markMediaJobMaterialized,
  materializedJobs,
  persistFailedNotifiedJobs,
  publishMaterializedMediaPayload,
} from "./media-materializer-state"

export {
  markMediaJobMaterialized,
  publishMaterializedMediaPayload,
  useMaterializedMediaPayload,
  useMaterializedMediaPayloadSnapshot,
} from "./media-materializer-state"

const toMediaAsset = (output: OutputMedia): MediaAsset | null => {
  switch (output.kind) {
    case "image": {
      const filePaths = output.localPaths?.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
      if (!filePaths || filePaths.length === 0) return null
      return { kind: "image", filePaths }
    }
    case "video":
      if (!output.localPath) return null
      return { kind: "video", filePath: output.localPath }
    case "audio":
      if (!output.localPath) return null
      return { kind: "audio", filePath: output.localPath }
    case "download":
      if (!output.localPath) return null
      // Treat 3D-ish extensions as model3d; everything else stays as download.
      if (/\.(glb|gltf|obj|stl)$/i.test(output.localPath)) {
        return { kind: "model3d", filePath: output.localPath, label: output.label }
      }
      return {
        kind: "download",
        filePath: output.localPath,
        label: output.label,
      }
    case "text":
      return { kind: "text", text: output.text }
    case "unknown":
      return null
  }
}

type UseMediaMaterializerOptions = {
  onMaterialized: (payload: DisplayTabPayload) => void
}

/**
 * Mounts the global media materializer. Safe to call once at the root level.
 * The query is gated on auth; while signed-out it sits idle.
 */
export const useMediaMaterializer = ({
  onMaterialized,
}: UseMediaMaterializerOptions): void => {
  const t = useT()
  const { hasConnectedAccount } = useAuthSessionState()

  // Stable boot timestamp so we don't re-materialize the entire history on
  // every reload. We reach back ~10 minutes to forgive crashes/restarts that
  // happened during a long-running job.
  const bootSince = useMemo(() => Date.now() - 10 * 60 * 1000, [])

  const onPayloadRef = useRef(onMaterialized)
  onPayloadRef.current = onMaterialized

  const inFlightRef = useRef<Set<string>>(new Set())

  const jobs: MediaJob[] | undefined = useBackendView(
    "media.jobs",
    hasConnectedAccount
      ? { since: bootSince, status: "succeeded", limit: 50 }
      : "skip",
  ).value

  const failedJobs: MediaJob[] | undefined = useBackendView(
    "media.jobs",
    hasConnectedAccount ? { since: bootSince, status: "failed", limit: 50 } : "skip",
  ).value

  useEffect(() => {
    if (!jobs || jobs.length === 0) return

    // Process oldest-first so multiple completions in one tick land in the
    // right order in the sidebar.
    const ordered = [...jobs].sort(
      (a, b) =>
        (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt),
    )

    for (const job of ordered) {
      if (materializedJobs.has(job.jobId)) continue
      if (inFlightRef.current.has(job.jobId)) continue
      if (job.output === undefined) continue

      inFlightRef.current.add(job.jobId)

      void (async () => {
        try {
          const extracted = extractOutput(job.output)
          if (extracted.kind === "unknown") return

          const saved = await saveOutputToStella(extracted, job.jobId)
          const asset = toMediaAsset(saved)
          if (!asset) return

          const completedAt = job.completedAt ?? job.updatedAt
          const payload: DisplayPayload = {
            kind: "media",
            asset,
            jobId: job.jobId,
            madeBy: mediaModel(job.model)?.name ?? job.model,
            ...(typeof job.input.prompt === "string"
              ? { prompt: job.input.prompt }
              : {}),
            createdAt: completedAt,
          }

          publishMaterializedMediaPayload(payload)
          markMediaJobMaterialized(job.jobId)

          if (payload.asset.kind === "image") {
            openDisplayPayloadTab(payload, {
              activate: false,
            })
          }

          onPayloadRef.current(payload)
        } catch {
          // Swallow per-job errors; we'll retry on the next subscription
          // tick (entry stays out of the materialized set).
        } finally {
          inFlightRef.current.delete(job.jobId)
        }
      })()
    }
  }, [bootSince, jobs])

  useEffect(() => {
    if (!failedJobs || failedJobs.length === 0) return

    const ordered = [...failedJobs].sort(
      (a, b) =>
        (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt),
    )

    for (const job of ordered) {
      if (job.kind !== "image") continue
      if (failedNotifiedJobs.has(job.jobId)) continue
      failedNotifiedJobs.add(job.jobId)
      // Bound the in-memory set, matching the persist-time cap.
      capInMemory(failedNotifiedJobs)
      persistFailedNotifiedJobs()
      showToast({
        title: t(imageGenerationFailureKey(job.error)),
        variant: "error",
      })
    }
  }, [failedJobs, t])
}
