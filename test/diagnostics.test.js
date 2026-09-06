import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  resetDiagnostics, logIssue, logDebug, logRawIssue, logRawDebug, getSyncIssues, renderDiagnostics,
} from '../diagnostics.js';
import { store } from '../store.js';

// resetDiagnostics() (not just clearing localStorage) is the correct way to
// isolate these tests from each other, since syncIssues/debugNotes are
// private, in-memory module state with no localStorage backing at all.
beforeEach(() => {
  localStorage.clear();
  resetDiagnostics();
});
afterEach(() => vi.restoreAllMocks());

describe('logIssue / getSyncIssues', () => {
  it('formats as "section: message" and is visible via getSyncIssues', () => {
    logIssue('Rates', new Error('boom'));
    expect(getSyncIssues()).toEqual(['Rates: boom']);
  });

  it('accumulates multiple issues in order', () => {
    logIssue('Rates', new Error('a'));
    logIssue('Billing', new Error('b'));
    expect(getSyncIssues()).toEqual(['Rates: a', 'Billing: b']);
  });

  it('also warns to the console', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logIssue('Rates', new Error('boom'));
    expect(spy).toHaveBeenCalledWith('Rates fallback:', 'boom');
  });
});

describe('logRawIssue', () => {
  it('pushes the message verbatim, with no "section:" prefix', () => {
    logRawIssue('GraphQL account blocked for exceeding its points allowance');
    expect(getSyncIssues()).toEqual(['GraphQL account blocked for exceeding its points allowance']);
  });
});

describe('logDebug / logRawDebug', () => {
  it('logDebug formats as "label: message" and logs to the console', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logDebug('Elec week', 'summary text');
    expect(spy).toHaveBeenCalledWith('Elec week debug:', 'summary text');
  });

  it('logRawDebug pushes a pre-formatted line with no console output', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logRawDebug('Meter selection: 1 property, using MPAN 123');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('resetDiagnostics', () => {
  it('clears both logs', () => {
    logIssue('Rates', new Error('boom'));
    logDebug('x', 'y');
    resetDiagnostics();
    expect(getSyncIssues()).toEqual([]);
  });
});

describe('renderDiagnostics', () => {
  function setDom() {
    document.body.innerHTML = `
      <div id="diagnostics-card"></div>
      <div id="diagnostics-title"></div>
      <div id="diagnostics-list"></div>
      <div id="sync-history"></div>
    `;
  }

  it('hides the card when there is nothing to show and diagnostics are on', () => {
    setDom();
    store.creds = { showDiagnostics: true };
    renderDiagnostics();
    expect(document.getElementById('diagnostics-card').style.display).toBe('none');
  });

  it('hides the card when showDiagnostics is explicitly off, even with real issues', () => {
    setDom();
    store.creds = { showDiagnostics: false };
    logIssue('Rates', new Error('boom'));
    renderDiagnostics();
    expect(document.getElementById('diagnostics-card').style.display).toBe('none');
  });

  it('shows the card and includes the build id and REST-call count once there is something to show', () => {
    setDom();
    store.creds = { showDiagnostics: true };
    logIssue('Rates', new Error('boom'));
    renderDiagnostics();
    expect(document.getElementById('diagnostics-card').style.display).toBe('block');
    const text = document.getElementById('diagnostics-list').textContent;
    expect(text).toContain('Build:');
    expect(text).toContain('REST call(s) in the last hour');
    expect(text).toContain('Rates: boom');
  });

  it('defaults to showing diagnostics when the setting has never been saved', () => {
    setDom();
    store.creds = null;
    logIssue('Rates', new Error('boom'));
    renderDiagnostics();
    expect(document.getElementById('diagnostics-card').style.display).toBe('block');
  });
});
