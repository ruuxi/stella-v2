import { useEffect, useRef } from 'react'
import { showToast } from '@/ui/toast'
import { useT, useTPlural } from '@/shared/i18n'

const formatRetryDelay = (
  retryMs: number | undefined,
  tPlural: (
    key: string,
    count: number,
    params?: Record<string, string | number>,
  ) => string,
) => {
  if (!retryMs || retryMs <= 0) {
    return ''
  }

  const seconds = Math.max(1, Math.round(retryMs / 1000))
  // Leading space: this is appended straight onto the preceding sentence.
  return ` ${tPlural('features.browserBridge.retryDelay', seconds)}`
}

export const useStellaBrowserBridgeToast = () => {
  const t = useT()
  const tPlural = useTPlural()
  const lastToastKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const browserApi = window.electronAPI?.browser
    if (!browserApi?.onBridgeStatus) {
      return
    }

    return browserApi.onBridgeStatus((status) => {
      if (status.state === 'connected') {
        lastToastKeyRef.current = null
        return
      }

      if (!status.notifyUser) {
        return
      }

      const toastKey = `${status.state}:${status.attempt}:${status.error ?? ''}`
      if (lastToastKeyRef.current === toastKey) {
        return
      }

      lastToastKeyRef.current = toastKey

      if (status.state === 'host_registration_failed') {
        showToast({
          title: t('features.browserBridge.unavailableTitle'),
          description:
            status.error ??
            t('features.browserBridge.unavailableBody'),
          variant: 'error',
          duration: 9000,
        })
        return
      }

      const description = status.error
        ? `${status.error}.${formatRetryDelay(status.nextRetryMs, tPlural)}`
        : `${t('features.browserBridge.disconnected')}${formatRetryDelay(status.nextRetryMs, tPlural)}`

      showToast({
        title: t('features.browserBridge.connectionLostTitle'),
        description,
        variant: 'error',
        duration: 7000,
      })
    })
  }, [t, tPlural])
}
