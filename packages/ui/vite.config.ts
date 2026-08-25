import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The explorer is built ahead of publishing and shipped as static files, so
 * installing Backstory needs no toolchain and `backstory graph` starts at once.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:7777' } },
});
