import type { ToastOptions } from '@/ui/toast'

type ToastAction = NonNullable<ToastOptions['action']>

export const SIGN_IN_TOAST_ACTION: ToastAction = {
  label: 'Sign in',
  onClick: () => {
    void import('@/router').then(({ router }) => {
      void router.navigate({
        to: '.',
        search: (prev: { dialog?: 'auth' | 'connect' }) => ({
          ...prev,
          dialog: 'auth' as const,
        }),
      })
    })
  },
}

export const OPEN_SETTINGS_TOAST_ACTION: ToastAction = {
  label: 'Open settings',
  onClick: () => {
    void import('@/shell/settings-dialog-store').then(({ settingsDialog }) => {
      settingsDialog.open()
    })
  },
}
