'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, safeStorage, Tray, Menu, nativeImage } = require('electron');

const { createSettings, validate: validateSettings } = require('./settings');
const susp = require('./suspicion');
const { readJson, writeJsonAtomic } = require('./store');
const { createHttp, ApiError } = require('./http');
const ow = require('./providers/ow');
const rlIni = require('./providers/rl-ini');
const { createR6 } = require('./providers/r6');
const ARZ = require('./providers/arenyze');
const rl = require('./rl-core');
const { createRlClient } = require('./rl-client');
const P = require('./profile');
const { createR6Service } = require('./r6-service');
const lobbies = require('./ow-lobbies');
const gameDetect = require('./game-detect');
const OWL = require('./overwolf');
const { createGep } = require('./gep');
const BG = require('./background');
const { createTrayController } = require('./tray');
const { createUpdater } = require('./updater');

const SMOKE = process.argv.includes('--smoke-test');
if (SMOKE) app.setPath('userData', path.join(require('os').tmpdir(), 'statsikka-smoke'));

// Vain --smoke-test: ikkunaa ei koskaan näytetä eikä trayta luoda oikeasti. Ikkunan näyttö/piilotus, Windows-käynnistys, tray ja lopetus korvataan
// kirjaavilla tekaistuilla toteutuksilla, jotta samat koodipolut voidaan ajaa näkymättömästi ja tarkistaa kutsut.
const smoke = SMOKE ? {
  fakeVisible: null,   // null = oikea tila (ikkuna ei koskaan näy); true/false = testin asettama näkyvyys
  startedHidden: null, startupShown: false, inactive: 0, focused: [], hides: 0, quits: 0, launches: [], tray: null,
  login: {
    calls: [], on: false,
    set(o) { this.calls.push(JSON.parse(JSON.stringify(o))); this.on = !!o.openAtLogin; },
    get() { return { openAtLogin: this.on, executableWillLaunchAtLogin: this.on }; },
  },
} : null;
class SmokeTray {
  constructor(image) { this.image = image; this.destroyed = false; this.handlers = {}; this.tooltip = ''; this.menu = null; smoke.tray = this; }
  setToolTip(t) { this.tooltip = t; }
  setContextMenu(m) { this.menu = m; }
  on(ev, fn) { this.handlers[ev] = fn; }
  destroy() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
}

// Overwolf GEP (live-pelitiedot). Kääre on no-op tavallisella Electronilla; ow-electronilla pakettien tapahtumat rekisteröidään heti (ennen app.ready).
// Silmukkasuoja: edellinen prosessi merkitsi uudelleenkäynnistyksen ympäristömuuttujalla; luetaan ja poistetaan se heti, jotta myöhempi
// käyttäjän käynnistämä uudelleenkäynnistys (Ota käyttöön -nappi) ei estyisi.
const RELAUNCHED = process.env[OWL.RELAUNCH_FLAG] === '1';
delete process.env[OWL.RELAUNCH_FLAG];
let gepClock = null; // vain --smoke-test: kiinnitetty kellonaika GEP:n ottelun alulle
const gep = createGep({ app, now: () => gepClock || Date.now() });
gep.attach();
let win = null;
let settings = null;
let http = null;
let owApi = null;
let tracker = null;
let rlClient = null;
let history = [];
let historyFile = '';
let emitTimer = null;
let profileStore = null; // profile-history.json (Oma profiili)
let ownOw = null;        // viimeisin haettu oma OW-profiili { fetchedAt, profile, error, key }
let owInflight = null;   // { key, promise } käynnissä oleva haku
let owScheduler = null;
let r6 = null;
let r6svc = null;         // ottelutallenteet (r6-service.js)
let arz = null;           // Arenyze-asiakas (providers/arenyze.js): minkä tahansa pelaajan rank ja kausitilastot; avain arenyze-key.bin (safeStorage)
// Savutestissä Arenyzeen ei koskaan tehdä oikeita verkkokutsuja: oletus hylkää, testi asettaa keinotekoisen fetchin koukulla.
let arzFetch = SMOKE ? () => Promise.reject(new Error('savutesti: ei verkkokutsuja Arenyzeen')) : (...a) => fetch(...a);
let lobbyStore = null;    // ow-lobbies.json (lobbyistunnot)
let gameTracker = null;   // pelien tila: pois / käynnissä / ottelu
let detector = null;      // peliprosessien tunnistus (tasklist)
let launchWatcher = null; // pelin käynnistymisen reunan tunnistus (kerran per prosessin alku)
let trayCtl = null;       // tray-kuvake (vain kun runInBackground)
let updater = null;       // automaattipäivitys (updater.js): vain asennetussa versiossa, ei savutestissä
let quitting = false;     // true kun sovellus lopetetaan oikeasti (ikkunan sulkeminen ei silloin piilota)
let credStore = null;     // ow-credentials.bin (Overwolf-tunnukset, salattu safeStoragella)
let startupPlan = { action: 'none', reason: 'init' }; // käynnistyksen Overwolf-suunnitelma (näytetään asetuksissa)
let gepTimer = null;
let smokeCopied = null;   // vain --smoke-test: viimeksi kopioitu teksti (oikeaa leikepöytää ei kosketa)
let smokeProfiles = null; // vain --smoke-test: ref -> keinotekoinen profiili (ei koskaan asetettu muualla)
const allowedDirs = new Map(); // normalisoitu polku -> polku (vain tunnetut / dialogista valitut)

