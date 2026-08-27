import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const CLOSE_DELAY_MS = 160

export function useHoverPreview<T extends HTMLElement>() {
  const triggerRef = useRef<T | null>(null)
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const openNow = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [cancelClose])

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return undefined

    trigger.addEventListener("mouseenter", openNow)
    trigger.addEventListener("mouseleave", scheduleClose)
    trigger.addEventListener("focus", openNow)
    trigger.addEventListener("blur", scheduleClose)
    return () => {
      trigger.removeEventListener("mouseenter", openNow)
      trigger.removeEventListener("mouseleave", scheduleClose)
      trigger.removeEventListener("focus", openNow)
      trigger.removeEventListener("blur", scheduleClose)
    }
  }, [openNow, scheduleClose])

  useEffect(() => cancelClose, [cancelClose])

  const previewProps = useMemo(
    () => ({ onMouseEnter: openNow, onMouseLeave: scheduleClose }),
    [openNow, scheduleClose],
  )

  return { triggerRef, open, previewProps }
}
