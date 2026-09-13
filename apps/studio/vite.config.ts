import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // Terrain builds hold multi-megabyte typed arrays; chunk warnings at the
    // default 500 KB are pure noise for an app that ships a 3D renderer.
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5180,
  },
});
