'use strict';
// Overwolf Game Events Provider (GEP): live-pelitiedot Rainbow Six Siegelle ja Overwatch 2:lle.
// Toimii vain ow-electronilla (`app.overwolf` on olemassa). Tavallisella Electronilla ja savutestissä kääre on no-op, kunnes dataa syötetään `feed()`:llä.
// Moduuli ei tuo Electronia: `app` annetaan createGep():lle, joten kaikki logiikka on testattavissa node:lla.
// GEP-viestit normalisoidaan siisteiksi olioiksi (JSON-merkkijonot arvojen sisällä puretaan); tuntemattomat avaimet ohitetaan eikä mikään heitä poikkeusta.
const EventEmitter = require('events');
const ow = require('./providers/ow');

const GAME_IDS = Object.freeze({ r6: 10826, ow: 10844 });
const GAME_BY_ID = Object.freeze({ 10826: 'r6', 10844: 'ow' });
const GAMES = ['r6', 'ow'];
const STATES = ['inactive', 'waiting-credentials', 'ready', 'game-running', 'error'];
const KILLFEED_CAP = 30;
const RAW_CAP = 60;
const READY_TIMEOUT_MS = 90 * 1000;

const isObj = (a) => !!a && typeof a === 'object' && !Array.isArray(a);

// ---- Arvojen apurit ---------------------------------------------------------------------------
// GEP antaa monet arvot JSON-merkkijonoina ("{\"blue\":\"1\"}"). Purkaa objektin/taulukon; muut arvot palautetaan sellaisenaan.
function parseValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '' || t === 'null') return null;
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.parse(t); } catch (_) { return v; }
  }
  return v;
}
function toNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === 'true') return true; if (s === 'false') return false; }
  if (typeof v === 'number') return v !== 0;
  return false;
}
function toStr(v, max = 80) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
const orNull = (v) => (v === undefined ? null : v);

// ---- Nimien siistiminen -----------------------------------------------------------------------
const OPERATOR_FIX = { IQ: 'IQ', JAGER: 'Jäger', NOKK: 'Nøkk', CAPITAO: 'Capitão', 'ELA': 'Ela', 'JACKAL': 'Jackal' };
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (_m, a, b) => a + b.toUpperCase());
}
function prettyOperator(v) {
  const raw = toStr(v, 40);
  if (!raw) return '';
  const key = raw.toUpperCase();
  return OPERATOR_FIX[key] || titleCase(raw.replace(/_/g, ' '));
}
const HERO_FIX = { LUCIO: 'Lúcio', TORBJORN: 'Torbjörn', DVA: 'D.Va', 'D.VA': 'D.Va', SOLDIER_76: 'Soldier: 76', SOLDIER76: 'Soldier: 76', 'SOLDIER: 76': 'Soldier: 76' };
function prettyHero(v) {
  const raw = toStr(v, 40);
  if (!raw) return '';
  const key = raw.toUpperCase();
  return HERO_FIX[key] || titleCase(raw.replace(/_/g, ' '));
}
const ROLES = ['tank', 'damage', 'support'];
function normRole(v) {
  const s = toStr(v, 20).toLowerCase();
  return ROLES.includes(s) ? s : '';
}

const OW_MAPS = Object.freeze({
  3314: 'Antarctic Peninsula', 2018: 'Busan', 1645: 'Ilios', 1634: 'Lijiang Tower', 1719: 'Lijiang Tower', 1207: 'Nepal', 1694: 'Oasis', 2087: 'Circuit Royal', 707: 'Dorado',
  2628: 'Havana', 1878: 'Junkertown', 2161: 'Rialto', 1467: 'Route 66', 3205: 'Shambali Monastery', 388: 'Watchpoint: Gibraltar', 1886: 'Blizzard World', 2651: 'Blizzard World',
  1677: 'Eichenwalde', 2036: 'Eichenwalde', 687: 'Hollywood', 1707: 'Hollywood', 212: "King's Row", 1713: "King's Row", 2892: 'Midtown', 468: 'Numbani', 2360: 'Paraíso',
  2868: 'Colosseo', 3411: 'Esperança', 2795: 'New Queen Street', 3603: 'New Junk City', 3390: 'Suravasa', 3762: 'Runasapi', 4439: 'Hanaoka', 4448: 'Throne of Anubis', 3776: 'Samoa',
});
const OW_MODES = Object.freeze({
  7: 'Capture the Flag', 9: 'Elimination', 15: 'Uprising', 16: 'Skirmish', 20: 'Assault', 21: 'Escort', 22: 'Hybrid', 224: 'Clash', 23: 'Control', 25: 'Tutorial',
  29: 'Team Deathmatch', 30: 'Deathmatch', 109: 'Flashpoint', 90: 'Practice Range', 112: 'Bounty Hunter',
});

