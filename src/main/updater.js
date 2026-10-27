'use strict';
// Automaattipäivitys GitHub Releasesista (electron-updater). Kääre saa riippuvuutensa sisään (app, autoUpdater, send, setTimeout), jotta tilakone
// voidaan testata node:lla feikki-autoUpdaterilla ilman Electronia. Käytössä vain asennetussa versiossa (app.isPackaged) eikä --smoke-test-ajossa:
// muuten kääre on no-op ja raportoi tilan 'dev' (ei paketoitu) tai 'disabled' (savutesti).
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEV_TEXT = 'Päivitykset ovat käytössä vain asennetussa versiossa.';

// Tila suomeksi (näytetään Asetuksissa). Puhdas funktio.
function statusText(s) {
  if (!s) return '';
  const v = s.latest ? ` ${s.latest}` : '';
  switch (s.state) {
    case 'dev': case 'disabled': return DEV_TEXT;
    case 'checking': return 'Tarkistetaan…';
    case 'available': return `Löytyi versio${v}, ladataan…`;
    case 'downloading': return `Ladataan versiota${v} (${Math.max(0, Math.min(100, Math.round(Number(s.percent) || 0)))} %)`;
    case 'downloaded': return `Versio${v} ladattu`;
    case 'none': return 'Uusin versio käytössä';
    case 'error': return `Virhe: ${s.error || 'tuntematon virhe'}`;
    default: return 'Päivityksiä ei ole vielä tarkistettu.';
  }
}

// Virheilmoitus tilaan: ensimmäinen rivi, rajattu pituus (HTTP-virheet sisältävät pitkiä otsikkolohkoja).
function errorMessage(e) {
  const raw = e && e.message ? e.message : String(e || 'tuntematon virhe');
  const line = raw.split(/\r?\n/).map((x) => x.trim()).find(Boolean) || 'tuntematon virhe';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

// app: { isPackaged, getVersion }. autoUpdater: electron-updaterin autoUpdater tai funktio, joka palauttaa sen (ladataan vasta kun tarvitaan).
// beforeInstall: kutsutaan juuri ennen quitAndInstallia (main.js asettaa quitting-lipun, jotta ikkunan sulkeminen ei piilota ikkunaa trayhin).
function createUpdater({
  app, autoUpdater, send = () => {}, smoke = false, beforeInstall = () => {}, log = () => {},
  setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, now = Date.now,
  firstCheckMs = FIRST_CHECK_MS, intervalMs = CHECK_INTERVAL_MS,
}) {
  const packaged = !!(app && app.isPackaged);
  const enabled = packaged && !smoke;
  const st = {
    state: enabled ? 'idle' : (packaged ? 'disabled' : 'dev'),
    current: app.getVersion(), latest: null, percent: 0, error: null, checkedAt: null,
  };
  let au = null;
  let timer = null;
  let started = false;

  const snapshot = () => ({ ...st, enabled, text: statusText(st) });
  const emit = () => send('updater:state', snapshot());
  function set(patch) { Object.assign(st, patch); emit(); }
  function fail(e) {
    if (st.state === 'downloaded') { log(errorMessage(e)); return; } // ladattu päivitys säilyy, vaikka myöhempi tapahtuma epäonnistuisi
    set({ state: 'error', error: errorMessage(e), checkedAt: now() });
  }

  function attach() {
    if (au) return au;
    au = typeof autoUpdater === 'function' ? autoUpdater() : autoUpdater;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.logger = { info() {}, debug() {}, warn: (m) => log(m), error: (m) => log(m) };
    au.on('checking-for-update', () => set({ state: 'checking', error: null }));
    au.on('update-available', (info) => set({ state: 'available', latest: info && info.version ? String(info.version) : null, percent: 0, error: null, checkedAt: now() }));
    au.on('update-not-available', () => set({ state: 'none', latest: null, percent: 0, error: null, checkedAt: now() }));
    au.on('download-progress', (p) => set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))) }));
    au.on('update-downloaded', (info) => set({ state: 'downloaded', latest: info && info.version ? String(info.version) : st.latest, percent: 100, error: null, checkedAt: now() }));
    au.on('error', (e) => fail(e));
    return au;
  }

  // Tarkistus nyt. Ei päällekkäisiä tarkistuksia, eikä jo ladattua päivitystä korvata uudella tarkistuksella.
  async function check() {
    if (!enabled) return snapshot();
    if (['checking', 'available', 'downloading', 'downloaded'].includes(st.state)) return snapshot();
    try {
      attach();
      await au.checkForUpdates();
      if (st.state === 'checking') set({ state: 'none', checkedAt: now() }); // ei tapahtumaa (esim. päivitys ei käytössä): ei jää kesken
    } catch (e) {
      if (st.state !== 'error') fail(e); // electron-updater lähettää myös 'error'-tapahtuman; vältetään kaksoiskirjaus
    }
    return snapshot();
  }

  function install() {
    if (!enabled) throw new Error(DEV_TEXT);
    if (st.state !== 'downloaded') throw new Error('Päivitystä ei ole ladattu.');
    beforeInstall();
    attach().quitAndInstall(true, true); // hiljainen asennus, sovellus käynnistyy asennuksen jälkeen uudelleen
    return true;
  }

  function schedule(ms) {
    timer = setT(() => { timer = null; check().finally(() => { if (started) schedule(intervalMs); }); }, ms);
    if (timer && timer.unref) timer.unref();
  }
  function start() {
    if (!enabled || started) return;
    started = true;
    try { attach(); } catch (e) { fail(e); return; }
    schedule(firstCheckMs);
  }
  function stop() {
    started = false;
    if (timer) { clearT(timer); timer = null; }
  }

  return { enabled, start, stop, check, install, state: snapshot };
}

module.exports = { createUpdater, statusText, errorMessage, FIRST_CHECK_MS, CHECK_INTERVAL_MS, DEV_TEXT };
