import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  define: {
    'import.meta.env.VITE_STELLA_BACKEND_URL': JSON.stringify('http://127.0.0.1:8787'),
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
        },
        resolve: {
          alias: [
            { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
            {
              find: /^@stella\/contracts\/browser-bridge-status$/,
              replacement: path.resolve(__dirname, '../contracts/browser-bridge-status.ts'),
            },
          ],
        },
      },
    ],
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
      {
        find: /^@stella\/contracts\/browser-bridge-status$/,
        replacement: path.resolve(__dirname, '../contracts/browser-bridge-status.ts'),
      },
    ],
  },
});
