import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; CI sets VITE_BASE accordingly.
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
