type ApiResizeParams = {
  maxLongEdge: number
  maxShortEdge: number
  maxPixels: number
  multipleOf: number
}

export const API_RESIZE_PARAMS: ApiResizeParams = {
  maxLongEdge: 1600,
  maxShortEdge: 900,
  maxPixels: 1600 * 900,
  multipleOf: 2,
}

const clampToMultiple = (value: number, multipleOf: number) => {
  const rounded = Math.round(value / multipleOf) * multipleOf
  return Math.max(multipleOf, rounded)
}

export function targetImageSize(
  width: number,
  height: number,
  params: ApiResizeParams = API_RESIZE_PARAMS,
): [number, number] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [params.multipleOf, params.multipleOf]
  }

  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const pixelCount = width * height

  const scale = Math.min(
    1,
    params.maxLongEdge / longEdge,
    params.maxShortEdge / shortEdge,
    Math.sqrt(params.maxPixels / pixelCount),
  )

  const targetWidth = clampToMultiple(width * scale, params.multipleOf)
  const targetHeight = clampToMultiple(height * scale, params.multipleOf)
  return [targetWidth, targetHeight]
}

export function computeTargetDims(
  logicalWidth: number,
  logicalHeight: number,
  scaleFactor: number,
): [number, number] {
  const physicalWidth = Math.max(1, Math.round(logicalWidth * scaleFactor))
  const physicalHeight = Math.max(1, Math.round(logicalHeight * scaleFactor))
  return targetImageSize(physicalWidth, physicalHeight, API_RESIZE_PARAMS)
}
