// Minimal lint config with one job: catch identifiers that are referenced
// but never declared, imported, or a known global — the exact class of bug
// that shipped when ev.js was split out of app.js and three cross-module
// imports (rateState, renderDiagnostics, daysElapsedInMonth) were missed.
// Neither `vite build` (Rollup ignores undefined non-import refs) nor
// check-ids (DOM ids only) nor the unit tests (pure functions only) catch
// that; `no-undef` does. Deliberately no style rules and no `no-unused-vars`
// (too noisy against this codebase's intentional catch bindings etc.) — just
// zero-false-positive correctness checks.

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', history: 'readonly',
  fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', queueMicrotask: 'readonly',
  console: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  btoa: 'readonly', atob: 'readonly', performance: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', FileReader: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
  MouseEvent: 'readonly', KeyboardEvent: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly',
  Intl: 'readonly',
};

const nodeGlobals = {
  process: 'readonly', console: 'readonly', URL: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
};

const testGlobals = {
  describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
  beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
  vi: 'readonly',
};

const correctnessRules = {
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'ev-legacy-archive.js', 'octopoints-archive.js'] },

  // App modules (browser), plus the Vite build-time `define` constants.
  {
    files: ['*.js'],
    ignores: ['vite.config.js', 'vitest.config.js', 'sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...browserGlobals, __APP_VERSION__: 'readonly', __BUILD_SHA__: 'readonly' },
    },
    rules: correctnessRules,
  },

  // Service worker — its own global surface (self/caches/skipWaiting/clients),
  // and Workbox's build-time manifest injection point.
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        self: 'readonly', caches: 'readonly', clients: 'readonly',
        skipWaiting: 'readonly', importScripts: 'readonly', fetch: 'readonly',
        Response: 'readonly', Request: 'readonly', URL: 'readonly', console: 'readonly',
      },
    },
    rules: correctnessRules,
  },

  // Build configs and helper scripts run under Node.
  {
    files: ['vite.config.js', 'vitest.config.js', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    rules: correctnessRules,
  },

  // Vitest test files: browser globals (jsdom env) plus the test API.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...browserGlobals, ...testGlobals, __APP_VERSION__: 'readonly', __BUILD_SHA__: 'readonly' },
    },
    rules: correctnessRules,
  },
];
