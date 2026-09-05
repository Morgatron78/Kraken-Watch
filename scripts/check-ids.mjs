#!/usr/bin/env node
// Cross-checks every statically-resolvable $('id')/getElementById('id')
// reference in app.js against the ids actually available: those declared
// in index.html, plus any app.js assigns to elements it builds at runtime
// (insertAdjacentHTML/template-literal markup with id="...", or `el.id =
// '...'` on a createElement'd node — ev-sessions-toggle-wrap, bh-pill-group,
// and ev-month-partial-note all work this way). Exists specifically because
// of the bill-history-toggle bug documented in the README: a DOM/JS drift
// like this doesn't throw until runtime, and only on whichever code path
// happens to touch the missing element — this catches it at build/PR time
// instead, for free, on every push.
//
// Deliberately narrow: only `$('literal')` / `getElementById('literal')`
// with a single/double-quoted or plain (non-interpolated) backtick string
// argument can be checked statically. A template literal with `${...}`
// interpolation (e.g. `${fuel}-week`, common throughout this file) can't
// be resolved without actually running the code, so those are counted and
// skipped rather than guessed at — see dynamicCount in the result.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

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
  const js = readFileSync(path.join(root, 'app.js'), 'utf8');
  const { missing, unreferenced, htmlIds, jsDefinedIds, jsIds, dynamicCount } = findIdIssues(html, js);

  console.log(
    `Checked ${jsIds.size} statically-referenced id(s) against ${htmlIds.size + jsDefinedIds.size} known id(s) ` +
    `(${htmlIds.size} from index.html, ${jsDefinedIds.size} defined at runtime in app.js) ` +
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
    console.error(`\nERROR: ${missing.length} id(s) referenced in app.js but not found anywhere:`);
    for (const id of missing) console.error(`  - ${id}`);
    process.exit(1);
  }

  console.log('\nOK — every statically-referenced id exists.');
}
