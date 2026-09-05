import { store } from './store.js';
import { $ } from './format.js';
import { logIssue } from './diagnostics.js';
import { octRest, resetKrakenToken } from './api.js';
import { loadAll, startAutoRefresh } from './main.js';

// Populated by saveSettings()'s best-effort meter-point lookup, read by
// loadAll()/loadFastTier() at the top of each sync so a lookup failure (or
// the meter details it found) shows up in the diagnostics log rather than
// only being knowable by re-opening Settings.
export let meterDebugNote = null;

/* ---------------------------- Appearance / theme ---------------------------- */
// Stored in its own localStorage key (not store.creds) so the connect screen
// themes correctly before any credentials exist. The pre-paint apply lives in
// index.html's <head> to avoid a flash; this just handles live toggling and
// keeping "auto" in sync when the OS theme changes.
const THEME_KEY = 'kw_theme';
const prefersLight = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;

function getThemePref() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

function applyResolvedTheme(pref) {
  const light = pref === 'light' || (pref === 'auto' && prefersLight());
  if (light) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme'); // absent === dark, the :root default
  const meta = $('meta-theme-color');
  if (meta) meta.setAttribute('content', light ? '#f4f4f5' : '#131226');
}

export function setThemePref(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode — apply for this session only */ }
  applyResolvedTheme(pref);
}

export function initTheme() {
  applyResolvedTheme(getThemePref());
  // Follow the OS while the pref is "auto".
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', () => { if (getThemePref() === 'auto') applyResolvedTheme('auto'); });
  }
}

export function handleAppearanceChange(e) {
  setThemePref(e.target.value);
}

export function openSettings() {
  const c = store.creds || {};
  $('input-api-key').value = c.apiKey || '';
  $('input-api-key').type = 'password';
  $('toggle-api-key-visibility').textContent = 'Show';
  $('input-account').value = c.accountNumber || '';
  $('input-email').value = c.email || '';
  $('input-password').value = c.password || '';
  $('input-elec-mpan').value = c.manualElecMpan || '';
  $('input-elec-serial').value = c.manualElecSerial || '';
  $('input-gas-mprn').value = c.manualGasMprn || '';
  $('input-gas-serial').value = c.manualGasSerial || '';
  $('input-calorific-value').value = c.calorificValue || '';
  if (c.manualElecMpan || c.manualGasMprn) $('advanced-fields').classList.remove('hidden');
  // Pre-fill with Octopus's device-record value (vehicleMake/vehicleModel)
  // unless the user has saved an override (customVehicleMake/Model), so the
  // field always shows the current real value, editable in place.
  $('input-ev-make').value = c.customVehicleMake || c.vehicleMake || '';
  $('input-ev-model').value = c.customVehicleModel || c.vehicleModel || '';
  $('input-ev-wltp-miles').value = c.wltpMiles || '';
  $('input-ev-wltp-kwh').value = c.wltpBatteryKwh || '';
  $('input-show-diagnostics').checked = c.showDiagnostics !== false;
  $('input-use-demo-fallback').checked = c.useDemoFallback === true;
  $('input-appearance').value = getThemePref();
  $('settings-modal').classList.remove('hidden');
}
export function closeSettings() { $('settings-modal').classList.add('hidden'); }

