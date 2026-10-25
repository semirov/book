import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const apiTarget = process.env.API_ORIGIN ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Source, not dist: the SPA and the server must share one copy of the types.
      '@book/shared': resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: { port: 5174, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssTarget: 'safari16',
  },
});
