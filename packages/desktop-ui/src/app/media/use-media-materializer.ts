import { useEffect, useMemo, useRef } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/api"
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
} from "./media-store"
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

type MaterializerJob = {
  jobId: string
  capability: string
  request?: { prompt?: string }
  output?: unknown
  error?: {
    message?: string
    code?: string
  }
  completedAt?: number
  updatedAt: number
  createdAt: number
}

const IMAGE_CAPABILITIES = new Set(["text_to_image", "image_edit", "icon"])

type UseMediaMaterializerOptions = {
  onMaterialized: (payload: DisplayTabPayload) => void

  suppress?: boolean
}

export const useMediaMaterializer = ({
  onMaterialized,
  suppress = false,
}: UseMediaMaterializerOptions): void => {
  const t = useT()
  const { hasConnectedAccount } = useAuthSessionState()

  const bootSince = useMemo(() => Date.now() - 10 * 60 * 1000, [])

  const onPayloadRef = useRef(onMaterialized)
  onPayloadRef.current = onMaterialized
  const suppressRef = useRef(suppress)
  suppressRef.current = suppress

  const inFlightRef = useRef<Set<string>>(new Set())

  const jobs = useQuery(
    api.media_jobs.listSucceededSince,
    hasConnectedAccount ? { since: bootSince, limit: 50 } : "skip",
  ) as MaterializerJob[] | undefined

  const failedJobs = useQuery(
    api.media_jobs.listFailedSince,
    hasConnectedAccount ? { since: bootSince, limit: 50 } : "skip",
  ) as MaterializerJob[] | undefined

  useEffect(() => {
    if (!jobs || jobs.length === 0) return

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
            capability: job.capability,
            ...(job.request?.prompt ? { prompt: job.request.prompt } : {}),
            createdAt: completedAt,
          }

          publishMaterializedMediaPayload(payload)
          markMediaJobMaterialized(job.jobId)

          if (payload.asset.kind === "image") {
            openDisplayPayloadTab(payload, {
              activate: false,
            })
          }

          if (!suppressRef.current) {
            onPayloadRef.current(payload)
          }
        } catch {

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
      if (!IMAGE_CAPABILITIES.has(job.capability)) continue
      if (failedNotifiedJobs.has(job.jobId)) continue
      failedNotifiedJobs.add(job.jobId)

      capInMemory(failedNotifiedJobs)
      persistFailedNotifiedJobs()
      showToast({
        title: t(imageGenerationFailureKey(job.error)),
        variant: "error",
      })
    }
  }, [failedJobs, t])
}
