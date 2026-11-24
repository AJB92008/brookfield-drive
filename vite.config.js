import { defineConfig } from 'vite';

// Relative base so the build works from any folder (and as a hosted artifact).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 2000 },
});