export async function saveSettings() {
  const apiKey = $('input-api-key').value.trim();
  const accountNumber = $('input-account').value.trim();
  const email = $('input-email').value.trim();
  const password = $('input-password').value;
  const manualElecMpan = $('input-elec-mpan').value.trim();
  const manualElecSerial = $('input-elec-serial').value.trim();
  const manualGasMprn = $('input-gas-mprn').value.trim();
  const manualGasSerial = $('input-gas-serial').value.trim();
  const calorificValueRaw = $('input-calorific-value').value.trim();
  const calorificValue = calorificValueRaw ? parseFloat(calorificValueRaw) : null;
  if (calorificValueRaw && (!Number.isFinite(calorificValue) || calorificValue <= 0)) {
    alert('Gas calorific value must be a positive number.'); return;
  }
  // Save a custom vehicle name as an override only if it differs from the
  // API-returned value. An untouched field leaves no override, so the
  // display keeps following Octopus's device record (e.g. if the vehicle is
  // swapped) rather than freezing to whatever showed when Settings was saved.
  const evMakeInput = $('input-ev-make').value.trim().slice(0, 15);
  const evModelInput = $('input-ev-model').value.trim().slice(0, 60);
  const priorCreds = store.creds || {};
  const customVehicleMake = evMakeInput && evMakeInput !== (priorCreds.vehicleMake || '') ? evMakeInput : null;
  const customVehicleModel = evModelInput && evModelInput !== (priorCreds.vehicleModel || '') ? evModelInput : null;
  const wltpMilesRaw = $('input-ev-wltp-miles').value.trim();
  const wltpKwhRaw = $('input-ev-wltp-kwh').value.trim();
  const wltpMiles = wltpMilesRaw ? parseFloat(wltpMilesRaw) : null;
  const wltpBatteryKwh = wltpKwhRaw ? parseFloat(wltpKwhRaw) : null;
  if (wltpMilesRaw && (!Number.isFinite(wltpMiles) || wltpMiles <= 0)) {
    alert('WLTP range must be a positive number.'); return;
  }
  if (wltpKwhRaw && (!Number.isFinite(wltpBatteryKwh) || wltpBatteryKwh <= 0)) {
    alert('Battery capacity must be a positive number.'); return;
  }
  const showDiagnostics = $('input-show-diagnostics').checked;
  const useDemoFallback = $('input-use-demo-fallback').checked;
  if (!apiKey || !accountNumber) { alert('API key and account number are required.'); return; }

  store.creds = { ...store.creds, apiKey, accountNumber, email, password, manualElecMpan, manualElecSerial, manualGasMprn, manualGasSerial, calorificValue, customVehicleMake, customVehicleModel, wltpMiles, wltpBatteryKwh, showDiagnostics, useDemoFallback };
  resetKrakenToken();

  // Best-effort: look up meter points + tariff codes automatically from the account.
  // Accounts can have more than one electricity/gas meter point on record (e.g.
  // after a smart meter exchange, the old meter point often stays listed) —
  // blindly taking index [0] can pick a decommissioned meter with no consumption
  // data even though its tariff/agreement info still resolves fine. This prefers
  // the currently-occupied property and the meter point with an active agreement.
  try {
    const acct = await octRest(`/accounts/${accountNumber}/`);
    const properties = acct.properties || [];
    const prop = properties.find(p => !p.moved_out_at) || properties[0];

    const now = new Date();
    const isActive = a => !a.valid_to || new Date(a.valid_to) > now;

    const elecMps = prop?.electricity_meter_points || [];
    const elecMp = elecMps.find(mp => (mp.agreements || []).some(isActive)) || elecMps[0];
    const gasMps = prop?.gas_meter_points || [];
    const gasMp = gasMps.find(mp => (mp.agreements || []).some(isActive)) || gasMps[0];

    const agreement = elecMp?.agreements?.find(isActive);
    const gasAgreement = gasMp?.agreements?.find(isActive);
    const creds = store.creds;
    creds.elecMpan = elecMp?.mpan;
    creds.elecSerial = elecMp?.meters?.[elecMp.meters.length - 1]?.serial_number;
    creds.gasMprn = gasMp?.mprn;
    creds.gasSerial = gasMp?.meters?.[gasMp.meters.length - 1]?.serial_number;
    if (agreement?.tariff_code) {
      // tariff codes look like E-1R-INTELLI-VAR-22-10-14-C — product code is the middle segment
      const parts = agreement.tariff_code.split('-');
      creds.elecTariffCode = agreement.tariff_code;
      creds.elecProductCode = parts.slice(2, -1).join('-');
    }
    if (gasAgreement?.tariff_code) {
      const parts = gasAgreement.tariff_code.split('-');
      creds.gasTariffCode = gasAgreement.tariff_code;
      creds.gasProductCode = parts.slice(2, -1).join('-');
    }
    store.creds = creds;

    meterDebugNote = `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}, ` +
      `${elecMps.length} elec meter point(s) (using MPAN ${elecMp?.mpan || '—'}, serial ${creds.elecSerial || '—'}, ${elecMp?.meters?.length || 0} meter(s) on record), ` +
      `${gasMps.length} gas meter point(s) (using MPRN ${gasMp?.mprn || '—'}, serial ${creds.gasSerial || '—'})`;
  } catch (err) {
    logIssue('Meter-point lookup', err);
  }

  // Manual overrides always win over auto-detection, if provided.
  if (manualElecMpan && manualElecSerial) {
    const creds = store.creds;
    creds.elecMpan = manualElecMpan;
    creds.elecSerial = manualElecSerial;
    store.creds = creds;
  }
  if (manualGasMprn && manualGasSerial) {
    const creds = store.creds;
    creds.gasMprn = manualGasMprn;
    creds.gasSerial = manualGasSerial;
    store.creds = creds;
  }

  closeSettings();
  $('connect-card').classList.add('hidden');
  $('app-content').classList.remove('hidden');
  loadAll();
  startAutoRefresh();
}
