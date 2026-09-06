#!/usr/bin/env node
// Cross-checks every statically-resolvable $('id')/getElementById('id')
// reference in the app's own source against the ids actually available:
// those declared in index.html, plus any id a module assigns to an element
// it builds at runtime (insertAdjacentHTML/template-literal markup with
// id="...", or `el.id = '...'` on a createElement'd node —
// ev-sessions-toggle-wrap, bh-pill-group, and ev-month-partial-note all
// work this way). Exists specifically because of the bill-history-toggle
// bug documented in the README: a DOM/JS drift like this doesn't throw
// until runtime, and only on whichever code path happens to touch the
// missing element — this catches it at build/PR time instead, for free,
// on every push.
//
// Scans every .js file at the repo root except the two Vite/Vitest config
// files — Phase 2 (docs/improvement-plan.md) is actively splitting app.js
// into store.js/format.js/diagnostics.js/etc., and this needs to keep
// covering all of them without a hardcoded file list needing an update
// every time a new module is extracted. (Checked once, live: the first
// version of this script only read app.js, and silently stopped seeing
// roughly a dozen real $()/getElementById() calls the moment they moved
// into store.js/format.js/diagnostics.js — not a missed id, just reduced
// coverage that would have gone unnoticed without deliberately checking.)
//
// Deliberately narrow: only `$('literal')` / `getElementById('literal')`
// with a single/double-quoted or plain (non-interpolated) backtick string
// argument can be checked statically. A template literal with `${...}`
// interpolation (e.g. `${fuel}-week`, common throughout this codebase)
// can't be resolved without actually running the code, so those are
// counted and skipped rather than guessed at — see dynamicCount below.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// vite.config.js/vitest.config.js are build tooling, never bundled into the
// app. ev-legacy-archive.js is dead code kept only as reference material
// (see its own header comment) — never imported by app.js, never bundled,
// and not guaranteed to still match index.html's current ids (that's the
// whole point of it being retired). All three were already outside the
// original, app.js-only version of this check; excluded explicitly now so
// growing the scan to every module doesn't silently pull them back in.
const NON_APP_JS_FILES = new Set([
  'vite.config.js', 'vitest.config.js',
  'ev-legacy-archive.js',
]);
export function findAppModuleFiles(root) {
  return readdirSync(root)
    .filter(f => f.endsWith('.js') && !NON_APP_JS_FILES.has(f))
    .sort();
}

export function extractHtmlIds(source) {
  const ids = new Set();
  const re = /\bid=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) ids.add(m[1]);
  return ids;
}

export function extractJsDefinedIds(source) {
  const ids = new Set();
  for (const re of [/\bid=["']([^"']+)["']/g, /\.id\s*=\s*['"]([^'"]+)['"]/g]) {
    let m;
    while ((m = re.exec(source))) ids.add(m[1]);
  }
  return ids;
}

export function extractJsReferencedIds(source) {
  const ids = new Set();
  let dynamicCount = 0;

  for (const re of [
    /\$\(\s*['"]([^'"]+)['"]\s*\)/g,
    /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(source))) ids.add(m[1]);
  }

  // Plain (non-interpolated) backtick strings are just as static as quoted
  // ones and get checked the same way; anything containing `${` is counted
  // as skipped rather than guessed at.
  for (const re of [
    /\$\(\s*`([^`]*)`\s*\)/g,
    /getElementById\(\s*`([^`]*)`\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(source))) {
      if (m[1].includes('${')) dynamicCount++;
      else ids.add(m[1]);
    }
  }

  return { ids, dynamicCount };
}

export function findIdIssues(html, js) {
  const htmlIds = extractHtmlIds(html);
  const jsDefinedIds = extractJsDefinedIds(js);
  const knownIds = new Set([...htmlIds, ...jsDefinedIds]);
  const { ids: jsIds, dynamicCount } = extractJsReferencedIds(js);

  const missing = [...jsIds].filter(id => !knownIds.has(id)).sort();
  const unreferenced = [...htmlIds].filter(id => !jsIds.has(id)).sort();

  return { missing, unreferenced, htmlIds, jsDefinedIds, jsIds, dynamicCount };
}

// CLI entry point — only runs when this file is executed directly
// (`node scripts/check-ids.mjs`), not when its functions are imported by
// tests. pathToFileURL normalizes process.argv[1] before comparing, since a
// naive string comparison against import.meta.url breaks on Windows (a
// plain filesystem path vs. a file:/// URL with forward slashes).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const moduleFiles = findAppModuleFiles(root);
  const js = moduleFiles.map(f => readFileSync(path.join(root, f), 'utf8')).join('\n');
  const { missing, unreferenced, htmlIds, jsDefinedIds, jsIds, dynamicCount } = findIdIssues(html, js);

  console.log(
    `Checked ${jsIds.size} statically-referenced id(s) across ${moduleFiles.length} module file(s) ` +
    `(${moduleFiles.join(', ')}) against ${htmlIds.size + jsDefinedIds.size} known id(s) ` +
    `(${htmlIds.size} from index.html, ${jsDefinedIds.size} defined at runtime in JS) ` +
    `— ${dynamicCount} dynamic reference(s) skipped (can't be resolved without running the code).`
  );

  if (unreferenced.length) {
    console.log(
      `\nInfo (not a failure): ${unreferenced.length} id(s) in index.html with no static JS reference — ` +
      `most of these are almost certainly built from a template literal like \${fuel}-... rather than genuinely unused:`
    );
    for (const id of unreferenced) console.log(`  - ${id}`);
  }

  if (missing.length) {
    console.error(`\nERROR: ${missing.length} id(s) referenced in JS but not found anywhere:`);
    for (const id of missing) console.error(`  - ${id}`);
    process.exit(1);
  }

  console.log('\nOK — every statically-referenced id exists.');
}
