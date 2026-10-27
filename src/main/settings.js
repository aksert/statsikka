'use strict';
const path = require('path');
const { readJson, writeJsonAtomic } = require('./store');
const ow = require('./providers/ow');
const { SENSITIVITIES } = require('./suspicion');

const DEFAULTS = Object.freeze({
  owPlatform: 'pc',        // 'pc' | 'console'
  owGamemode: 'competitive', // pelaajahaun oletuspelitila: 'competitive' | 'quickplay'
  suspicionSensitivity: 'normal', // epätavallisten tilastojen indikaattori: 'off' | 'normal' | 'strict'
  rlOwnName: '',           // oma nimi Rocket Leaguessa
  rlOwnId: '',             // opittu PrimaryId (esim. "Epic|abc|0")
  rlWebPort: 49124,        // Stats API WebSocket-portti
  rlInstallDir: '',        // viimeksi valittu RL-asennuskansio
  owProfile: Object.freeze({ battletag: '', platform: 'pc' }), // oma OW-profiili ("Nimi#1234", 'pc' | 'console')
  rlPlatform: 'epic',      // oma RL-alusta (vain tiedoksi): epic | steam | psn | xbox | switch
  r6Name: '',              // oma Ubisoft-nimi (täyttyy automaattisesti ottelutallenteista, jos tyhjä)
  autoLive: true,          // siirry automaattisesti pelin live-näkymään, kun ottelu alkaa (vain sovelluksen sisäinen näkymänvaihto)
  r6AutoName: true,        // sisäinen: false kun käyttäjä kirjautui ulos (nimeä ei täytetä uudelleen automaattisesti)
  r6ReplayDir: '',         // sisäinen: dialogista valittu MatchReplay-kansio (tyhjä = automaattinen haku)
  gepDevChannel: true,     // Overwolf GEP: käytä dev-kanavaa (--owepm-package-channel=gep:dev); R6 on dev-kanavalla
  runInBackground: true,   // ikkunan sulkeminen piilottaa sovelluksen tray-kuvakkeeseen (Lopeta: tray-valikko tai Ctrl+Q)
  openOnGameLaunch: true,  // pelin käynnistyessä ikkuna avataan ilman kohdistusta (showInactive) ja siirrytään pelin live-näkymään
  startWithWindows: false, // käynnistä Windowsin mukana piilotettuna trayhin (todellinen tila luetaan käyttöjärjestelmältä, ks. main.js)
  arenyzeAuto: true,       // Arenyze: hae live-ottelun pelaajat automaattisesti (vain kun API-avain on asetettu)
  arenyzeSoftLimit: 1800,  // Arenyze: kuukauden kutsumäärä, jonka jälkeen automaattiset haut loppuvat (ilmaisen tilin raja 2 000 / kk); 0 = ei automaattisia hakuja
});
const SOFT_LIMIT_MAX = 1000000;

const RL_PLATFORMS = ['epic', 'steam', 'psn', 'xbox', 'switch'];
const OW_GAMEMODES = ['competitive', 'quickplay'];

// Renderöijä saa muuttaa vain näitä. rlOwnId ja rlInstallDir ovat pääprosessin sisäisiä (opittu id, dialogista valittu kansio).
const IPC_KEYS = ['owPlatform', 'owGamemode', 'suspicionSensitivity', 'rlOwnName', 'rlWebPort', 'owProfile', 'rlPlatform', 'r6Name', 'autoLive', 'gepDevChannel', 'runInBackground', 'openOnGameLaunch', 'startWithWindows', 'arenyzeAuto', 'arenyzeSoftLimit'];
const BOOL_KEYS = ['runInBackground', 'openOnGameLaunch', 'startWithWindows', 'arenyzeAuto'];

// Palauttaa siivotun, validoidun asetusosajoukon (tuntemattomat avaimet pudotetaan).
function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('owPlatform' in patch && (patch.owPlatform === 'pc' || patch.owPlatform === 'console')) {
    out.owPlatform = patch.owPlatform;
  }
  if ('owGamemode' in patch && OW_GAMEMODES.includes(patch.owGamemode)) out.owGamemode = patch.owGamemode;
  if ('suspicionSensitivity' in patch && SENSITIVITIES.includes(patch.suspicionSensitivity)) out.suspicionSensitivity = patch.suspicionSensitivity;
  if ('rlOwnName' in patch && typeof patch.rlOwnName === 'string') {
    out.rlOwnName = patch.rlOwnName.trim().slice(0, 64);
  }
  if ('rlOwnId' in patch && typeof patch.rlOwnId === 'string') {
    out.rlOwnId = patch.rlOwnId.trim().slice(0, 128);
  }
  if ('rlWebPort' in patch) {
    const n = Number(patch.rlWebPort);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) out.rlWebPort = n;
  }
  if ('rlInstallDir' in patch && typeof patch.rlInstallDir === 'string') {
    out.rlInstallDir = patch.rlInstallDir.slice(0, 400);
  }
  // Osittainen: vain kelvolliset avaimet mukaan, loput säilyvät (yhdistetään set():ssä).
  if ('owProfile' in patch && patch.owProfile && typeof patch.owProfile === 'object') {
    const p = patch.owProfile;
    const op = {};
    if (typeof p.battletag === 'string') {
      const t = p.battletag.trim();
      if (t === '') op.battletag = '';
      else { const parsed = ow.parseBattleTag(t); if (parsed) op.battletag = `${parsed.name}#${parsed.number}`; }
    }
    if (p.platform === 'pc' || p.platform === 'console') op.platform = p.platform;
    if (Object.keys(op).length) out.owProfile = op;
  }
  if ('rlPlatform' in patch && RL_PLATFORMS.includes(patch.rlPlatform)) out.rlPlatform = patch.rlPlatform;
  if ('autoLive' in patch && typeof patch.autoLive === 'boolean') out.autoLive = patch.autoLive;
  if ('gepDevChannel' in patch && typeof patch.gepDevChannel === 'boolean') out.gepDevChannel = patch.gepDevChannel;
  for (const k of BOOL_KEYS) if (k in patch && typeof patch[k] === 'boolean') out[k] = patch[k];
  if ('arenyzeSoftLimit' in patch && typeof patch.arenyzeSoftLimit === 'number' && Number.isInteger(patch.arenyzeSoftLimit) && patch.arenyzeSoftLimit >= 0 && patch.arenyzeSoftLimit <= SOFT_LIMIT_MAX) out.arenyzeSoftLimit = patch.arenyzeSoftLimit;
  if ('r6AutoName' in patch && typeof patch.r6AutoName === 'boolean') out.r6AutoName = patch.r6AutoName;
  if ('r6ReplayDir' in patch && typeof patch.r6ReplayDir === 'string') out.r6ReplayDir = patch.r6ReplayDir.slice(0, 400);
  if ('r6Name' in patch && typeof patch.r6Name === 'string') {
    out.r6Name = patch.r6Name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  }
  return out;
}

