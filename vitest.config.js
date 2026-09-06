import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.js rather than merging a `test`
// block into it — that config runs a git subprocess (for the build SHA) and
// the PWA plugin's manifest injection at load time, neither of which a test
// run needs or should pay for on every invocation.
export default defineConfig({
  // format.js references __BUILD_SHA__ at module top level — normally
  // supplied by vite.config.js's `define` at build/dev time. Vitest doesn't
  // load that config, so it needs its own stand-in value here or every test
  // file fails to import the module graph at all.
  define: {
    __BUILD_SHA__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
  },
});