// ---- Pelaajien normalisointi -----------------------------------------------------------------
function normTeamR6(v) {
  const s = toStr(v, 12).toLowerCase();
  return s === 'blue' || s === 'orange' ? s : '';
}
// R6 roster_XX -> { slot, name, playerId, isLocal, isAnonymous, suffix, team, operator, kills, deaths, assists, score, ping, health }
function normalizeR6Player(raw, slot) {
  const o = parseValue(raw);
  if (!isObj(o)) return null;
  const name = toStr(o.player !== undefined ? o.player : (o.name !== undefined ? o.name : o.player_name), 40);
  const playerId = toStr(o.player_id !== undefined ? o.player_id : o.playerId, 80);
  if (!name && !playerId) return null;
  return {
    slot, name, playerId, isLocal: toBool(o.is_local), isAnonymous: toBool(o.is_anonymous), suffix: toNum(o.suffix),
    team: normTeamR6(o.team), operator: prettyOperator(o.operator),
    kills: toNum(o.kills), deaths: toNum(o.deaths), assists: toNum(o.assists), score: toNum(o.score), ping: toNum(o.ping), health: null, healthRaw: null,
  };
}
// OW roster_XX -> { slot, name, battletag, isLocal, isTeammate, hero, role, team, kills, deaths, assists, damage, healed, mitigated }
function normalizeOwPlayer(raw, slot) {
  const o = parseValue(raw);
  if (!isObj(o)) return null;
  const name = toStr(o.player_name !== undefined ? o.player_name : o.name, 40);
  const parsed = ow.parseBattleTag(toStr(o.battlenet_tag !== undefined ? o.battlenet_tag : o.battletag, 60));
  if (!name && !parsed) return null;
  const team = toNum(o.team);
  return {
    slot, name: name || (parsed ? parsed.name : ''), battletag: parsed ? `${parsed.name}#${parsed.number}` : '', isLocal: toBool(o.is_local),
    isTeammate: o.is_teammate === undefined || o.is_teammate === null ? null : toBool(o.is_teammate),
    hero: prettyHero(o.hero_name), role: normRole(o.hero_role), team: team === 0 || team === 1 ? team : null,
    kills: toNum(o.kills), deaths: toNum(o.deaths), assists: toNum(o.assists),
    damage: toNum(o.damage), healed: toNum(o.healed), mitigated: toNum(o.mitigated),
  };
}

