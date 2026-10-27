'use strict';
// Overwatch 2: lobbyistunnot (jokainen "Hae kaikki") -> kohtaamiset ja "Edellinen"-merkki. Puhdasta logiikkaa + pieni levytallennus
// (`ow-lobbies.json`, enintään 500 istuntoa). Overwatchin julkinen profiili ei sisällä otteluhistoriaa, joten tämä on ainoa
// lähde sille, keitä olet kohdannut.
const { readJson, writeJsonAtomic } = require('./store');
const { ApiError } = require('./http');
const ow = require('./providers/ow');

const CAP = 500;
const SIDE_MAX = 5;
const DEDUPE_MS = 5 * 60 * 1000; // sama kokoonpano uudelleen 5 min sisällä = sama lobby (ei uusi istunto)

function bad(msg) { return new ApiError('BAD_INPUT', msg); }
const tagKey = (t) => { const p = ow.parseBattleTag(typeof t === 'string' ? t : ''); return p ? p.id.toLowerCase() : ''; };

// Kelvolliset BattleTagit "Nimi#1234"-muodossa, duplikaatit pois, enintään SIDE_MAX.
function cleanTags(list) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const p = ow.parseBattleTag(typeof t === 'string' ? t : '');
    if (!p) continue;
    const k = p.id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(`${p.name}#${p.number}`);
    if (out.length >= SIDE_MAX) break;
  }
  return out;
}

// Levyltä luettu istunto -> siivottu istunto tai null.
function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const ts = Number(s.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const ally = cleanTags(s.ally), enemy = cleanTags(s.enemy);
  if (!ally.length && !enemy.length) return null;
  return {
    ts: Math.round(ts), mode: ow.GAMEMODES.includes(s.mode) ? s.mode : 'competitive', platform: ow.PLATFORMS.includes(s.platform) ? s.platform : 'pc', ally, enemy,
  };
}

// IPC-argumentti { mode, platform, ally[], enemy[] }. Tuntemattomat kentät ja virheelliset tyypit hylätään; kelvottomat tagit pudotetaan.
function validateRecordArg(arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw bad('Virheellinen pyyntö.');
  for (const k of Object.keys(arg)) if (!['mode', 'platform', 'ally', 'enemy'].includes(k)) throw bad(`Tuntematon kenttä: ${k}.`);
  if (!ow.GAMEMODES.includes(arg.mode)) throw bad('Virheellinen pelitila.');
  if (!ow.PLATFORMS.includes(arg.platform)) throw bad('Virheellinen alusta.');
  for (const side of ['ally', 'enemy']) {
    const a = arg[side];
    if (!Array.isArray(a) || a.length > SIDE_MAX) throw bad(`Virheellinen lista: ${side}.`);
    if (a.some((x) => typeof x !== 'string' || x.length > 40)) throw bad(`Virheellinen BattleTag listassa: ${side}.`);
  }
  const ally = cleanTags(arg.ally), enemy = cleanTags(arg.enemy);
  if (!ally.length && !enemy.length) throw bad('Ei kelvollisia BattleTageja.');
  return { mode: arg.mode, platform: arg.platform, ally, enemy };
}
function validateTagArg(tag) {
  const p = ow.parseBattleTag(typeof tag === 'string' ? tag : '');
  if (!p) throw bad('Virheellinen BattleTag. Muoto: Nimi#1234.');
  return `${p.name}#${p.number}`;
}

const keysOf = (arr) => arr.map(tagKey).sort().join('|');
function sameLobby(a, b) { return a.mode === b.mode && a.platform === b.platform && keysOf(a.ally) === keysOf(b.ally) && keysOf(a.enemy) === keysOf(b.enemy); }

// Lisää istunnon. Palauttaa { list, prev, replaced }: prev = istuntoa edeltävä lobby (edellinen ottelu), replaced = sama lobby uudelleen.
function addSession(list, session, cap = CAP) {
  const out = list.slice();
  const last = out[out.length - 1];
  let replaced = false;
  if (last && sameLobby(last, session) && session.ts - last.ts >= 0 && session.ts - last.ts < DEDUPE_MS) {
    out[out.length - 1] = { ...last, ts: session.ts }; replaced = true;
  } else out.push(session);
  if (out.length > cap) out.splice(0, out.length - cap);
  const prev = out.length >= 2 ? out[out.length - 2] : null;
  return { list: out, prev, replaced };
}

// Edellisen lobbyn näkymä: oma BattleTag pois. Map tagKey -> 'ally' | 'enemy'.
function prevSides(prev, ownTag) {
  const out = new Map();
  if (!prev) return out;
  const own = tagKey(ownTag);
  for (const t of prev.enemy) if (tagKey(t) !== own) out.set(tagKey(t), 'enemy');
  for (const t of prev.ally) if (tagKey(t) !== own) out.set(tagKey(t), 'ally');
  return out;
}
function withoutOwn(session, ownTag) {
  if (!session) return null;
  const own = tagKey(ownTag);
  return { ...session, ally: session.ally.filter((t) => !own || tagKey(t) !== own), enemy: session.enemy.filter((t) => !own || tagKey(t) !== own) };
}

// Kohtaamiset: istunnot, joissa BattleTag esiintyi (uusin ensin).
function encountersOf(list, tag, limit = 50) {
  const k = tagKey(tag);
  const items = [];
  let withN = 0, againstN = 0;
  for (let i = list.length - 1; i >= 0 && k; i--) {
    const s = list[i];
    const side = s.ally.some((t) => tagKey(t) === k) ? 'ally' : s.enemy.some((t) => tagKey(t) === k) ? 'enemy' : null;
    if (!side) continue;
    if (side === 'ally') withN++; else againstN++;
    if (items.length < limit) items.push({ ts: s.ts, mode: s.mode, platform: s.platform, side });
  }
  return { tag, total: withN + againstN, with: withN, against: againstN, items };
}

function createLobbyStore(file, opts = {}) {
  const cap = opts.cap || CAP;
  const now = opts.now || Date.now;
  const raw = readJson(file, []);
  let list = (Array.isArray(raw) ? raw : []).map(normalizeSession).filter(Boolean).slice(-cap);
  return {
    // arg on jo validoitu (validateRecordArg). Palauttaa edellisen lobbyn.
    record(arg, ts) {
      const r = addSession(list, { ts: ts || now(), mode: arg.mode, platform: arg.platform, ally: arg.ally, enemy: arg.enemy }, cap);
      list = r.list;
      writeJsonAtomic(file, list);
      return { prev: r.prev, replaced: r.replaced };
    },
    encounters: (tag) => encountersOf(list, tag),
    all: () => list.slice(),
    file,
  };
}

module.exports = {
  CAP, DEDUPE_MS, tagKey, cleanTags, normalizeSession, validateRecordArg, validateTagArg, sameLobby, addSession, prevSides, withoutOwn, encountersOf, createLobbyStore,
};