function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function ownIdentity() {
  const s = settings.get();
  return { name: s.rlOwnName, id: s.rlOwnId };
}

function livePayload() {
  const snap = tracker.snapshot();
  return { status: rlClient ? rlClient.getStatus() : 'disconnected', port: settings.get().rlWebPort, ...snap };
}

function scheduleEmit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; send('rl:update', livePayload()); }, 200);
}

function normPath(p) { return path.normalize(p).replace(/[\\/]+$/, '').toLowerCase(); }
function allowDir(p) { allowedDirs.set(normPath(p), p); }
function isAllowedDir(p) { return typeof p === 'string' && p.length < 400 && allowedDirs.has(normPath(p)); }

// Muistetaan oma PrimaryId kun nimi on täsmännyt pelaajaan.
function learnOwnId() {
  const s = settings.get();
  if (!s.rlOwnName || !tracker.last) return;
  const p = rl.findOwn((tracker.last.Players || []).map((x) => ({ name: x.Name, primaryId: x.PrimaryId })), { name: s.rlOwnName, id: '' });
  if (p && p.primaryId && p.primaryId !== s.rlOwnId) settings.set({ rlOwnId: p.primaryId });
}

// ---- Pelien tila ja automaattinen siirtyminen live-näkymään ----------------------------------
// Vain sovelluksen sisäinen tapahtuma rendereriin: ikkunaa ei tuoda eteen, aktivoida eikä vilkuteta, eikä järjestelmäilmoituksia näytetä.
function sendGameState(snap) { send('game:state', snap); }
function startMatch(game, id) {
  if (gameTracker.matchStarted(game, id)) send('game:matchStart', { game });
}

