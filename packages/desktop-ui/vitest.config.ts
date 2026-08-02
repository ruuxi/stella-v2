import { defineConfig } from 'vitest/config';
import path from 'path';

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
          include: [
            'tests/runtime/**/*.{test,spec}.{ts,tsx}',
            'tests/app/**/*.{test,spec}.{ts,tsx}',
            // Effect-runtime tests live inside packages/runtime because
            // `effect` is fenced there (check-boundary.mjs bans it from
            // desktop-ui, tests included).
            '../runtime/tests/**/*.{test,spec}.ts',
          ],
        },
        resolve: {
          alias: [
            { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
          ],
        },
      },
    ],
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
    ],
  },
});
