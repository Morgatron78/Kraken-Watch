import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractHtmlIds, extractJsDefinedIds, extractJsReferencedIds, findIdIssues, findAppModuleFiles } from '../scripts/check-ids.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('findAppModuleFiles', () => {
  it('includes the known app modules and excludes the build configs', () => {
    const files = findAppModuleFiles(repoRoot);
    expect(files).toEqual(expect.arrayContaining(['main.js', 'store.js', 'format.js', 'diagnostics.js']));
    expect(files).not.toContain('vite.config.js');
    expect(files).not.toContain('vitest.config.js');
  });

  it('excludes the archived/dead-code file, never bundled and referencing retired ids', () => {
    const files = findAppModuleFiles(repoRoot);
    expect(files).not.toContain('ev-legacy-archive.js');
  });
});

describe('extractHtmlIds', () => {
  it('extracts every id attribute, double or single quoted', () => {
    const html = `<div id="foo"></div><span id='bar'></span>`;
    expect(extractHtmlIds(html)).toEqual(new Set(['foo', 'bar']));
  });
});

describe('extractJsDefinedIds', () => {
  it('extracts ids from an id="..." attribute inside a JS string (insertAdjacentHTML-style)', () => {
    const js = `el.insertAdjacentHTML('beforeend', '<div id="dynamic-note">x</div>');`;
    expect(extractJsDefinedIds(js)).toEqual(new Set(['dynamic-note']));
  });

  it('extracts ids from a .id = assignment', () => {
    const js = `const wrap = document.createElement('div'); wrap.id = 'my-wrap';`;
    expect(extractJsDefinedIds(js)).toEqual(new Set(['my-wrap']));
  });
});

describe('extractJsReferencedIds', () => {
  it('extracts $() calls with single or double quotes', () => {
    const js = `$('foo'); $("bar");`;
    const { ids, dynamicCount } = extractJsReferencedIds(js);
    expect(ids).toEqual(new Set(['foo', 'bar']));
    expect(dynamicCount).toBe(0);
  });

  it('extracts getElementById() calls the same way', () => {
    const js = `document.getElementById('baz');`;
    const { ids } = extractJsReferencedIds(js);
    expect(ids).toEqual(new Set(['baz']));
  });

  it('extracts a plain (non-interpolated) backtick call as static', () => {
    const js = '$(`plain-id`);';
    const { ids, dynamicCount } = extractJsReferencedIds(js);
    expect(ids).toEqual(new Set(['plain-id']));
    expect(dynamicCount).toBe(0);
  });

  it('counts, but does not resolve, an interpolated template literal', () => {
    const js = '$(`${fuel}-week`);';
    const { ids, dynamicCount } = extractJsReferencedIds(js);
    expect(ids.size).toBe(0);
    expect(dynamicCount).toBe(1);
  });
});

describe('findIdIssues', () => {
  it('reports no missing ids when every static reference resolves', () => {
    const html = `<div id="foo"></div>`;
    const js = `$('foo');`;
    const { missing } = findIdIssues(html, js);
    expect(missing).toEqual([]);
  });

  it('flags a genuine drift — an id referenced in JS but present nowhere', () => {
    const html = `<div id="foo"></div>`;
    const js = `$('foo'); $('typo-id');`;
    const { missing } = findIdIssues(html, js);
    expect(missing).toEqual(['typo-id']);
  });

  it('does not flag an id that a module defines for itself at runtime', () => {
    const html = `<div id="foo"></div>`;
    const js = `
      const wrap = document.createElement('div');
      wrap.id = 'runtime-wrap';
      $('foo');
      $('runtime-wrap');
    `;
    const { missing } = findIdIssues(html, js);
    expect(missing).toEqual([]);
  });

  it('lists an index.html id with no static JS reference as unreferenced, not missing', () => {
    const html = `<div id="foo"></div><div id="unused"></div>`;
    const js = `$('foo');`;
    const { missing, unreferenced } = findIdIssues(html, js);
    expect(missing).toEqual([]);
    expect(unreferenced).toEqual(['unused']);
  });
});
