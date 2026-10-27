'use strict';
// Overwolf-tunnukset (OW_DEV_KEY tai OW_CLI_EMAIL + OW_CLI_API_KEY) ja käynnistyksen uudelleenkäynnistyslogiikka.
// ow-electron lukee tunnukset ympäristömuuttujista prosessin käynnistyessä, joten tunnukset tallennetaan salattuna (Electronin safeStorage)
// ja pääprosessi käynnistää sovelluksen tarvittaessa uudelleen ennen ikkunan luontia. Tunnuksia ei kirjata lokiin eikä lähetetä minnekään:
// ne päätyvät vain ympäristömuuttujiksi ow-electronille. Ei Electron-riippuvuuksia (safeStorage ja fs annetaan sisään) -> testattavissa node:lla.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./store');

const CRED_FILE = 'ow-credentials.bin';
const ENV_KEYS = Object.freeze(['OW_DEV_KEY', 'OW_CLI_EMAIL', 'OW_CLI_API_KEY']);
const CHANNEL_ARG = '--owepm-package-channel=gep:dev';
const CHANNEL_PREFIX = '--owepm-package-channel=gep:';
const RELAUNCH_FLAG = 'STATSIKKA_OW_RELAUNCHED';

// ---- Validointi ---------------------------------------------------------------------------------
const TOKEN_RE = /^[\x21-\x7e]{8,2048}$/; // tulostettavaa ASCII:ta, ei välilyöntejä
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

// IPC-argumentti { mode: 'dev' | 'console', devKey?, email?, apiKey?, devChannel? } -> siivottu { mode, devKey | email + apiKey }. Heittää Error(suomeksi).
function validateCredsArg(arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('Virheellinen pyyntö.');
  for (const k of Object.keys(arg)) if (!['mode', 'devKey', 'email', 'apiKey', 'devChannel'].includes(k)) throw new Error(`Tuntematon kenttä: ${k}.`);
  if (arg.devChannel !== undefined && typeof arg.devChannel !== 'boolean') throw new Error('Virheellinen kanavavalinta.');
  if (arg.mode !== 'dev' && arg.mode !== 'console') throw new Error('Valitse tunnustyyppi.');
  if (arg.mode === 'dev') {
    if (arg.email !== undefined || arg.apiKey !== undefined) throw new Error('Anna joko kehittäjäavain tai Console-tunnukset, ei molempia.');
    const devKey = typeof arg.devKey === 'string' ? arg.devKey.trim() : '';
    if (!TOKEN_RE.test(devKey)) throw new Error('Kehittäjäavain puuttuu tai on virheellinen (vähintään 8 merkkiä, ei välilyöntejä).');
    return { mode: 'dev', devKey };
  }
  if (arg.devKey !== undefined) throw new Error('Anna joko kehittäjäavain tai Console-tunnukset, ei molempia.');
  const email = typeof arg.email === 'string' ? arg.email.trim() : '';
  const apiKey = typeof arg.apiKey === 'string' ? arg.apiKey.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('Sähköpostiosoite puuttuu tai on virheellinen.');
  if (!TOKEN_RE.test(apiKey)) throw new Error('API-avain puuttuu tai on virheellinen (vähintään 8 merkkiä, ei välilyöntejä).');
  return { mode: 'console', email, apiKey };
}
// Levyltä luettu olio -> kelvollinen tunnus tai null.
function normalizeCreds(o) {
  if (!o || typeof o !== 'object') return null;
  try {
    if (o.mode === 'dev') return validateCredsArg({ mode: 'dev', devKey: o.devKey });
    if (o.mode === 'console') return validateCredsArg({ mode: 'console', email: o.email, apiKey: o.apiKey });
  } catch (_) { /* kelvoton */ }
  return null;
}

