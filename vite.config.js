import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { VitePWA } from 'vite-plugin-pwa';

// Short commit SHA, baked in at build time — the app's only version marker
// (footer + diagnostics). It changes on every commit automatically, so it
// can't go stale the way a forgotten `npm version` bump would; the
// hand-bumped semver it replaced has been removed entirely.
const buildSha = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  base: './',
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
  },
  build: {
    manifest: true,
    outDir: 'dist',
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: '.',
      filename: 'sw.js',
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
      },
      manifest: false, // keep the hand-written public/manifest.json as-is
      injectRegister: false, // main.js already registers the SW itself
      devOptions: { enabled: false },
    }),
  ],
});
