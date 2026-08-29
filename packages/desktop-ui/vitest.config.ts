import { defineConfig } from 'vitest/config';
import path from 'path';

const aliases = [
  { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
  {
    find: /^@stella\/contracts\/browser-bridge-status$/,
    replacement: path.resolve(__dirname, '../contracts/browser-bridge-status.ts'),
  },
];

const jsdomTests = [
  'tests/app/**/*.test.tsx',
  'tests/app/apps/user-apps-registry.test.ts',
  'tests/app/chat/chat-history-pagination.test.ts',
  'tests/app/chat/context-message-metadata.test.ts',
  'tests/app/chat/pretext-row-measure.test.ts',
  'tests/app/global/auth-session-revalidation.test.ts',
  'tests/app/global/billing-capabilities.test.ts',
  'tests/app/shell/chat-shell-ui-contract.test.ts',
  'tests/app/shell/conversation-topbar-contract.test.ts',
  'tests/app/shell/shell-topbar-header-layout-contract.test.ts',
  'tests/app/shell/sidebar-nav-model.test.ts',
  'tests/app/chat/working-indicator-animation-budget.test.ts',
  'tests/runtime/thread-activity-tab-cache.test.ts',
  'tests/runtime/use-conversation-messages.test.tsx',
];

export default defineConfig({
  define: {
    'import.meta.env.VITE_CONVEX_URL': JSON.stringify('http://127.0.0.1:3210'),
  },
  test: {
    globals: true,
    server: {
      deps: {
        inline: true,
      },
    },
    projects: [
      {
        test: {
          name: 'runtime',
          environment: 'node',
          setupFiles: [path.resolve(__dirname, './tests/setup/hermetic-env.ts')],
          include: [
            'tests/runtime/**/*.{test,spec}.{ts,tsx}',
            'tests/app/**/*.{test,spec}.{ts,tsx}',
          ],
          exclude: jsdomTests,
        },
        resolve: {
          alias: aliases,
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          setupFiles: [path.resolve(__dirname, './tests/setup/hermetic-env.ts')],
          include: jsdomTests,
        },
        resolve: {
          alias: aliases,
        },
      },
    ],
  },
  resolve: {
    alias: aliases,
  },
});