// ---- Ympäristömuuttujat ja käynnistyssuunnitelma ----------------------------------------------------
function envFromCreds(creds) {
  if (!creds) return {};
  return creds.mode === 'dev' ? { OW_DEV_KEY: creds.devKey } : { OW_CLI_EMAIL: creds.email, OW_CLI_API_KEY: creds.apiKey };
}
const hasEnvCreds = (env) => !!(env && (env.OW_DEV_KEY || (env.OW_CLI_EMAIL && env.OW_CLI_API_KEY)));
const hasChannelArg = (argv) => (argv || []).some((a) => typeof a === 'string' && a.startsWith(CHANNEL_PREFIX));
// Uudelleenkäynnistyksen argumentit: nykyiset (ilman suoritettavaa tiedostoa) ilman vanhaa gep-kanavaa, kanava lisätään pyydettäessä.
function buildArgs(argv, devChannel) {
  const rest = (argv || []).slice(1).filter((a) => !(typeof a === 'string' && a.startsWith(CHANNEL_PREFIX)));
  if (devChannel) rest.push(CHANNEL_ARG);
  return rest;
}

// Automaattinen tarkistus käynnistyksessä. Palauttaa { action: 'none' | 'relaunch', reason, setEnv, args }.
// Silmukkasuoja: jos edellinen prosessi jo käynnisti meidät uudelleen (relaunched), ei yritetä uudelleen.
function planStartup({ env, argv, creds, devChannel, relaunched, smoke, hasOverwolf = true }) {
  if (smoke) return { action: 'none', reason: 'smoke' };
  if (!hasOverwolf) return { action: 'none', reason: 'no-ow-electron' };
  if (!creds) return { action: 'none', reason: 'no-creds' };
  const envOk = hasEnvCreds(env);
  const argOk = devChannel ? (argv || []).includes(CHANNEL_ARG) : !hasChannelArg(argv);
  if (envOk && argOk) return { action: 'none', reason: 'ready' };
  if (relaunched) return { action: 'none', reason: 'relaunch-guard' };
  return { action: 'relaunch', reason: envOk ? 'channel' : 'env', setEnv: envOk ? {} : envFromCreds(creds), clearEnv: [], args: buildArgs(argv, devChannel) };
}
// Käyttäjän painama "Ota käyttöön ja käynnistä uudelleen": aina uudelleenkäynnistys uusilla tunnuksilla (vanhat muuttujat poistetaan).
function planEnable({ argv, creds, devChannel }) {
  const setEnv = envFromCreds(creds);
  return { action: 'relaunch', reason: 'enable', setEnv, clearEnv: ENV_KEYS.filter((k) => !(k in setEnv)), args: buildArgs(argv, devChannel) };
}
// Asettaa ympäristömuuttujat suunnitelman mukaan annettuun env-olioon (process.env).
function applyEnv(env, plan) {
  for (const k of plan.clearEnv || []) delete env[k];
  for (const [k, v] of Object.entries(plan.setEnv || {})) env[k] = v;
}

// ---- Salattu tunnusvarasto ------------------------------------------------------------------------------
// safeStorage: Electronin safeStorage (tai testissä feikki: isEncryptionAvailable, encryptString, decryptString).
function createCredStore({ dir, safeStorage }) {
  const file = path.join(dir, CRED_FILE);
  const available = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable() === true; } catch (_) { return false; } };
  return {
    file,
    available,
    has: () => fs.existsSync(file),
    // Kieltäytyy tallentamasta, jos salausta ei ole (ei koskaan selkotekstinä levylle).
    save(creds) {
      if (!available()) throw new Error('Salausta ei ole saatavilla tässä käyttöympäristössä (Windows DPAPI / safeStorage), joten tunnuksia ei tallenneta. Aseta ympäristömuuttuja OW_DEV_KEY käsin ennen käynnistystä.');
      const c = normalizeCreds(creds);
      if (!c) throw new Error('Virheelliset tunnukset.');
      writeFileAtomic(file, safeStorage.encryptString(JSON.stringify(c)));
      return true;
    },
    load() {
      if (!available()) return null;
      try { return normalizeCreds(JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))); } catch (_) { return null; }
    },
    clear() {
      try { fs.unlinkSync(file); return true; } catch (e) { return e && e.code === 'ENOENT'; }
    },
  };
}

module.exports = {
  CRED_FILE, ENV_KEYS, CHANNEL_ARG, CHANNEL_PREFIX, RELAUNCH_FLAG,
  validateCredsArg, normalizeCreds, envFromCreds, hasEnvCreds, hasChannelArg, buildArgs, planStartup, planEnable, applyEnv, createCredStore,
};
