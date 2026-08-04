export const SIGN_IN_TOAST_ACTION = {
    label: 'Sign in',
    onClick: () => {
        void import('@/router').then(({ router }) => {
            void router.navigate({
                to: '.',
                search: (prev) => ({
                    ...prev,
                    dialog: 'auth',
                }),
            });
        });
    },
};
export const OPEN_SETTINGS_TOAST_ACTION = {
    label: 'Open settings',
    onClick: () => {
        void import('@/features/workspace-display/sidebar-sections').then(({ sidebarSections }) => {
            sidebarSections.openLocation('settings', null);
        });
    },
};