// ---- Taustatila (tray), ikkunan näyttö ja pelin käynnistyksen automaattinen avaus ---------------------------------------------------------
// Pelin käynnistyessä ikkuna avataan showInactive():llä: ei kohdistusta, ei flashFrame-vilkutusta eikä ilmoituksia. Tray-valikko, Kaynnista.bat uudelleen ja
// Windowsin automaattikäynnistyksen jälkeinen avaus ovat käyttäjän omia toimia, joten niissä ikkuna saa kohdistuksen.
const winOk = () => !!win && !win.isDestroyed();
function windowState() {
  if (!winOk()) return { exists: false, visible: false, minimized: false };
  if (SMOKE && smoke.fakeVisible !== null) return { exists: true, visible: smoke.fakeVisible, minimized: false };
  return { exists: true, visible: win.isVisible(), minimized: win.isMinimized() };
}
function revealInactive() {
  if (!winOk()) return;
  if (SMOKE) { smoke.inactive++; smoke.fakeVisible = true; return; }
  win.showInactive();
}
function revealFocused(why) {
  if (!winOk()) return;
  if (SMOKE) { smoke.focused.push(why); smoke.fakeVisible = true; return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
function hideWindow() {
  if (!winOk()) return;
  if (SMOKE) { smoke.hides++; smoke.fakeVisible = false; return; }
  win.hide();
}
function quitApp() {
  if (SMOKE) { smoke.quits++; return; } // savutestissä sovellusta ei lopeteta kesken testin
  quitting = true;
  app.quit();
}
// Tapahtuma rendereriin: jos sivu latautuu vielä (heti käynnistyksen jälkeen), odotetaan latauksen valmistumista, ettei tapahtuma katoa.
function sendWhenLoaded(channel, payload) {
  if (!winOk() || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => send(channel, payload));
  else send(channel, payload);
}

function onGameLaunch(game) {
  const ws = windowState();
  const d = BG.decideLaunch({ enabled: settings.get().openOnGameLaunch, hasWindow: ws.exists, visible: ws.visible, minimized: ws.minimized });
  if (SMOKE) smoke.launches.push({ game, action: d.action });
  if (d.action === 'none') return;
  if (d.action === 'show') revealInactive();
  sendWhenLoaded('game:launch', { game, wasHidden: d.wasHidden }); // renderer valitsee pelin live-näkymän ja soveltaa kirjoitus-/modaalisuojia
}

function onWindowClose(e) {
  if (BG.shouldHideOnClose({ quitting, runInBackground: settings.get().runInBackground, trayOk: !!trayCtl && trayCtl.exists() })) { e.preventDefault(); hideWindow(); }
}
function onWindowInput(e, input) {
  if (BG.isQuitKey(input)) { e.preventDefault(); quitApp(); }
}
// --game=r6|ow|rl: avaa suoraan pelin Live-näkymän (myös kun Statsikka on jo käynnissä).
function gameFromArgv(argv) {
  const a = (argv || []).find((x) => /^--game=(r6|ow|rl)$/.test(String(x)));
  return a ? a.slice('--game='.length) : null;
}
function onSecondInstance(argv) {
  if (BG.shouldRevealOnSecondInstance(argv)) revealFocused('second-instance');
  const g = gameFromArgv(argv);
  if (g) sendWhenLoaded('app:openGame', { game: g });
}

const trayHandlers = {
  onOpen: () => revealFocused('tray'),
  onGame: (g) => { revealFocused(`tray-${g}`); sendWhenLoaded('app:openGame', { game: g }); },
  onQuit: () => quitApp(),
};
// Tray on olemassa vain, kun runInBackground on päällä.
function syncTray() {
  if (settings.get().runInBackground) trayCtl.create(); else trayCtl.destroy();
}

// ---- Käynnistys Windowsin mukana (piilotettuna trayhin). Savutestissä käytetään kirjaavaa tekaistua toteutusta, ei oikeaa rekisteriä.
const loginApi = SMOKE ? smoke.login : { set: (o) => app.setLoginItemSettings(o), get: (o) => app.getLoginItemSettings(o) };
function loginOpts(enabled) {
  return BG.buildLoginItem({ enabled, execPath: process.execPath, appPath: app.getAppPath(), devChannel: settings.get().gepDevChannel, hasOverwolf: !!app.overwolf });
}
function readLoginEnabled() {
  try { const o = loginOpts(true); return BG.loginEnabled(loginApi.get({ path: o.path, args: o.args })); } catch (_) { return false; }
}
// Asettaa kohteen ja tallentaa todellisen tilan asetukseen (käyttöjärjestelmä voi hylätä muutoksen tai käyttäjä on poistanut kohteen Tehtävienhallinnasta).
function applyLoginItem(enabled) {
  try { loginApi.set(loginOpts(enabled)); } catch (e) { console.error('Käynnistyksen Windowsin mukana asetus epäonnistui:', e && e.message); }
  return syncLoginSetting();
}
function syncLoginSetting() {
  const actual = readLoginEnabled();
  if (settings.get().startWithWindows !== actual) settings.set({ startWithWindows: actual });
  return actual;
}
// Rendereri saa aina todellisen tilan.
function currentSettings() {
  const s = settings.get();
  s.startWithWindows = readLoginEnabled();
  return s;
}

// ---- Overwolf GEP: tilannekuva rendereriin (R6-rosteri rikastetaan ottelutallenteiden historialla) ----------------------------
function gepPayload() {
  const s = gep.snapshot();
  if (r6svc && s.r6.roster.length) {
    try { const e = r6svc.enrichLive(s.r6.roster, { since: s.r6.startedAt }); s.r6.roster = e.players; s.r6.prevMatch = e.prevMatch; } catch (err) { console.error('GEP-rosterin rikastus epäonnistui:', err && err.message); }
  }
  // Arenyze: rank / K/D / V-H välimuistista; taustahaut käynnistyvät vain käynnissä olevan ottelun rosterille (avain asetettu + automaattihaku päällä).
  if (arz && s.r6.roster.length) {
    try { s.r6.roster = arz.decorate(s.r6.roster, (p) => p.name, (p) => !!p.isOwn, { fetch: !!s.r6.live, source: 'gep' }); } catch (err) { console.error('Arenyze-rikastus epäonnistui:', err && err.message); }
  }
  return s;
}
// Rajoitus 250 ms: GEP-päivityksiä voi tulla kymmeniä sekunnissa.
function scheduleGepEmit() {
  if (gepTimer) return;
  gepTimer = setTimeout(() => { gepTimer = null; send('gep:update', gepPayload()); }, 250);
  if (gepTimer.unref) gepTimer.unref();
}
function overwolfStatus() {
  const loaded = credStore.has() ? credStore.load() : null;
  return {
    owElectron: !!app.overwolf, status: gep.status(), storageAvailable: credStore.available(), stored: credStore.has(), storedMode: loaded ? loaded.mode : null,
    envActive: OWL.hasEnvCreds(process.env), channelArg: OWL.hasChannelArg(process.argv), devChannel: settings.get().gepDevChannel, startup: startupPlan.reason, smoke: SMOKE,
  };
}
// Käynnistää sovelluksen uudelleen annetulla suunnitelmalla (ympäristömuuttujat + argumentit). Kutsutaan ennen ikkunan luontia tai Ota käyttöön -napista.
function relaunchWith(plan) {
  OWL.applyEnv(process.env, plan);
  process.env[OWL.RELAUNCH_FLAG] = '1';
  app.releaseSingleInstanceLock();
  app.relaunch({ args: plan.args });
  app.exit(0);
}

function onRlEvent(ev) {
  if (ev === 'MatchCreated' || ev === 'MatchInitialized') startMatch('rl', tracker.guid);
  else if (ev === 'MatchDestroyed') gameTracker.matchEnded('rl');
  else if (ev === 'UpdateState' && tracker.hasMatch && !tracker.stored && gameTracker.phase('rl') !== 'match') startMatch('rl', tracker.guid); // sovellus avattiin kesken ottelun
}

// ---- Oma profiili ---------------------------------------------------------

function owKey() {
  const op = settings.get().owProfile;
  const p = ow.parseBattleTag(op.battletag);
  return p ? { id: p.id, key: `${p.id}|${op.platform}`, platform: op.platform } : null;
}

async function doRefreshOw(k, manual) {
  try {
    if (manual) http.clearCache();
    const prof = await owApi.getProfile({ ref: k.id, gamemode: 'competitive', platform: k.platform });
    const cur = owKey();
    if (!cur || cur.key !== k.key) return { added: false, stale: true }; // asetus vaihtui haun aikana
    const ts = Date.now();
    ownOw = { fetchedAt: ts, profile: prof, error: null, key: k.key };
    const hist = profileStore.data;
    if (hist.ow.tag !== k.key) hist.ow = { ...P.emptyHistory().ow, tag: k.key }; // toinen profiili/alusta: aloita alusta
    const r = P.appendSnapshot(hist.ow.snapshots, P.makeSnapshot(prof, ts));
    if (r.added) { hist.ow.snapshots = r.list; profileStore.save(); }
    return { added: r.added, fetchedAt: ts };
  } catch (e) {
    if (!ownOw || ownOw.key !== k.key) ownOw = { fetchedAt: null, profile: null, error: null, key: k.key };
    ownOw.error = { code: e && e.code ? e.code : 'ERROR', message: e && e.message ? e.message : 'Tuntematon virhe.' };
    throw e;
  }
}

// Yksi haku kerrallaan per profiili; manual = ohita välimuisti.
function refreshOw(manual) {
  const k = owKey();
  if (!k) return Promise.reject(new ApiError('BAD_INPUT', 'Omaa BattleTagia ei ole asetettu. Lisää se Asetuksissa.'));
  if (owInflight && owInflight.key === k.key) return owInflight.promise;
  const promise = doRefreshOw(k, manual);
  owInflight = { key: k.key, promise };
  const clear = () => { if (owInflight && owInflight.promise === promise) owInflight = null; };
  promise.then(clear, clear);
  return promise;
}

function dashboard() {
  const k = owKey();
  return P.buildDashboard({
    settings: settings.get(),
    history: profileStore.data,
    ownProfile: ownOw && k && ownOw.key === k.key ? ownOw : null,
    matches: history,
  });
}

// Kääre: palauttaa { ok, data } / { ok:false, error:{ code, message, retryAfter } }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message, retryAfter: e.retryAfter } };
      return { ok: false, error: { code: 'ERROR', message: e && e.message ? e.message : 'Tuntematon virhe.' } };
    }
  });
}