// Tiukka tarkistus IPC-kutsulle: palauttaa virheilmoituksen (merkkijono) tai null. sanitize() pudottaa hiljaa, tämä hylkää.
function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Virheellinen pyyntö.';
  const keys = Object.keys(patch);
  if (keys.length === 0) return 'Ei muutettavia asetuksia.';
  for (const k of keys) if (!IPC_KEYS.includes(k)) return `Tuntematon asetus: ${k}.`;
  const v = patch;
  if ('owPlatform' in v && !['pc', 'console'].includes(v.owPlatform)) return 'Virheellinen OW-alusta.';
  if ('owGamemode' in v && !OW_GAMEMODES.includes(v.owGamemode)) return 'Virheellinen OW-pelitila.';
  if ('suspicionSensitivity' in v && !SENSITIVITIES.includes(v.suspicionSensitivity)) return 'Virheellinen herkkyys.';
  if ('rlPlatform' in v && !RL_PLATFORMS.includes(v.rlPlatform)) return 'Virheellinen RL-alusta.';
  if ('rlWebPort' in v) {
    const n = Number(v.rlWebPort);
    if (typeof v.rlWebPort === 'boolean' || v.rlWebPort === '' || !Number.isInteger(n) || n < 1024 || n > 65535) return 'Portin pitää olla kokonaisluku 1024–65535.';
  }
  if ('rlOwnName' in v && (typeof v.rlOwnName !== 'string' || v.rlOwnName.trim().length > 64)) return 'Virheellinen Rocket League -nimi (enintään 64 merkkiä).';
  if ('r6Name' in v && (typeof v.r6Name !== 'string' || v.r6Name.trim().length > 32 || /[\x00-\x1f]/.test(v.r6Name))) return 'Virheellinen Ubisoft-nimi (enintään 32 merkkiä).';
  if ('autoLive' in v && typeof v.autoLive !== 'boolean') return 'Virheellinen automaattisen siirtymän asetus.';
  if ('gepDevChannel' in v && typeof v.gepDevChannel !== 'boolean') return 'Virheellinen GEP-kanavan asetus.';
  if ('runInBackground' in v && typeof v.runInBackground !== 'boolean') return 'Virheellinen taustatilan asetus.';
  if ('openOnGameLaunch' in v && typeof v.openOnGameLaunch !== 'boolean') return 'Virheellinen pelin käynnistyksen avausasetus.';
  if ('startWithWindows' in v && typeof v.startWithWindows !== 'boolean') return 'Virheellinen Windowsin mukana käynnistymisen asetus.';
  if ('arenyzeAuto' in v && typeof v.arenyzeAuto !== 'boolean') return 'Virheellinen Arenyze-automaattihaun asetus.';
  if ('arenyzeSoftLimit' in v && (typeof v.arenyzeSoftLimit !== 'number' || !Number.isInteger(v.arenyzeSoftLimit) || v.arenyzeSoftLimit < 0 || v.arenyzeSoftLimit > SOFT_LIMIT_MAX)) return `Pehmeän rajan pitää olla kokonaisluku 0–${SOFT_LIMIT_MAX}.`;
  if ('owProfile' in v) {
    const p = v.owProfile;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Virheellinen OW-profiili.';
    for (const k of Object.keys(p)) if (k !== 'battletag' && k !== 'platform') return `Tuntematon OW-profiilin kenttä: ${k}.`;
    if ('battletag' in p) {
      if (typeof p.battletag !== 'string') return 'Virheellinen BattleTag. Muoto: Nimi#1234.';
      if (p.battletag.trim() !== '' && !ow.parseBattleTag(p.battletag)) return 'Virheellinen BattleTag. Muoto: Nimi#1234.';
    }
    if ('platform' in p && !['pc', 'console'].includes(p.platform)) return 'Virheellinen OW-alusta.';
  }
  return null;
}

function merge(base, patchClean) {
  const next = { ...base, ...patchClean };
  if (patchClean.owProfile) next.owProfile = { ...base.owProfile, ...patchClean.owProfile };
  return next;
}

function createSettings(dir) {
  const file = path.join(dir, 'settings.json');
  let data = merge({ ...DEFAULTS }, sanitize(readJson(file, {})));
  return {
    get: () => ({ ...data, owProfile: { ...data.owProfile } }),
    set(patch) {
      data = merge(data, sanitize(patch));
      writeJsonAtomic(file, data);
      return { ...data, owProfile: { ...data.owProfile } };
    },
    file,
  };
}

module.exports = { createSettings, sanitize, validate, DEFAULTS, OW_GAMEMODES };
