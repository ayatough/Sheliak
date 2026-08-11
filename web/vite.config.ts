import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; CI sets VITE_BASE accordingly.
  base: process.env.VITE_BASE ?? '/',
  define: {
    // Cache-buster for the stable-named assets (worklet.js, dsp.wasm): they
    // are served with fixed URLs, so without this a redeploy can pair a fresh
    // main bundle with a stale cached worklet for up to the CDN max-age.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
