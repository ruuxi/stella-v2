import { lazy, Suspense } from 'react';
const AuthDialog = lazy(() => import('@/global/auth/AuthDialog').then((module) => ({
    default: module.AuthDialog,
})));
const ConnectDialog = lazy(() => import('@/global/integrations/ConnectDialog').then((module) => ({
    default: module.ConnectDialog,
})));
export function FullShellDialogs({ activeDialog, onDialogOpenChange, }) {
    return (<>
      {activeDialog === 'auth' && (<Suspense fallback={null}>
          <AuthDialog open onOpenChange={onDialogOpenChange}/>
        </Suspense>)}
      {activeDialog === 'connect' && (<Suspense fallback={null}>
          <ConnectDialog open onOpenChange={onDialogOpenChange}/>
        </Suspense>)}
    </>);
}