function registerIpc() {
  // --- Asetukset
  handle('settings:get', () => currentSettings());
  handle('settings:set', (patch) => {
    const problem = validateSettings(patch);
    if (problem) throw new ApiError('BAD_INPUT', problem);
    const before = settings.get();
    // Windows-käynnistys ei kulje settings.set():n kautta: pyyntö kirjoitetaan käyttöjärjestelmään ja asetukseen tallentuu todellinen tila.
    const wantLogin = patch.startWithWindows;
    if ('startWithWindows' in patch) { const { startWithWindows, ...rest } = patch; patch = rest; }
    // Ulos kirjautuminen (tyhjä nimi) estää nimen automaattisen täytön; uusi nimi sallii sen taas.
    if ('r6Name' in patch) patch = { ...patch, r6AutoName: patch.r6Name.trim() !== '' };
    const next = settings.set(patch);
    if (next.rlWebPort !== before.rlWebPort && rlClient) rlClient.reconnect();
    if (next.rlOwnName !== before.rlOwnName) { settings.set({ rlOwnId: '' }); learnOwnId(); }
    if (JSON.stringify(next.owProfile) !== JSON.stringify(before.owProfile)) {
      ownOw = null;
      if (owKey()) {
        const done = () => send('profile:update', {});
        refreshOw(true).then(done, done);
      }
    }
    if (next.arenyzeAuto !== before.arenyzeAuto || next.arenyzeSoftLimit !== before.arenyzeSoftLimit) { arz.resetPlan(); send('arenyze:update', {}); scheduleGepEmit(); }
    if (next.runInBackground !== before.runInBackground) syncTray();
    if (typeof wantLogin === 'boolean') applyLoginItem(wantLogin);
    else if (next.gepDevChannel !== before.gepDevChannel && before.startWithWindows) applyLoginItem(true); // GEP-kanava on osa käynnistysargumentteja
    scheduleEmit();
    return currentSettings();
  });

  // --- Overwatch 2
  handle('ow:search', (name) => owApi.search(String(name || '')));
  handle('ow:profile', (arg) => {
    if (!arg || typeof arg !== 'object') throw new ApiError('BAD_INPUT', 'Virheellinen pyyntö.');
    const ref = String(arg.ref || '');
    const sens = settings.get().suspicionSensitivity;
    const withSens = (p) => ({ ...p, suspicion: susp.withSensitivity(p.suspicion, sens) });
    const fake = smokeProfiles && smokeProfiles[ow.normalizePlayerRef(ref)];
    if (fake) return Promise.resolve(withSens({ ...fake, gamemode: arg.gamemode, platform: arg.platform }));
    return owApi.getProfile({ ref, gamemode: arg.gamemode, platform: arg.platform }).then(withSens);
  });

  // --- Pelien tila (renderöijä hakee alkutilan; muutokset tulevat game:state-tapahtumana)
  handle('game:state', () => gameTracker.snapshot());

  // --- Overwolf GEP: live-pelitiedot (gep:update-tapahtumat) ja tunnukset
  handle('gep:state', () => gepPayload());
  handle('gep:diag', () => gep.diag());
  handle('overwolf:status', () => overwolfStatus());
  handle('overwolf:enable', (arg) => {
    const creds = OWL.validateCredsArg(arg);
    credStore.save(creds); // heittää, ellei salausta ole (ei selkotekstinä levylle)
    if (typeof arg.devChannel === 'boolean') {
      const was = settings.get();
      settings.set({ gepDevChannel: arg.devChannel });
      if (was.gepDevChannel !== arg.devChannel && was.startWithWindows) applyLoginItem(true); // käynnistysargumentit seuraavat kanavavalintaa
    }
    const devChannel = settings.get().gepDevChannel;
    // Savutestissä ja tavallisella Electronilla vain tallennetaan: uudelleenkäynnistys ei auttaisi (ei ow-electronia) tai katkaisisi testin.
    if (SMOKE || !app.overwolf) return { stored: true, relaunching: false, owElectron: !!app.overwolf };
    const plan = OWL.planEnable({ argv: process.argv, creds, devChannel });
    setTimeout(() => relaunchWith(plan), 400); // vastaus ehtii rendereriin ennen sulkeutumista
    return { stored: true, relaunching: true, owElectron: true };
  });
  handle('overwolf:clear', () => {
    credStore.clear();
    for (const k of OWL.ENV_KEYS) delete process.env[k];
    return { cleared: true };
  });

  // --- Overwatch: lobbyistunnot ja kohtaamiset
  handle('ow:lobby:record', (arg) => {
    const v = lobbies.validateRecordArg(arg);
    const r = lobbyStore.record(v);
    const own = settings.get().owProfile.battletag;
    return { prev: lobbies.withoutOwn(r.prev, own), replaced: r.replaced };
  });
  handle('ow:encounters', (tag) => lobbyStore.encounters(lobbies.validateTagArg(tag)));

  // --- Rainbow Six Siege: käsin syötettyjen lukujen arvio (ei datalähdettä)
  handle('r6:assess', (arg) => {
    const v = susp.validateR6Input(arg);
    if (v.error) throw new ApiError('BAD_INPUT', v.error);
    return susp.withSensitivity(r6.assess(v.value), settings.get().suspicionSensitivity);
  });

  // --- Rainbow Six Siege: ottelutallenteet (Match Replay)
  handle('r6:status', () => r6svc.status());
  handle('r6:own', (arg) => r6svc.own(arg));
  handle('r6:matches', (arg) => r6svc.matches(arg));
  handle('r6:match', (name) => r6svc.match(name));
  handle('r6:live', () => {
    const d = r6svc.live();
    // Arenyze: käynnissä olevan ottelun pelaajille taustahaut (kierrostallenteesta), päättyneelle vain välimuistissa olevat.
    if (arz && d.match && Array.isArray(d.match.players)) d.match.players = arz.decorate(d.match.players, (p) => p.username, (p) => !!p.isOwn, { fetch: !!d.active, source: 'replay' });
    return d;
  });
  handle('r6:players', (arg) => r6svc.players(arg));
  handle('r6:player', (id) => r6svc.player(id));
  handle('r6:rescan', () => { r6svc.rescan(); return true; });
  // Valintaikkuna avataan vain käyttäjän napin painalluksesta (ei koskaan automaattisesti).
  handle('r6:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Valitse Rainbow Six Siegen MatchReplay-kansio',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { dir: await r6svc.setDir(r.filePaths[0]) };
  });

  // --- Arenyze (r6.arenyze.com): minkä tahansa R6-pelaajan rank, rank-pisteet, kausitilastot ja rank-pisteiden historia. Avain pysyy pääprosessissa (renderer ei koskaan lue sitä).
  handle('arenyze:status', () => arz.status());
  handle('arenyze:test', (arg) => arz.testKey(ARZ.validateKeyArg(arg)));  // arg = { key } (testaa ja tallentaa onnistuessa) tai ei mitään (testaa tallennetun)
  handle('arenyze:clearKey', () => { arz.clearKey(); return arz.status(); });
  handle('arenyze:usage', () => arz.refreshUsage());
  handle('arenyze:clearCache', () => { arz.clearCache(); return arz.status(); });
  handle('arenyze:lookup', async (arg) => {
    const v = ARZ.validateLookupArg(arg);
    // view = paneeli / oma profiili avautuu (noudattaa pehmeää rajaa), user = käyttäjän painike, refresh = Päivitä (ohittaa TTL:n, vähintään 30 s vanhasta)
    const r = await arz.lookup(v.kind, v.name, v.platform, { origin: v.mode === 'view' ? 'view' : 'user', force: v.mode === 'refresh' });
    return v.kind === 'summary' ? { ...r, check: ARZ.toCheckForm(r.data) } : r;
  });

  // --- Oma profiili
  handle('profile:get', () => dashboard());
  handle('profile:ow:refresh', () => refreshOw(true));
  handle('profile:ow:progress', async (arg) => {
    const v = P.validateOwProgress(arg);
    try { await refreshOw(true); } catch (_) { /* vanha tilannekuva kelpaa */ }
    const hist = profileStore.data;
    const k = owKey();
    if (!k || hist.ow.tag !== k.key) throw new ApiError('BAD_INPUT', 'Omaa OW-profiilia ei ole asetettu tai sen dataa ei ole vielä haettu.');
    const snaps = hist.ow.snapshots;
    const latest = snaps[snaps.length - 1];
    const cur = latest && latest.ranks[v.role];
    if (!cur) throw new ApiError('BAD_INPUT', 'Roolilla ei ole sijoitusta, joten edistymistä ei voi kirjata.');
    const entry = { id: P.newId(), ts: Date.now(), role: v.role, percent: v.percent, division: cur.division, tier: cur.tier, value: cur.value, season: latest.season };
    const list = hist.ow.progress[v.role];
    list.push(entry);
    if (list.length > P.ENTRY_CAP) list.splice(0, list.length - P.ENTRY_CAP);
    profileStore.save();
    return entry;
  });
  handle('profile:ow:progress:delete', (id) => {
    const want = P.validateId(id);
    let found = false;
    for (const role of P.OW_ROLES) {
      const list = profileStore.data.ow.progress[role];
      const i = list.findIndex((e) => e.id === want);
      if (i >= 0) { list.splice(i, 1); found = true; }
    }
    if (found) profileStore.save();
    return found;
  });
  handle('profile:ow:history:reset', () => {
    profileStore.data.ow = P.emptyHistory().ow;
    profileStore.save();
    if (owKey()) { const done = () => send('profile:update', {}); refreshOw(true).then(done, done); }
    return true;
  });
  handle('profile:rl:rank', (arg) => {
    const v = P.validateRlRank(arg);
    const entry = { id: P.newId(), ts: Date.now(), playlist: v.playlist, rank: v.rank, division: v.division, value: P.rlLadderValue(v.rank, v.division), mmr: v.mmr, nextMmr: v.nextMmr };
    const list = profileStore.data.rl.ranks[v.playlist];
    list.push(entry);
    if (list.length > P.ENTRY_CAP) list.splice(0, list.length - P.ENTRY_CAP);
    profileStore.save();
    return entry;
  });
  handle('profile:rl:rank:delete', (id) => {
    const want = P.validateId(id);
    let found = false;
    for (const key of P.RL_PLAYLIST_KEYS) {
      const list = profileStore.data.rl.ranks[key];
      const i = list.findIndex((e) => e.id === want);
      if (i >= 0) { list.splice(i, 1); found = true; }
    }
    if (found) profileStore.save();
    return found;
  });

  // --- Rocket League live + historia
  handle('rl:state', () => livePayload());
  handle('rl:history', () => {
    const own = ownIdentity();
    const list = history.slice().reverse().map((m) => rl.decorateMatch(m, own));
    return { matches: list, summary: rl.summarizeHistory(history, own) };
  });
  handle('rl:player', (key) => {
    const p = rl.rlPlayerProfile(history, ownIdentity(), rl.validateRlPlayerKey(key));
    if (!p) throw new ApiError('NOT_FOUND', 'Pelaajaa ei löytynyt tallennetuista otteluista.');
    return p;
  });
  handle('rl:players', (arg) => {
    const v = rl.validateRlPlayersArg(arg);
    const r = rl.listRlPlayers(rl.buildRlPlayerIndex(history, ownIdentity()), v);
    return {
      total: r.total, knownTotal: r.knownTotal, page: r.page, pages: r.pages, pageSize: r.pageSize, sort: r.sort,
      players: r.players.map((e) => ({ key: e.key, name: e.name, otherNames: e.names.slice(1, 4), platform: e.platform, games: e.games, with: e.with, against: e.against, lastSeen: e.lastSeen })),
    };
  });
  handle('rl:history:clear', () => {
    history.length = 0;
    writeJsonAtomic(historyFile, history);
    tracker.history = history;
    scheduleEmit();
    return true;
  });

  // --- Stats API -käyttöönotto
  handle('rl:detect', () => {
    const found = rlIni.detectInstalls();
    found.forEach((f) => allowDir(f.dir));
    const saved = settings.get().rlInstallDir;
    if (saved) allowDir(saved);
    return { installs: found, saved, snippet: rlIni.buildSnippet(settings.get().rlWebPort) };
  });
  handle('rl:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Valitse Rocket Leaguen asennuskansio',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    allowDir(dir);
    return rlIni.inspectInstall(dir);
  });
  handle('rl:inspect', (dir) => {
    if (!isAllowedDir(dir)) throw new Error('Tuntematon kansio. Valitse kansio listasta tai valintaikkunasta.');
    return rlIni.inspectInstall(dir);
  });
  handle('rl:enable', (dir) => {
    if (!isAllowedDir(dir)) throw new Error('Tuntematon kansio. Valitse kansio listasta tai valintaikkunasta.');
    const r = rlIni.enableInstall(dir, settings.get().rlWebPort);
    if (r.ok) settings.set({ rlInstallDir: dir });
    return r;
  });

  // --- Päivitykset
  handle('updater:state', () => updater.state());
  handle('updater:check', () => updater.check());
  handle('updater:install', () => updater.install());

  // --- Yleiset
  handle('app:info', () => ({
    name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, dataDir: app.getPath('userData'),
  }));
  handle('app:clearCache', async () => {
    http.clearCache();
    await session.defaultSession.clearCache();
    return true;
  });
  handle('app:openExternal', async (url) => {
    let u;
    try { u = new URL(String(url)); } catch (_) { throw new Error('Virheellinen osoite.'); }
    if (u.protocol !== 'https:') throw new Error('Vain https-osoitteet sallitaan.');
    await shell.openExternal(u.toString());
    return true;
  });
  handle('app:copy', (text) => {
    if (typeof text !== 'string' || text.length > 2000) throw new Error('Virheellinen teksti.');
    if (SMOKE) { smokeCopied = text; return true; }
    clipboard.writeText(text);
    return true;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1000, minHeight: 680,
    backgroundColor: '#0b0f1a',
    title: 'Statsikka',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // --hidden (Windowsin automaattikäynnistys): suoraan trayhin ilman ikkunaa. Vaatii toimivan trayn, muuten ikkunaan ei pääsisi takaisin.
  const startHidden = BG.shouldStartHidden({ argv: process.argv, runInBackground: settings.get().runInBackground, trayOk: !!trayCtl && trayCtl.exists() });
  if (SMOKE) smoke.startedHidden = startHidden;
  win.once('ready-to-show', () => {
    if (startHidden) return;
    if (SMOKE) smoke.startupShown = true; else win.show();
  });
  win.on('close', onWindowClose);
  win.on('session-end', () => { quitting = true; }); // Windowsin sammutus / uloskirjautuminen ei saa jäädä piilotuksen varaan
  win.webContents.on('before-input-event', onWindowInput);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch (_) { /* ohita */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const argGame = gameFromArgv(process.argv); // vasta loadFilen jälkeen: isLoading() on silloin tosi ja viesti odottaa latausta
  if (argGame) sendWhenLoaded('app:openGame', { game: argGame });
  return win;
}

const lock = app.requestSingleInstanceLock();
if (!lock && !SMOKE) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => onSecondInstance(argv)); // Kaynnista.bat uudelleen -> ikkuna esiin (Windowsin --hidden-käynnistys ei)
  app.on('before-quit', () => { quitting = true; if (arz) arz.flush(); });

  app.whenReady().then(() => {
    const dir = app.getPath('userData');
    settings = createSettings(dir);
    credStore = OWL.createCredStore({ dir, safeStorage });
    // Overwolf: ow-electron lukee tunnukset ympäristöstä prosessin käynnistyessä. Jos tallennetut tunnukset (tai dev-kanava) puuttuvat nykyisestä
    // prosessista, asetetaan ne ja käynnistetään uudelleen ENNEN ikkunan luontia (silmukkasuoja: yksi yritys per käynnistysketju).
    startupPlan = OWL.planStartup({
      env: process.env, argv: process.argv, creds: SMOKE ? null : credStore.load(), devChannel: settings.get().gepDevChannel,
      relaunched: RELAUNCHED, smoke: SMOKE, hasOverwolf: !!app.overwolf,
    });
    if (startupPlan.action === 'relaunch') { relaunchWith(startupPlan); return; }
    // Savutestissä automaattinen siirtyminen on aluksi pois (mock-RL:n ottelun alku ei saa vaihtaa näkymää kesken muiden tarkistusten); testi kytkee sen päälle erikseen.
    // Samoin pelin käynnistyksen automaattinen avaus: testi kytkee sen päälle erikseen.
    if (SMOKE) settings.set({ autoLive: false, openOnGameLaunch: false });
    lobbyStore = lobbies.createLobbyStore(path.join(dir, 'ow-lobbies.json'));
    gameTracker = gameDetect.createGameTracker(sendGameState);
    launchWatcher = BG.createLaunchWatcher(onGameLaunch);
    detector = gameDetect.createDetector({ onState: (st) => { for (const g of gameDetect.GAMES) gameTracker.setRunning(g, st[g]); launchWatcher.update(st); } });
    trayCtl = createTrayController({
      Tray: SMOKE ? SmokeTray : Tray, Menu, nativeImage, iconPath: path.join(__dirname, '..', '..', 'assets', 'tray.png'),
      handlers: trayHandlers, log: (s) => console.error(s),
    });
    syncTray();
    syncLoginSetting(); // asetus näyttää todellisen tilan (esim. Tehtävienhallinnassa poistettu kohde)
    historyFile = path.join(dir, 'rl-matches.json');
    const loaded = readJson(historyFile, []);
    history = Array.isArray(loaded) ? loaded : [];
    profileStore = P.createHistoryStore(path.join(dir, 'profile-history.json'));

    http = createHttp({ onNotice: (n) => send('ow:notice', n) });
    owApi = ow.createOw(http);
    r6 = createR6(); // käsin syötettyjen lukujen arvio
    arz = ARZ.createArenyze({
      dir, safeStorage, fetchImpl: (...a) => arzFetch(...a), getSettings: () => settings.get(),
      onUpdate: () => { send('arenyze:update', {}); scheduleGepEmit(); }, onNotice: (n) => send('ow:notice', n),
    });
    r6svc = createR6Service({
      dataDir: dir,
      getSettings: () => settings.get(),
      setSettings: (patch) => { settings.set(patch); send('r6:update', { settingsChanged: true, ...r6svc.lite() }); },
      // Kun GEP seuraa ottelua, se omistaa alun ja lopun: tallenteen ilmestyminen (1. kierroksen jälkeen) ei saa siirtää näkymää uudelleen eikä päättää ottelua.
      onChange: (p) => { send('r6:update', p); if (!p.activeName && !gep.isActive('r6')) gameTracker.matchEnded('r6'); if (gep.isLive('r6')) scheduleGepEmit(); },
      onMatchStart: (name) => { if (!gep.isActive('r6')) startMatch('r6', name); },
    });
    gep.on('matchStart', (e) => startMatch(e.game, e.key));
    gep.on('matchEnd', (e) => gameTracker.matchEnded(e.game));
    gep.on('change', scheduleGepEmit);
    gep.on('status', scheduleGepEmit);
    gep.on('log', (s) => console.log('[gep]', s));

    tracker = new rl.RlTracker({
      getOwn: ownIdentity,
      history,
      onMatchStored: () => { try { writeJsonAtomic(historyFile, history); } catch (e) { console.error('Historian tallennus epäonnistui:', e.message); } },
      onChange: (ev) => { learnOwnId(); scheduleEmit(); onRlEvent(ev); },
    });
    rlClient = createRlClient({
      getPort: () => settings.get().rlWebPort,
      tracker,
      onStatus: () => scheduleEmit(),
    });

    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // Päivitys asentuu lopetettaessa: quitting-lippu (sama kuin quitApp / before-quit) estää ikkunan piilotuksen trayhin, joten sovellus todella sulkeutuu.
    updater = createUpdater({
      app, autoUpdater: () => require('electron-updater').autoUpdater, smoke: SMOKE,
      send: (ch, p) => send(ch, p), beforeInstall: () => { quitting = true; }, log: (s) => console.error('[updater]', s),
    });
    registerIpc();
    createWindow();
    rlClient.connect();

    // Oman OW-profiilin tilannekuva käynnistyessä ja 30 min välein.
    owScheduler = P.createScheduler({
      run: async () => {
        if (!owKey()) return;
        const r = await refreshOw(false);
        if (r && r.added) send('profile:update', {});
      },
      onError: (e) => console.error('Oman OW-profiilin päivitys epäonnistui:', e && e.message),
    });
    owScheduler.start();
    detector.start();
    updater.start(); // no-op kehitysajossa ja savutestissä

    // Savutestissä tallenteiden luku käynnistetään vasta testin omasta pyynnöstä (hooks.startR6), jotta varhaiset tarkistukset ovat deterministisiä.
    if (!SMOKE) r6svc.start();

    if (SMOKE) {
      // Vain savutestille: esitäytä oman OW-profiilin historia (toimii myös ilman verkkoa).
      const hooks = {
        seedOw(seed) {
          const k = owKey();
          if (!k) throw new Error('Aseta ensin owProfile.');
          // Yhdistä jo haettuun dataan (vanhemmat tilannekuvat ensin).
          const cur = profileStore.data.ow.tag === k.key ? profileStore.data.ow : P.emptyHistory().ow;
          const progress = {};
          for (const role of P.OW_ROLES) progress[role] = (seed.progress[role] || []).concat(cur.progress[role] || []);
          profileStore.data.ow = P.normalizeHistory({ ow: { tag: k.key, snapshots: seed.snapshots.concat(cur.snapshots), progress } }).ow;
          profileStore.save();
        },
        // Keinotekoiset OW-profiilit ow:profile-kutsulle ja omalle profiilille (epätavallisten tilastojen näyttö).
        setProfiles(map) { smokeProfiles = map; },
        setOwnProfile(profile) {
          const k = owKey();
          if (!k) throw new Error('Aseta ensin owProfile.');
          ownOw = { fetchedAt: Date.now(), profile, error: null, key: k.key };
        },
        clearOwn() { ownOw = null; },
        // Pelin tila ja ottelun alku ilman oikeita pelejä: tasklist-kysely ohitetaan.
        injectGame(partial) { detector.inject(partial); },
        startMatch: (game, id) => startMatch(game, id),
        endMatch: (game) => gameTracker.matchEnded(game),
        startR6: () => r6svc.start(),
        r6Ready: () => r6svc.whenReady(),
        r6Dir: () => r6svc.status().dir,
        copied: () => smokeCopied,
        // Arenyze: keinotekoinen fetch (fixture-JSON) ja sisäiset mittarit; oikeaa verkkoa ei koskaan käytetä savutestissä.
        arzSetFetch(fn) { arzFetch = fn; },
        arzUsage: () => arz.usage(),
        arzKeyFile: () => arz.keys.file,
        arzCacheFile: () => arz._store.file,
        arzFlush: () => arz.flush(),
        // Keinotekoiset GEP-viestit samaan normalisoijaan kuin oikea GEP (ei Overwolfia, ei pelejä).
        gepInfo: (game, msg) => gep.feed(game, 'info', msg),
        gepEvent: (game, msg) => gep.feedEvent(game, msg),
        gepReset: (game) => gep.reset(game),
        gepClock: (ts) => { gepClock = ts || null; },
        gepState: () => gepPayload(),
        gepStatus: () => gep.status(),
        // Taustatila: kirjaavat tekaistut ikkunan näytöt, tray ja Windows-käynnistys (ikkunaa ei koskaan näytetä oikeasti).
        bg: {
          state: () => ({
            startedHidden: smoke.startedHidden, startupShown: smoke.startupShown, inactive: smoke.inactive, focused: smoke.focused.slice(), hides: smoke.hides, quits: smoke.quits,
            launches: smoke.launches.slice(), login: { calls: smoke.login.calls.slice(), on: smoke.login.on }, appPath: app.getAppPath(), execPath: process.execPath, argv: process.argv.slice(1), hasOverwolf: !!app.overwolf,
          }),
          tray: () => {
            const t = smoke.tray;
            if (!t) return null;
            return {
              destroyed: t.destroyed, tooltip: t.tooltip, empty: t.image.isEmpty(), size: t.image.getSize(), scales: t.image.getScaleFactors(),
              labels: t.menu ? t.menu.items.map((i) => (i.type === 'separator' ? '-' : i.label)) : [], doubleClick: typeof t.handlers['double-click'] === 'function',
            };
          },
          trayClick: (label) => { const it = smoke.tray.menu.items.find((i) => i.label === label); if (!it) throw new Error(`ei valikkokohtaa ${label}`); it.click(); },
          trayDoubleClick: () => smoke.tray.handlers['double-click'](),
          setVisible: (v) => { smoke.fakeVisible = v; },
          reset: () => { smoke.inactive = 0; smoke.focused.length = 0; smoke.hides = 0; smoke.quits = 0; smoke.launches.length = 0; },
          close: () => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; onWindowClose(ev); return { prevented: ev.prevented, hides: smoke.hides }; },
          key: (input) => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; onWindowInput(ev, input); return { prevented: ev.prevented, quits: smoke.quits }; },
          secondInstance: (argv) => onSecondInstance(argv),
        },
      };
      require('./smoke').run(win, app, () => ({ globalWebSocket: typeof WebSocket, rlStatus: rlClient.getStatus(), port: settings.get().rlWebPort }), hooks);
    }
  });

  app.on('window-all-closed', () => { if (updater) updater.stop(); if (owScheduler) owScheduler.stop(); if (rlClient) rlClient.stop(); if (detector) detector.stop(); if (r6svc) r6svc.stop(); if (arz) arz.flush(); app.quit(); });
}
