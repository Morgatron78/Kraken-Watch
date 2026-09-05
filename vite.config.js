import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// Short commit SHA, baked in at build time — see docs/improvement-plan.md
// ("Version/cache-bust mechanism") for why this replaces manual version
// bumping for the footer: it changes on every commit automatically, so it
// can't go stale the way a forgotten `npm version` bump would.
const buildSha = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
      injectRegister: false, // app.js already registers the SW itself
      devOptions: { enabled: false },
    }),
  ],
});
