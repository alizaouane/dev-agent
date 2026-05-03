import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    exclude: ['__tests__/e2e/**'],
    globals: false,
    server: {
      deps: {
        // next-auth uses bare `next/server` imports that Node's ESM resolver
        // can't follow extensionless. Inline it so the Vite alias below applies.
        inline: ['next-auth', '@auth/core'],
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // next-auth imports `next/server` without an extension; Vite's ESM resolver
      // can't resolve that against `next`'s extensionless package.json, so map it
      // to the actual entry file.
      'next/server': resolve(__dirname, '../node_modules/next/server.js'),
    },
  },
});