// Päivitys samaan paikkaan: uusi arvo ylikirjoittaa vain kun se on määritelty; eri pelaaja korvaa koko rivin.
function samePlayer(a, b) {
  if (!a) return false;
  const ka = a.playerId || a.battletag || a.name, kb = b.playerId || b.battletag || b.name;
  return !!ka && ka === kb;
}
function mergePlayer(prev, next) {
  if (!prev || !samePlayer(prev, next)) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

// ---- Viestien purku ---------------------------------------------------------------------------
// Yksi GEP-viesti -> [{ feature, category, key, value }]. Tukee ow-electronin muotoa ({ feature, category, key, value })
// ja vanhaa muotoa ({ feature, info: { category: { key: value } } }).
function flattenUpdate(msg) {
  const out = [];
  if (!isObj(msg)) return out;
  const feature = toStr(msg.feature !== undefined ? msg.feature : msg.featureName, 40);
  if (isObj(msg.info)) {
    for (const [category, cat] of Object.entries(msg.info)) {
      if (!isObj(cat)) continue;
      for (const [key, value] of Object.entries(cat)) out.push({ feature, category, key, value });
    }
    return out;
  }
  const key = msg.key !== undefined ? msg.key : msg.name;
  if (key === undefined || key === null) return out;
  const value = msg.value !== undefined ? msg.value : msg.data;
  out.push({ feature, category: toStr(msg.category !== undefined ? msg.category : msg.categoryName, 40), key: toStr(key, 60), value: orNull(value) });
  return out;
}
// getInfo()-vastaus -> samat rivit (muodot { feature: { category: { key: value } } } tai { category: { key: value } }). Paras arvaus; virheet ohitetaan.
function flattenInfoSnapshot(info) {
  const out = [];
  if (!isObj(info)) return out;
  const root = isObj(info.res) ? info.res : isObj(info.info) ? info.info : info;
  for (const [a, av] of Object.entries(root)) {
    if (!isObj(av)) continue;
    const entries = Object.entries(av);
    const nested = entries.length > 0 && entries.every(([, v]) => isObj(v));
    if (nested) {
      for (const [category, cat] of entries) for (const [key, value] of Object.entries(cat)) out.push({ feature: a, category, key, value });
    } else {
      for (const [key, value] of entries) out.push({ feature: '', category: a, key, value });
    }
  }
  return out;
}

const ROSTER_RE = /^roster_(\d{1,3})$/;

// ---- Pelikohtainen tila ----------------------------------------------------------------------
function newGame(game) {
  return {
    game, running: false, hasContext: false, active: false, ended: false, seq: 0, phase: '', matchId: '', pseudoMatchId: '', map: '', mode: '', gameType: '', queue: '',
    round: null, score: { blue: null, orange: null }, outcome: '', roundOutcome: '', ownName: '', ownTag: '', roster: new Map(), killFeed: [], startedAt: 0, endedAt: 0, updatedAt: 0,
  };
}
function resetContext(st) {
  st.hasContext = false; st.active = false; st.ended = false; st.phase = ''; st.matchId = ''; st.pseudoMatchId = ''; st.map = ''; st.mode = ''; st.gameType = ''; st.queue = '';
  st.round = null; st.score = { blue: null, orange: null }; st.outcome = ''; st.roundOutcome = ''; st.roster = new Map(); st.killFeed = []; st.startedAt = 0; st.endedAt = 0;
}
function beginContext(st) {
  const keepTag = st.ownTag, keepName = st.ownName, keepPhase = st.phase;
  resetContext(st);
  st.ownTag = keepTag; st.ownName = keepName; st.phase = keepPhase;
  st.hasContext = true; st.seq++;
}
// Ottelun tunnistetiedot / rosteri kuuluvat "nykyiseen otteluun": edellisen ottelun päätyttyä ne aloittavat uuden, muuten ottelukonteksti syntyy tarvittaessa.
function touchContext(st) {
  if (st.ended) beginContext(st);
  else if (!st.hasContext) { st.hasContext = true; st.seq++; }
}
const matchKey = (st) => `${st.game}-${st.seq}`;

function pushKill(st, entry, now) {
  st.killFeed.push({ ts: now, ...entry });
  if (st.killFeed.length > KILLFEED_CAP) st.killFeed.splice(0, st.killFeed.length - KILLFEED_CAP);
}
function normalizeKill(game, v) {
  const o = parseValue(v);
  if (!isObj(o)) return null;
  const e = { attacker: toStr(o.attacker, 40), victim: toStr(o.victim, 40), headshot: toBool(o.headshot), weapon: toStr(o.weapon_type, 30) };
  if (game === 'ow') {
    e.attackerHero = prettyHero(o.attacker_hero_name); e.victimHero = prettyHero(o.victim_hero_name);
    e.attackerTeammate = toBool(o.is_attacker_teammate); e.victimTeammate = toBool(o.is_victim_teammate);
  }
  return e.attacker || e.victim ? e : null;
}

// Ottelun alku/loppu. Palauttavat true, kun tila muuttui (kutsuja ilmoittaa matchStart/matchEnd).
function startMatch(st, now) {
  if (st.active) return false;
  if (!st.hasContext || st.ended) beginContext(st);
  st.active = true; st.ended = false; st.startedAt = now; st.endedAt = 0;
  return true;
}
function endMatch(st, now) {
  if (!st.active) return false;
  st.active = false; st.ended = true; st.endedAt = now;
  return true;
}

// Soveltaa yhden päivityksen tilaan. Palauttaa { changed, started, ended }.
function applyR6(st, u, now) {
  const r = { changed: false, started: false, ended: false };
  const key = u.key;
  const val = parseValue(u.value);
  const m = ROSTER_RE.exec(key);
  if (m) {
    if (val === null || val === undefined) { r.changed = st.roster.delete(key); return r; }
    const p = normalizeR6Player(val, key);
    if (!p) return r;
    touchContext(st);
    st.roster.set(key, mergePlayer(st.roster.get(key), p));
    r.changed = true;
    return r;
  }
  switch (key) {
    case 'phase': {
      st.phase = toStr(val, 30).toLowerCase(); r.changed = true;
      if (st.phase === 'lobby') { r.ended = endMatch(st, now); resetContext(st); st.phase = 'lobby'; }
      return r;
    }
    case 'pseudo_match_id': touchContext(st); st.pseudoMatchId = toStr(val, 80); r.changed = true; return r;
    case 'match_id': touchContext(st); st.matchId = toStr(val, 80); r.changed = true; return r;
    case 'map_id': touchContext(st); st.map = toStr(val, 40); r.changed = true; return r;
    case 'game_mode': {
      touchContext(st);
      const o = parseValue(val);
      st.mode = isObj(o) ? [toStr(o.playlist, 30), toStr(o.mode_name, 30)].filter(Boolean).join(' · ') : toStr(val, 60);
      r.changed = true; return r;
    }
    case 'round_outcome_type': st.roundOutcome = toStr(val, 40); r.changed = true; return r;
    case 'score': {
      if (u.category === 'match' || u.feature === 'match') {
        const o = parseValue(val);
        if (isObj(o)) { st.score = { blue: toNum(o.blue), orange: toNum(o.orange) }; r.changed = true; return r; }
        return r;
      }
      return applyR6Partial(st, 'score', val, r);
    }
    case 'number': {
      if (u.category === 'round' || u.feature === 'match') { st.round = toNum(val); r.changed = true; }
      return r;
    }
    case 'name': if (u.category === 'me' || u.feature === 'me') { st.ownName = toStr(val, 40); r.changed = true; } return r;
    case 'health': case 'kills': case 'deaths': return applyR6Partial(st, key, val, r);
    default: return r;
  }
}
// Pelaajakohtaiset osapäivitykset (health/score/kills/deaths). Jos arvossa on tunniste (player_id / player / roster_XX), se kohdistetaan sille;
// muuten oletetaan, että päivitys koskee paikallista pelaajaa (kategoria "player", ei "players").
function applyR6Partial(st, field, val, r) {
  let target = null;
  let value = val;
  if (isObj(val)) {
    const id = toStr(val.player_id !== undefined ? val.player_id : val.playerId, 80), nm = toStr(val.player !== undefined ? val.player : val.name, 40), slot = toStr(val.slot, 20);
    for (const p of st.roster.values()) if ((id && p.playerId === id) || (slot && p.slot === slot) || (!id && nm && p.name === nm)) { target = p; break; }
    value = val[field] !== undefined ? val[field] : val.value;
  } else {
    for (const p of st.roster.values()) if (p.isLocal) { target = p; break; }
  }
  const n = toNum(value);
  if (!target || n === null) return r;
  if (field === 'health') { target.healthRaw = n; target.health = Math.max(0, Math.min(100, n - 20)); } // GEP lisää terveyteen 20 pisteen kaatotilan
  else target[field] = n;
  r.changed = true;
  return r;
}

function applyOw(st, u, now) {
  const r = { changed: false, started: false, ended: false };
  const key = u.key;
  const val = parseValue(u.value);
  const m = ROSTER_RE.exec(key);
  if (m) {
    if (val === null || val === undefined) { r.changed = st.roster.delete(key); return r; }
    const p = normalizeOwPlayer(val, key);
    if (!p) return r;
    touchContext(st);
    st.roster.set(key, mergePlayer(st.roster.get(key), p));
    r.changed = true;
    return r;
  }
  switch (key) {
    case 'game_state': {
      const s = toStr(val, 40).toLowerCase(); st.phase = s; r.changed = true;
      if (s === 'match_ended') r.ended = endMatch(st, now);
      else if ((s === 'loading_screen_start' || s === 'role_select_screen_start') && !st.active) { beginContext(st); st.phase = s; }
      else if (s === 'match_in_progress' && !st.active && st.hasContext && st.roster.size) r.started = startMatch(st, now);
      return r;
    }
    case 'game_mode': {
      const id = String(parseInt(String(val), 10));
      if (!st.active) touchContext(st);
      st.mode = OW_MODES[id] || toStr(val, 40); r.changed = true; return r;
    }
    case 'battle_tag': {
      const p = ow.parseBattleTag(toStr(val, 60));
      if (p) { st.ownTag = `${p.name}#${p.number}`; r.changed = true; }
      return r;
    }
    case 'game_type': st.gameType = toStr(val, 30); r.changed = true; return r;
    case 'game_queue_type': st.queue = toStr(val, 30); r.changed = true; return r;
    case 'map': { touchContext(st); const id = String(parseInt(String(val), 10)); st.map = OW_MAPS[id] || toStr(val, 40); r.changed = true; return r; }
    case 'pseudo_match_id': touchContext(st); st.pseudoMatchId = toStr(val, 80); r.changed = true; return r;
    case 'match_id': touchContext(st); st.matchId = toStr(val, 80); r.changed = true; return r;
    case 'match_outcome': st.outcome = toStr(val, 20).toLowerCase(); r.changed = true; return r;
    case 'round_outcome': st.roundOutcome = toStr(val, 20).toLowerCase(); r.changed = true; return r;
    default: return r;
  }
}

// Tapahtuma ({ key, value }): ottelun alku/loppu ja tappofeed.
function applyEvent(st, game, key, value, now) {
  const r = { changed: false, started: false, ended: false };
  switch (key) {
    case 'match_start': r.started = startMatch(st, now); r.changed = true; return r;
    case 'match_end': r.ended = endMatch(st, now); r.changed = true; return r;
    case 'kill_feed': { const e = normalizeKill(game, value); if (e) { pushKill(st, e, now); r.changed = true; } return r; }
    case 'matchOutcome': st.outcome = toStr(parseValue(value), 20).toLowerCase(); r.changed = true; return r;
    case 'roundOutcome': st.roundOutcome = toStr(parseValue(value), 20).toLowerCase(); r.changed = true; return r;
    default: return r;
  }
}

// ---- Tilannekuva rendereriä varten --------------------------------------------------------------
function rosterList(st) {
  const arr = Array.from(st.roster.values());
  arr.sort((a, b) => Number(a.slot.slice(7)) - Number(b.slot.slice(7)));
  return arr;
}

// OW-rosteri -> lobbyn BattleTagit. Oma pelaaja pois (palautetaan erikseen), tiimikaverit -> ally, muut -> enemy. Tagittomat pelaajat lasketaan (skipped).
function owLobbyFromRoster(players, ownTag) {
  const list = Array.isArray(players) ? players : [];
  const ownKey = ow.parseBattleTag(ownTag || '') ? ow.parseBattleTag(ownTag).id.toLowerCase() : '';
  const keyOf = (p) => (p.battletag ? ow.parseBattleTag(p.battletag).id.toLowerCase() : '');
  const isOwn = (p) => p.isLocal || (!!ownKey && keyOf(p) === ownKey);
  const local = list.find(isOwn) || null;
  const out = { ally: [], enemy: [], own: local && local.battletag ? local.battletag : (ow.parseBattleTag(ownTag || '') ? ownTag : ''), skipped: 0, players: list.length };
  const seen = new Set();
  for (const p of list) {
    if (isOwn(p)) continue;
    let ally = p.isTeammate;
    if (ally === null || ally === undefined) ally = local && p.team !== null && local.team !== null ? p.team === local.team : false;
    if (!p.battletag) { out.skipped++; continue; }
    const k = `${ally ? 'a' : 'e'}|${keyOf(p)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (ally ? out.ally : out.enemy).push(p.battletag);
  }
  return out;
}

function gameSnapshot(st) {
  const roster = rosterList(st);
  const base = {
    running: st.running, hasContext: st.hasContext, active: st.active, ended: st.ended, live: st.hasContext && !st.ended && roster.length > 0,
    seq: st.seq, key: matchKey(st), phase: st.phase, matchId: st.matchId, pseudoMatchId: st.pseudoMatchId, map: st.map, mode: st.mode,
    round: st.round, outcome: st.outcome, startedAt: st.startedAt, endedAt: st.endedAt, updatedAt: st.updatedAt, ownName: st.ownName, ownTag: st.ownTag,
    roster, killFeed: st.killFeed.slice(-KILLFEED_CAP),
  };
  if (st.game === 'r6') { base.score = { ...st.score }; base.roundOutcome = st.roundOutcome; }
  else { base.gameType = st.gameType; base.queue = st.queue; base.lobby = owLobbyFromRoster(roster, st.ownTag); }
  return base;
}

// ---- Kääre ---------------------------------------------------------------------------------------
const credsInEnv = (env) => !!(env && (env.OW_DEV_KEY || (env.OW_CLI_EMAIL && env.OW_CLI_API_KEY)));

// opts: { app, env, now, setTimeout, clearTimeout }. Tapahtumat: 'change', 'status', 'matchStart' ({ game, key }), 'matchEnd' ({ game, key }), 'log' (merkkijono).
function createGep(opts = {}) {
  const app = opts.app || null;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const bus = new EventEmitter();
  const games = { r6: newGame('r6'), ow: newGame('ow') };
  const raw = []; // viimeisimmät raakaviestit (diagnostiikka, vain muistissa)
  let attached = false;
  let ready = false;
  let version = '';
  // scripts/start.js asettaa tämän, kun ow-electron kaatui käynnistyksessä ja käytetään tavallista Electronia.
  const fallback = env && env.STATSIKKA_OW_FALLBACK ? String(env.STATSIKKA_OW_FALLBACK).slice(0, 80) : '';
  const notAttachedReason = fallback
    ? `Ei käytössä: ow-electron kaatui käynnistyksessä (${fallback}), joten Statsikka käynnistettiin tavallisella Electronilla.`
    : 'Ei käytössä: sovellus ei ole käynnistetty ow-electronilla.';
  let state = 'inactive';
  let reason = notAttachedReason;
  let lastError = '';
  let elevated = false;
  let timer = null;
  let gepApi = null;

  const log = (s) => { try { bus.emit('log', String(s)); } catch (_) { /* ei väliä */ } };
  function setStatus(s, why) {
    if (!STATES.includes(s)) return;
    if (state === s && reason === (why || '')) return;
    state = s; reason = why || '';
    bus.emit('status', status());
  }
  function refreshState() {
    if (!attached) { setStatus('inactive', notAttachedReason); return; }
    if (!ready) {
      if (state === 'error') return;
      setStatus('waiting-credentials', credsInEnv(env) ? 'Odotetaan Overwolfin GEP-pakettia…' : 'Odotetaan tunnuksia: kehittäjäavainta ei ole asetettu, joten GEP ei käynnisty.');
      return;
    }
    if (elevated) { setStatus('ready', 'Peli on ajettu järjestelmänvalvojana: käynnistä Statsikka myös järjestelmänvalvojana, jotta tapahtumat välittyvät.'); return; }
    const running = GAMES.filter((g) => games[g].running);
    if (running.length) setStatus('game-running', `Peli käynnissä: ${running.map((g) => (g === 'r6' ? 'Rainbow Six Siege' : 'Overwatch 2')).join(', ')}.`);
    else setStatus('ready', 'Valmis: odottaa Rainbow Six Siegeä tai Overwatch 2:ta.');
  }
  function status() {
    return { state, reason, version, hasCreds: credsInEnv(env), elevated, lastError, attached, ready };
  }

  function record(game, kind, u) {
    let v = u.value;
    try { v = typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { v = String(v); }
    raw.push({ t: now(), game, kind, feature: u.feature || '', category: u.category || '', key: u.key, value: String(v === undefined ? '' : v).slice(0, 240) });
    if (raw.length > RAW_CAP) raw.splice(0, raw.length - RAW_CAP);
  }

  function notify(game, res) {
    const st = games[game];
    st.updatedAt = now();
    if (res.started) bus.emit('matchStart', { game, key: matchKey(st) });
    if (res.ended) bus.emit('matchEnd', { game, key: matchKey(st) });
    if (res.changed || res.started || res.ended) bus.emit('change');
  }

  // kind: 'info' | 'event'. game: 'r6' | 'ow' | pelin id. msg: GEP:n data-olio. Ei koskaan heitä poikkeusta.
  function feed(gameRef, kind, msg) {
    try {
      const game = GAME_BY_ID[gameRef] || (GAMES.includes(gameRef) ? gameRef : null);
      if (!game) return false;
      const st = games[game];
      const t = now();
      for (const u of flattenUpdate(msg)) {
        record(game, kind, u);
        const res = kind === 'event' ? applyEvent(st, game, u.key, u.value, t) : (game === 'r6' ? applyR6(st, u, t) : applyOw(st, u, t));
        notify(game, res);
      }
      return true;
    } catch (e) {
      log(`GEP-viestin käsittely epäonnistui: ${e && e.message}`);
      return false;
    }
  }
  // Useita tapahtumia yhdessä viestissä: { events: [{ name, data }] } (vanha muoto) tai yksittäinen { key, value }.
  function feedEvent(gameRef, msg) {
    if (isObj(msg) && Array.isArray(msg.events)) {
      let ok = true;
      for (const e of msg.events) if (isObj(e)) ok = feed(gameRef, 'event', { feature: msg.feature, key: e.name, value: e.data }) && ok;
      return ok;
    }
    return feed(gameRef, 'event', msg);
  }

  function seedFromInfo(game, info) {
    try {
      for (const u of flattenInfoSnapshot(info)) {
        record(game, 'seed', u);
        notify(game, game === 'r6' ? applyR6(games[game], u, now()) : applyOw(games[game], u, now()));
      }
    } catch (e) { log(`GEP-tilannekuvan luku epäonnistui: ${e && e.message}`); }
  }

  function gameExit(game) {
    const st = games[game];
    const ended = endMatch(st, now());
    st.running = false;
    resetContext(st);
    notify(game, { changed: true, started: false, ended });
    refreshState();
  }

  function wire(gep) {
    gepApi = gep;
    gep.on('game-detected', (event, gameId) => {
      const game = GAME_BY_ID[gameId];
      if (!game) return; // vain R6 ja OW
      try { event.enable(); } catch (e) { log(`GEP enable epäonnistui: ${e && e.message}`); }
      games[game].running = true;
      refreshState();
      bus.emit('change');
      Promise.resolve().then(() => gep.setRequiredFeatures(gameId, null)).then(() => gep.getInfo(gameId)).then((info) => seedFromInfo(game, info)).catch((e) => {
        lastError = `GEP: ${e && e.message ? e.message : e}`;
        log(lastError);
        bus.emit('status', status());
      });
    });
    gep.on('new-info-update', (_e, gameId, data) => feed(gameId, 'info', data));
    gep.on('new-game-event', (_e, gameId, data) => feedEvent(gameId, data));
    gep.on('game-exit', (_e, gameId) => { const g = GAME_BY_ID[gameId]; if (g) gameExit(g); });
    gep.on('elevated-privileges-required', (_e, gameId) => {
      if (!GAME_BY_ID[gameId]) return;
      elevated = true; refreshState();
    });
    gep.on('error', (_e, _gameId, error) => {
      lastError = `GEP-virhe: ${typeof error === 'string' ? error : (error && error.message) || 'tuntematon'}`;
      log(lastError);
      bus.emit('status', status());
    });
  }

  // Kutsutaan heti moduulin latauksessa (ennen app.ready): rekisteröi pakettienhallinnan tapahtumat ja poistaa Overwolfin anonyymin analytiikan.
  function attach() {
    if (attached) return true;
    const owApi = app && app.overwolf;
    if (!owApi || !owApi.packages || typeof owApi.packages.on !== 'function') { refreshState(); return false; }
    attached = true;
    try { if (typeof owApi.disableAnonymousAnalytics === 'function') owApi.disableAnonymousAnalytics(); } catch (e) { log(`Analytiikan esto epäonnistui: ${e && e.message}`); }
    try {
      owApi.packages.on('ready', (_e, name, ver) => {
        if (name !== 'gep') return;
        ready = true; version = String(ver || '');
        if (timer) { clearT(timer); timer = null; }
        lastError = '';
        try { wire(owApi.packages.gep); } catch (e) { ready = false; lastError = `GEP-pakettia ei voitu ottaa käyttöön: ${e && e.message}`; setStatus('error', lastError); return; }
        state = 'inactive'; // pakottaa tilan päivityksen
        refreshState();
        bus.emit('change');
      });
      owApi.packages.on('failed-to-initialize', (_e, name) => {
        if (name !== 'gep') return;
        lastError = 'GEP-paketin käynnistys epäonnistui (tunnus virheellinen tai vanhentunut, tai ei verkkoyhteyttä).';
        setStatus('error', lastError);
      });
      owApi.packages.on('crashed', (_e, canRecover) => {
        lastError = `Overwolf-paketti kaatui${canRecover ? ' (yritetään palautua)' : ''}.`;
        setStatus('error', lastError);
      });
    } catch (e) {
      lastError = `Overwolf-pakettien kuuntelu epäonnistui: ${e && e.message}`;
      setStatus('error', lastError);
      return false;
    }
    refreshState();
    // Ilman kelvollista tunnusta paketti ei koskaan käynnisty: kerrotaan selvästi, jos tunnus on asetettu mutta paketti ei ala vastata.
    if (credsInEnv(env)) {
      timer = setT(() => {
        timer = null;
        if (!ready) { lastError = 'GEP-paketti ei käynnistynyt 90 sekunnissa: tarkista tunnukset ja verkkoyhteys.'; setStatus('error', lastError); }
      }, READY_TIMEOUT_MS);
      if (timer && timer.unref) timer.unref();
    }
    return true;
  }

  function snapshot() {
    return { status: status(), r6: gameSnapshot(games.r6), ow: gameSnapshot(games.ow) };
  }
  // Savutestille: palauttaa kaiken alkutilaan (tila ja tunnetut pelit), ei kosketa pakettien tilaan.
  function reset(game) {
    for (const g of game ? [game] : GAMES) { const ended = endMatch(games[g], now()); resetContext(games[g]); games[g].running = false; games[g].ownTag = ''; games[g].ownName = ''; notify(g, { changed: true, ended }); }
    refreshState();
  }
  function markRunning(game, running) { games[game].running = !!running; refreshState(); bus.emit('change'); }

  return {
    attach, feed, feedEvent, snapshot, status, reset, markRunning, seedFromInfo,
    isLive: (game) => !!games[game] && games[game].hasContext && !games[game].ended,
    isActive: (game) => !!games[game] && games[game].active,
    diag: () => raw.slice(),
    on: (ev, fn) => bus.on(ev, fn),
    off: (ev, fn) => bus.off(ev, fn),
    api: () => gepApi,
  };
}

module.exports = {
  GAME_IDS, GAME_BY_ID, GAMES, STATES, KILLFEED_CAP, createGep, credsInEnv,
  parseValue, toNum, flattenUpdate, flattenInfoSnapshot, normalizeR6Player, normalizeOwPlayer, mergePlayer, prettyOperator, prettyHero, owLobbyFromRoster,
  newGame, applyR6, applyOw, applyEvent, gameSnapshot, startMatch, endMatch, OW_MAPS,
};
