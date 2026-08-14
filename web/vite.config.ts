import { defineConfig } from 'vitest/config';

/**
 * The preview channel asks not to be indexed. It is the tip of `main` and says
 * so on the page, but a search engine reading only the markup would otherwise
 * have two Sheliaks to choose between and no reason to prefer the released one.
 */
const noindexPreview = {
  name: 'sheliak-noindex-preview',
  transformIndexHtml(html: string): string {
    if (process.env.VITE_SITE_CHANNEL !== 'dev') return html;
    return html.replace('</head>', '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
  },
};

export default defineConfig({
  plugins: [noindexPreview],
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
