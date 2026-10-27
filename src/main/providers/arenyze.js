'use strict';
// Arenyze (r6.arenyze.com) kehittäjärajapinta: minkä tahansa R6-pelaajan rank, rank-pisteet, kausitilastot ja rank-pisteiden historia nimellä + alustalla.
// Käyttäjän oma API-avain (ilmainen tili: 2 000 kutsua / kk). Rajapinta: https://public-api.arenyze.com/r6/api (V2: /v2/profile, /v2/fullstats, /v2/operators, /me/usage).
// Ei Electron-riippuvuuksia (safeStorage, fetch ja kello annetaan sisään) -> testattavissa node:lla. Avainta ei kirjata lokiin eikä lähetetä muualle kuin Arenyzelle.
// Kutsubudjetti: kaikki vastaukset välimuistiin levylle (arenyze-cache.json), kutsut yhdistetään, kuukausilaskuri (UTC-kuukausi) ja pehmeä raja automaattisille hauille.
// Tracker.gg-tyyppistä ottelukohtaista historiaa muille pelaajille ei ole tässä rajapinnassa, eikä sitä haeta mistään muualta.
const fs = require('fs');
const path = require('path');
const { readJson, writeFileAtomic, writeJsonAtomic } = require('../store');
const { createHttp, ApiError } = require('../http');
const susp = require('../suspicion');

const BASE = 'https://public-api.arenyze.com/r6/api';
const SITE_URL = 'https://r6.arenyze.com/';
const KEY_FILE = 'arenyze-key.bin';
const CACHE_FILE = 'arenyze-cache.json';
const NORM_VERSION = 1;                                   // vaihda, kun normalisoitu muoto muuttuu (vanha välimuisti hylätään)
const HOUR = 3600 * 1000;
const TTL = Object.freeze({ summary: 6 * HOUR, profile: 6 * HOUR, operators: 24 * HOUR });
const DEFAULT_SOFT_LIMIT = 1800;                          // automaattiset haut loppuvat tähän (ilmaisen tilin raja 2 000 / kk)
const MANUAL_MIN_MS = 30 * 1000;                          // "Päivitä" ei hae uudelleen alle 30 s vanhaa tulosta
const FAIL_MS = 5 * 60 * 1000;                            // epäonnistunutta automaattihakua ei toisteta 5 min sisällä (NOT_FOUND: 30 min)
const FAIL_NOT_FOUND_MS = 30 * 60 * 1000;
const CACHE_CAP = 600;
const PLATFORMS = Object.freeze(['uplay', 'psn', 'xbl']);
const KINDS = Object.freeze(['summary', 'profile', 'operators']);
const MODES = Object.freeze(['view', 'user', 'refresh']);
const KEY_RE = /^[\x21-\x7e]{8,256}$/;                    // tulostettavaa ASCII:ta, ei välilyöntejä (ei otsakkeen rivinvaihtoja)
const ROSTER_MAX = 12;

// ---- Pienet apurit --------------------------------------------------------------------------------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
// Luku tai null; hyväksyy myös { value } -muodon (tracker-tyyppiset tilastot).
function n(v) {
  if (isObj(v) && 'value' in v) v = v.value;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(x) ? x : null;
}
function firstN(...vals) { for (const v of vals) { const x = n(v); if (x !== null) return x; } return null; }
const str = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const monthKey = (t) => new Date(t).toISOString().slice(0, 7);

// ---- Rank ------------------------------------------------------------------------------------------
// Rank 2.0 -taulukko: Copper V alkaa 1 000 RP:stä, jokainen divisioona (V..I) on 100 RP ja arvo (Copper..Diamond) 500 RP; Champion alkaa 4 500 RP:stä.
// (Dokumentaation esimerkki: 3 300 RP = Platinum II.) Rank-pisteiden historian vastauksessa oleva nimi on aina ensisijainen, tämä on varalaskenta.
const TIERS = Object.freeze(['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond']);
const DIVISIONS = Object.freeze(['I', 'II', 'III', 'IV', 'V']);
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
function rankFromPoints(rp) {
  const p = n(rp);
  if (p === null || p <= 0) return null;
  if (p >= 4500) return { tier: 'Champion', division: null, name: 'Champion' };
  const idx = Math.max(0, Math.floor((p - 1000) / 100));
  const tier = TIERS[Math.min(TIERS.length - 1, Math.floor(idx / 5))];
  const division = DIVISIONS[4 - (idx % 5)];
  return { tier, division, name: `${tier} ${division}` };
}
// "PLATINUM II" / "Champions" / "Gold 3" -> { tier, division, name } tai null.
function parseRankName(s) {
  const m = /^\s*(copper|bronze|silver|gold|platinum|emerald|diamond|champions?)\b\s*(i{1,3}|iv|v|[1-5])?\s*$/i.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const t = m[1].toLowerCase();
  const tier = t.startsWith('champion') ? 'Champion' : t[0].toUpperCase() + t.slice(1);
  if (tier === 'Champion') return { tier, division: null, name: 'Champion' };
  let division = null;
  if (m[2]) division = /^\d$/.test(m[2]) ? ROMAN[Number(m[2])] : m[2].toUpperCase();
  return { tier, division, name: division ? `${tier} ${division}` : tier };
}

// ---- Normalisointi (kaikki puuttuva -> null, ei koskaan heitä) ---------------------------------------------
// Valitsee nykyisen laudan: pelilistan "ranked", muuten ensimmäinen; sen uusin kausi (suurin season_id).
function pickBoard(stats) {
  let best = null;
  for (const fam of arr(isObj(stats) ? stats.platform_families_full_profiles : null)) {
    if (!isObj(fam)) continue;
    for (const b of arr(fam.board_ids_full_profiles)) {
      if (!isObj(b)) continue;
      const boardId = str(b.board_id, 24).toLowerCase();
      for (const fp of arr(b.full_profiles)) {
        if (!isObj(fp)) continue;
        const cand = { fp, boardId, ranked: boardId === 'ranked', sid: firstN(fp.season_id) ?? -1, profileId: str(fam.profile_id, 80) };
        if (!best || (cand.ranked && !best.ranked) || (cand.ranked === best.ranked && cand.sid > best.sid)) best = cand;
      }
    }
  }
  if (!best) return null;
  const p = isObj(best.fp.profile) ? best.fp.profile : {};
  const ss = isObj(best.fp.season_statistics) ? best.fp.season_statistics : {};
  const mo = isObj(ss.match_outcomes) ? ss.match_outcomes : {};
  return {
    boardId: best.boardId, seasonId: best.sid >= 0 ? best.sid : null, profileId: best.profileId,
    rank: firstN(p.rank), rankPoints: firstN(p.rank_points, p.rankPoints), maxRank: firstN(p.max_rank), maxRankPoints: firstN(p.max_rank_points, p.maxRankPoints),
    kills: firstN(p.kills, ss.kills), deaths: firstN(p.deaths, ss.deaths),
    wins: firstN(p.wins, mo.wins, mo.win_count), losses: firstN(p.losses, mo.losses, mo.loss_count), abandons: firstN(p.abandon, p.abandons, mo.abandons, mo.abandon_count),
  };
}
// data.segments -> kausirivit (uusin viimeisenä).
function parseSegments(data) {
  const out = [];
  for (const s of arr(isObj(data) ? data.segments : null)) {
    if (!isObj(s)) continue;
    const a = isObj(s.attributes) ? s.attributes : {}, md = isObj(s.metadata) ? s.metadata : {}, st = isObj(s.stats) ? s.stats : {};
    const type = str(s.type, 20).toLowerCase();
    if (type && type !== 'season') continue;
    const session = str(a.sessionType || md.rankType, 20).toLowerCase();
    const ranked = session === 'ranked' || str(a.gamemode, 20).toLowerCase() === 'pvp_ranked';
    const kills = firstN(st.kills);
    const kd = firstN(st.kdRatio, st.kd);
    const matches = firstN(st.matchesPlayed);
    const won = firstN(st.matchesWon, st.wins);
    out.push({
      code: str(md.shortName || md.name, 12) || null, number: firstN(a.season), ranked,
      rankPoints: firstN(st.rankPoints), kd, kills, matches, hsPercent: firstN(st.headshotPct, st.headshotPercentage),
      winrate: firstN(st.winPercentage, st.matchWinPercent) ?? (won !== null && matches ? r1((won / matches) * 100) : null),
    });
  }
  out.sort((x, y) => (x.number ?? 0) - (y.number ?? 0));
  return out.slice(-40);
}
function parseOperators(list) {
  const src = isObj(list) ? list.operators : list;
  const out = [];
  for (const o of arr(src)) {
    if (!isObj(o)) continue;
    const name = str(o.operator || o.name, 40);
    if (!name) continue;
    out.push({
      name, side: str(o.side, 12) || null, rounds: firstN(o.roundsPlayed), kd: firstN(o.kd), kills: firstN(o.kills), deaths: firstN(o.deaths),
      headshots: firstN(o.headshots), hsPercent: firstN(o.headshotPercent), winPercent: firstN(o.winPercent),
    });
  }
  out.sort((x, y) => (y.rounds ?? 0) - (x.rounds ?? 0));
  return out.slice(0, 30);
}
// HS-% operaattoririveistä: päälaukaukset / tapot, muuten tapoilla painotettu keskiarvo; ei tietoa -> null.
function hsFromOperators(ops) {
  let hs = 0, kills = 0, any = false, wsum = 0, wk = 0;
  for (const o of ops) {
    if (o.headshots !== null && o.kills !== null) { hs += o.headshots; kills += o.kills; any = true; }
    else if (o.hsPercent !== null && o.kills !== null && o.kills > 0) { wsum += o.hsPercent * o.kills; wk += o.kills; }
  }
  if (any && kills > 0) return r1((hs / kills) * 100);
  if (wk > 0) return r1(wsum / wk);
  return null;
}
function rankFields(prefix, rank, points, nameOverride) {
  const info = (nameOverride && parseRankName(nameOverride)) || rankFromPoints(points);
  const P = (k) => (prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k);
  return { [P('rank')]: rank, [P('rankPoints')]: points, [P('rankName')]: info ? info.name : null, [P('rankTier')]: info ? info.tier : null };
}

// /v2/fullstats -> yhteenveto (nykyinen ranked-kausi + operaattorit + kaudet). Palauttaa aina olion; hasData=false, jos pelaajalla ei ole rankattuja tietoja.
function normalizeFullStats(raw, ctx = {}) {
  const root = isObj(raw) ? raw : {};
  const fsr = isObj(root.fullStats) ? root.fullStats : root;
  const board = pickBoard(fsr) || pickBoard(root.stats);
  const data = isObj(fsr.data) ? fsr.data : {};
  const seasons = parseSegments(data);
  const seg = seasons.filter((s) => s.ranked || s.rankPoints !== null).pop() || null;
  const operators = parseOperators(fsr.operators);
  const md = isObj(data.metadata) ? data.metadata : {};
  const pl = isObj(root.player) ? root.player : {};
  const kills = board && board.kills !== null ? board.kills : (seg ? seg.kills : null);
  let deaths = board && board.deaths !== null ? board.deaths : null;
  let kd = null;
  if (kills !== null && deaths !== null && deaths > 0) kd = r2(kills / deaths);
  else if (seg && seg.kd !== null) { kd = seg.kd; if (deaths === null && kills !== null && kd > 0) deaths = Math.round(kills / kd); }
  const wins = board ? board.wins : null, losses = board ? board.losses : null, abandons = board ? board.abandons : null;
  const decided = wins !== null && losses !== null ? wins + losses : null;
  const matches = wins !== null && losses !== null ? wins + losses + (abandons || 0) : (seg ? seg.matches : null);
  const winrate = decided ? r1((wins / decided) * 100) : (seg ? seg.winrate : null);
  const points = board && board.rankPoints !== null ? board.rankPoints : (seg ? seg.rankPoints : null);
  const hours = isObj(fsr.totalsHoursPlayed) ? firstN(fsr.totalsHoursPlayed.hours) : null;
  return {
    v: NORM_VERSION, name: str(pl.nameOnPlatform, 40) || str(ctx.name, 40) || null, platform: PLATFORMS.includes(pl.platformType) ? pl.platformType : (ctx.platform || 'uplay'),
    seasonNumber: firstN(fsr.seasonNumber, board && board.seasonId, seg && seg.number), seasonCode: str(fsr.seasonYear, 12) || (seg && seg.code) || null,
    hasData: !!(board || seg), level: firstN(md.clearanceLevel, fsr.account && fsr.account.level), hoursPlayed: hours,
    ...rankFields('', board ? board.rank : null, points),
    ...rankFields('max', board ? board.maxRank : null, board ? board.maxRankPoints : null),
    kills, deaths, kd, wins, losses, abandons, matches, winrate, hsPercent: hsFromOperators(operators) ?? (seg ? firstN(seg.hsPercent) : null),
    operators: operators.slice(0, 8), seasons: seasons.slice(-12),
  };
}

// rank-pisteiden historia: [[aikaleima, { value, metadata:{ rank } }], ...] eri kääreissä -> [{ ts, rp, rank }] vanhimmasta uusimpaan.
function parseHistory(h) {
  let list = null;
  if (isObj(h)) {
    const d = h.data;
    list = (isObj(d) && isObj(d.history) && d.history.data) || (isObj(h.history) && h.history.data) || (Array.isArray(d) ? d : null);
  } else if (Array.isArray(h)) list = h;
  const out = [];
  for (const e of arr(list)) {
    let ts = null, o = null;
    if (Array.isArray(e)) { ts = e[0]; o = e[1]; } else if (isObj(e)) { ts = e.timestamp || e.ts || e.date; o = e; }
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    const rp = isObj(o) ? firstN(o.value, o.rankPoints) : null;
    if (!Number.isFinite(t) || rp === null) continue;
    out.push({ ts: t, rp, rank: isObj(o) && isObj(o.metadata) ? str(o.metadata.rank, 24) || null : null });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-500);
}
// /v2/profile -> tili (taso, porttikielto), rank-pisteiden historia, kaudet ja laudan tila.
function normalizeProfile(raw, ctx = {}) {
  const root = isObj(raw) ? raw : {};
  const pl = isObj(root.player) ? root.player : {};
  const acc = isObj(root.account) ? root.account : {};
  const ban = isObj(root.banned) ? root.banned : null;
  const board = pickBoard(root.stats);
  const history = parseHistory(root.history);
  const last = history.length ? history[history.length - 1] : null;
  const seasonsData = isObj(root.seasons) ? (isObj(root.seasons.data) ? root.seasons.data : root.seasons) : null;
  // Historian viimeisen pisteen rank-nimi kelpaa vain, jos sen RP vastaa nykyistä lautaa (muuten historia on vanhemmalta kaudelta).
  const histName = last && (!board || board.rankPoints === null || board.rankPoints === last.rp) ? last.rank : null;
  return {
    v: NORM_VERSION, name: str(pl.nameOnPlatform, 40) || str(ctx.name, 40) || null, platform: PLATFORMS.includes(pl.platformType) ? pl.platformType : (ctx.platform || 'uplay'),
    level: firstN(acc.level), banned: ban ? { isBanned: ban.isBanned === true, alerts: arr(ban.banAlerts).length } : null,
    ...rankFields('', board ? board.rank : null, board ? board.rankPoints : (last ? last.rp : null), histName),
    history, seasons: parseSegments(seasonsData).slice(-12),
  };
}
function normalizeOperators(raw) {
  const root = isObj(raw) ? raw : {};
  const o = isObj(root.operators) ? root.operators : root;
  return { v: NORM_VERSION, seasonCode: str(o.seasonYear, 12) || null, sessionType: str(o.sessionType, 12) || null, operators: parseOperators(Array.isArray(raw) ? raw : o).slice(0, 20) };
}
function normalizeUsage(raw) {
  const root = isObj(raw) ? raw : {};
  const u = isObj(root.usage) ? root.usage : {};
  return { plan: str(root.plan, 24) || null, limit: firstN(root.limit), totalCalls: firstN(u.total_calls), statsCalls: firstN(u.stats_calls), lastSeenAt: str(u.last_seen_at, 40) || null };
}

// ---- Epätavallisten tilastojen arvio (suspicion.evaluateR6) ---------------------------------------------------
function toR6Input(s) {
  if (!s) return null;
  return { kd: s.kd, hsPercent: s.hsPercent, winrate: s.winrate, matches: s.matches, kills: s.kills, killsPerRound: null, level: s.level, rank: s.rankTier && susp.R6_RANKS.includes(s.rankTier) ? s.rankTier : null };
}
// sensitivity annettuna: 'off' -> null; muuten pisteet -> taso. source 'arenyze' valitsee huomautustekstin.
function evaluate(s, sensitivity) {
  if (!s || !s.hasData) return null;
  const r = { ...susp.evaluateR6(toR6Input(s)), source: 'arenyze' };
  return sensitivity === undefined ? r : susp.withSensitivity(r, sensitivity);
}
// Pelaajan tarkistus -lomakkeen kentät (merkkijonoja) yhteenvedosta.
function toCheckForm(s) {
  const f = (x, d) => (x === null || x === undefined ? '' : String(d === undefined ? x : Math.round(x * 10 ** d) / 10 ** d));
  return { kd: f(s && s.kd, 2), hsPercent: f(s && s.hsPercent, 1), winrate: f(s && s.winrate, 1), matches: f(s && s.matches), kills: f(s && s.kills), killsPerRound: '', level: f(s && s.level), rank: s && s.rankTier && susp.R6_RANKS.includes(s.rankTier) ? s.rankTier : '' };
}
// Live-rivin tiivis muoto (ei operaattoreita eikä kausilistoja).
function compact(s, sensitivity) {
  if (!s) return null;
  return {
    hasData: s.hasData, rankName: s.rankName, rankTier: s.rankTier, rankPoints: s.rankPoints, maxRankName: s.maxRankName, kd: s.kd, wins: s.wins, losses: s.losses, winrate: s.winrate,
    matches: s.matches, hsPercent: s.hsPercent, level: s.level, seasonCode: s.seasonCode, suspicion: evaluate(s, sensitivity),
  };
}

// ---- Validointi (IPC) --------------------------------------------------------------------------------------
function bad(msg) { return new ApiError('BAD_INPUT', msg); }
function validateName(name) {
  if (typeof name !== 'string') throw bad('Pelaajan nimi puuttuu.');
  const v = name.trim();
  if (!v || v.length > 40) throw bad('Pelaajan nimen pituus on 1–40 merkkiä.');
  if (/[\u0000-\u001f\u007f]/.test(v)) throw bad('Pelaajan nimessä on kiellettyjä merkkejä.');
  return v;
}
function validateKey(key) {
  const v = typeof key === 'string' ? key.trim() : '';
  if (!KEY_RE.test(v)) throw bad('API-avain puuttuu tai on virheellinen (8–256 merkkiä, ei välilyöntejä).');
  return v;
}
function onlyKeys(arg, allowed) { for (const k of Object.keys(arg)) if (!allowed.includes(k)) throw bad(`Tuntematon kenttä: ${k}.`); }
function validateLookupArg(arg) {
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  onlyKeys(arg, ['name', 'platform', 'kind', 'mode']);
  const platform = arg.platform === undefined ? 'uplay' : arg.platform;
  if (!PLATFORMS.includes(platform)) throw bad('Virheellinen alusta (uplay, psn tai xbl).');
  const kind = arg.kind === undefined ? 'summary' : arg.kind;
  if (!KINDS.includes(kind)) throw bad('Virheellinen hakutyyppi.');
  const mode = arg.mode === undefined ? 'view' : arg.mode;
  if (!MODES.includes(mode)) throw bad('Virheellinen hakutila.');
  return { name: validateName(arg.name), platform, kind, mode };
}
function validateKeyArg(arg) {
  if (arg === undefined || arg === null) return null;
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  onlyKeys(arg, ['key']);
  return validateKey(arg.key);
}

// ---- Salattu avainvarasto (kuten Overwolf-tunnukset: safeStorage, ei koskaan selkotekstinä levylle) ----------------------
function createKeyStore({ dir, safeStorage }) {
  const file = path.join(dir, KEY_FILE);
  const available = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable() === true; } catch (_) { return false; } };
  return {
    file, available, has: () => fs.existsSync(file),
    save(key) {
      if (!available()) throw new Error('Salausta ei ole saatavilla tässä käyttöympäristössä (Windows DPAPI / safeStorage), joten avainta ei tallenneta.');
      writeFileAtomic(file, safeStorage.encryptString(JSON.stringify({ key: validateKey(key) })));
      return true;
    },
    load() {
      if (!available()) return null;
      try { const o = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); return isObj(o) && KEY_RE.test(o.key) ? o.key : null; } catch (_) { return null; }
    },
    clear() { try { fs.unlinkSync(file); return true; } catch (e) { return !!e && e.code === 'ENOENT'; } },
  };
}

// ---- Välimuisti ja kuukausilaskuri (arenyze-cache.json) --------------------------------------------------------------
function createCacheStore({ dir, now, saveDelayMs = 500 }) {
  const file = path.join(dir, CACHE_FILE);
  let data = { version: NORM_VERSION, entries: {}, usage: { month: monthKey(now()), calls: 0 }, server: null };
  const raw = readJson(file, null);
  if (isObj(raw) && raw.version === NORM_VERSION) {
    if (isObj(raw.entries)) for (const [k, e] of Object.entries(raw.entries)) if (isObj(e) && Number.isFinite(e.at) && isObj(e.data) && KINDS.includes(e.kind)) data.entries[k] = { at: e.at, kind: e.kind, data: e.data };
  }
  if (isObj(raw) && isObj(raw.usage) && typeof raw.usage.month === 'string') data.usage = { month: raw.usage.month, calls: Math.max(0, Math.floor(Number(raw.usage.calls) || 0)) };
  if (isObj(raw) && isObj(raw.server) && Number.isFinite(raw.server.at)) data.server = raw.server;
  let timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    const keys = Object.keys(data.entries);
    if (keys.length > CACHE_CAP) for (const k of keys.sort((a, b) => data.entries[a].at - data.entries[b].at).slice(0, keys.length - CACHE_CAP)) delete data.entries[k];
    try { writeJsonAtomic(file, data); } catch (_) { /* levy täynnä tms.: muistissa oleva tila riittää */ }
  };
  const saveSoon = () => { if (timer) return; timer = setTimeout(flush, saveDelayMs); if (timer.unref) timer.unref(); };
  const roll = () => { const m = monthKey(now()); if (data.usage.month !== m) { data.usage = { month: m, calls: 0 }; data.server = null; } };
  return {
    file, flush,
    get(k) { return data.entries[k] || null; },
    put(k, kind, value) { data.entries[k] = { at: now(), kind, data: value }; saveSoon(); },
    clearEntries() { data.entries = {}; saveSoon(); },
    bump() { roll(); data.usage.calls++; saveSoon(); },
    usage() { roll(); return { month: data.usage.month, calls: data.usage.calls }; },
    server() { roll(); return data.server; },
    setServer(s) { roll(); data.server = s; saveSoon(); },
    size: () => Object.keys(data.entries).length,
  };
}

// ---- Rosterin hakulista (puhdas funktio) -------------------------------------------------------------------------
// roster: [{ name, isOwn?, anonymous? }]. Tulos: { lookups: [nimi], skipped: [{ name, reason }] }.
// Ohitetaan: tyhjä/anonyymi nimi, kaksoiskappaleet, tuore välimuisti (myös oma), käynnissä oleva haku, äskettäin epäonnistunut haku, budjetin ylittävät.
// Järjestys: muut pelaajat ensin, oma viimeisenä. remaining = montako kutsua budjetista on jäljellä.
function planRoster(roster, opts = {}) {
  const isFresh = opts.isFresh || (() => false), isPending = opts.isPending || (() => false), failed = opts.failed || (() => false);
  let budget = Number.isFinite(opts.remaining) ? Math.max(0, Math.floor(opts.remaining)) : Infinity;
  const seen = new Set(), skipped = [], others = [], own = [];
  for (const p of arr(roster).slice(0, ROSTER_MAX)) {
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || p.anonymous) { skipped.push({ name, reason: 'anon' }); continue; }
    const k = name.toLowerCase();
    if (seen.has(k)) { skipped.push({ name, reason: 'dup' }); continue; }
    seen.add(k);
    (p.isOwn ? own : others).push(name);
  }
  const lookups = [];
  for (const name of [...others, ...own]) {
    if (isFresh(name)) skipped.push({ name, reason: 'cached' });
    else if (isPending(name)) skipped.push({ name, reason: 'pending' });
    else if (failed(name)) skipped.push({ name, reason: 'failed' });
    else if (budget <= 0) skipped.push({ name, reason: 'budget' });
    else { lookups.push(name); budget--; }
  }
  return { lookups, skipped };
}

// ---- Asiakas ----------------------------------------------------------------------------------------------------------
// deps: { dir, safeStorage, getSettings() -> { arenyzeAuto, arenyzeSoftLimit, suspicionSensitivity }, fetchImpl?, now?, sleep?, timeoutMs?, onUpdate?, onNotice?, saveDelayMs? }
function createArenyze(deps) {
  const now = deps.now || Date.now;
  const getSettings = deps.getSettings || (() => ({}));
  const keys = createKeyStore({ dir: deps.dir, safeStorage: deps.safeStorage });
  const store = createCacheStore({ dir: deps.dir, now, saveDelayMs: deps.saveDelayMs });
  const realFetch = deps.fetchImpl || ((...a) => fetch(...a));
  // Jokainen todellinen HTTP-yritys (myös 429-uusinta) lasketaan kuukausilaskuriin ennen lähetystä.
  const http = createHttp({
    fetchImpl: (url, init) => { store.bump(); return realFetch(url, init); },
    concurrency: 2, ttlMs: 0, timeoutMs: deps.timeoutMs ?? 20000, maxRetryWaitMs: 20000, sleep: deps.sleep, now, onNotice: deps.onNotice,
  });
  const inflight = new Map();   // välimuistiavain -> Promise
  const failures = new Map();   // välimuistiavain -> { until, error }
  let rateLimitedUntil = 0;
  const lastSigs = new Map();    // rosterilähde (gep / replay) -> viimeksi suunniteltu pelaajajoukko
  let lastTest = null;
  let keyMem;                   // undefined = ei vielä luettu
  let updTimer = null;

  const loadKey = () => { if (keyMem === undefined) keyMem = keys.load(); return keyMem; };
  const configured = () => !!loadKey();
  const notify = () => {
    if (updTimer || !deps.onUpdate) return;
    updTimer = setTimeout(() => { updTimer = null; try { deps.onUpdate(); } catch (_) { /* ei väliä */ } }, 150);
    if (updTimer.unref) updTimer.unref();
  };
  const softLimit = () => { const v = Number(getSettings().arenyzeSoftLimit); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SOFT_LIMIT; };
  const autoOn = () => getSettings().arenyzeAuto !== false;
  const sens = () => getSettings().suspicionSensitivity;
  const cacheKey = (kind, platform, name) => `${kind}|${platform}|${name.toLowerCase()}`;

  // Arvio tämän kuukauden käytöstä: paikallinen laskuri tai palvelimen viimeksi ilmoittama luku + sen jälkeiset omat kutsut (suurempi näistä).
  function usedEstimate() {
    const local = store.usage().calls;
    const sv = store.server();
    if (sv && Number.isFinite(sv.totalCalls)) return Math.max(local, sv.totalCalls + Math.max(0, local - (sv.localAt || 0)));
    return local;
  }
  function usageInfo() {
    const u = store.usage(), used = usedEstimate(), lim = softLimit();
    return { month: u.month, calls: u.calls, used, softLimit: lim, remaining: Math.max(0, lim - used), inflight: inflight.size };
  }

  async function api(pathname, params, keyOverride) {
    const key = keyOverride || loadKey();
    if (!key) throw new ApiError('NO_KEY', 'Arenyze-avainta ei ole asetettu. Lisää se Asetuksissa (R6-tilastot).');
    const qs = new URLSearchParams(params || {}).toString();
    try {
      const j = await http.getJson(`${BASE}${pathname}${qs ? `?${qs}` : ''}`, { headers: { 'api-key': key }, noCache: true });
      if (isObj(j) && typeof j.error === 'string' && !j.fullStats && !j.stats && !j.plan) throw new ApiError('HTTP_ERROR', `Arenyze: ${j.error.slice(0, 160)}`);
      return j;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 401 || e.status === 403) throw new ApiError('AUTH', 'Arenyze hylkäsi avaimen (virhe ' + e.status + '). Tarkista avain ja kuukausikiintiö.', { status: e.status });
      if (e.code === 'NOT_FOUND') throw new ApiError('NOT_FOUND', 'Pelaajaa ei löytynyt Arenyzestä. Tarkista nimi ja alusta.', { status: 404 });
      if (e.code === 'RATE_LIMIT') rateLimitedUntil = now() + Math.max(1, e.retryAfter || 5) * 1000;
      throw e;
    }
  }

  function gate(origin) {
    if (origin === 'auto' && !autoOn()) return { ok: false, code: 'AUTO_OFF', message: 'Automaattinen haku on pois päältä.' };
    if (rateLimitedUntil > now()) return { ok: false, code: 'RATE_LIMIT', message: `Arenyze rajoitti pyyntöjä. Yritä uudelleen noin ${Math.ceil((rateLimitedUntil - now()) / 1000)} s kuluttua.` };
    if (usedEstimate() + inflight.size >= softLimit()) return { ok: false, code: 'BUDGET', message: `Kuukauden pehmeä raja (${softLimit()} kutsua) on täynnä, joten automaattiset haut on pysäytetty. Päivitä-painike hakee silti.` };
    return { ok: true };
  }
  const PATHS = {
    summary: (name, platform) => ['/v2/fullstats', { nameOnPlatform: name, platformType: platform, modes: 'ranked' }],
    profile: (name, platform) => ['/v2/profile', { nameOnPlatform: name, platformType: platform }],
    operators: (name, platform) => ['/v2/operators', { nameOnPlatform: name, platformType: platform, modes: 'ranked' }],
  };
  const NORMALIZE = { summary: normalizeFullStats, profile: normalizeProfile, operators: normalizeOperators };
  const view = (kind, entry, extra) => {
    const t = now();
    const out = { kind, data: entry.data, fetchedAt: entry.at, ageMs: Math.max(0, t - entry.at), stale: t - entry.at >= TTL[kind], cached: true, error: null, note: '', ...extra };
    if (kind === 'summary') out.suspicion = evaluate(entry.data, sens());
    return out;
  };

  // origin: 'auto' (rosterin taustahaku) | 'view' (paneeli / oma profiili avautuu) | 'user' (käyttäjän painike). auto ja view noudattavat pehmeää rajaa; user ei.
  // force: ohita TTL (vähintään 30 s vanhasta). Virhetilanteessa palautetaan vanha välimuistidata (stale) virheilmoituksen kanssa.
  async function lookup(kind, nameIn, platform, opts = {}) {
    if (!KINDS.includes(kind)) throw bad('Virheellinen hakutyyppi.');
    if (!PLATFORMS.includes(platform)) throw bad('Virheellinen alusta.');
    const name = validateName(nameIn);
    const origin = opts.origin || 'view', ck = cacheKey(kind, platform, name), t = now();
    const hit = store.get(ck);
    if (hit && t - hit.at < TTL[kind] && !(opts.force && t - hit.at >= MANUAL_MIN_MS)) return view(kind, hit);
    if (!configured()) {
      if (hit) return view(kind, hit, { note: 'Avainta ei ole asetettu: näytetään tallennettu tulos.' });
      throw new ApiError('NO_KEY', 'Arenyze-avainta ei ole asetettu. Lisää se Asetuksissa (R6-tilastot).');
    }
    if (origin !== 'user') {
      const g = gate(origin);
      const f = failures.get(ck);
      const block = !g.ok ? new ApiError(g.code, g.message) : (f && f.until > t ? f.error : null);
      if (block) { if (hit) return view(kind, hit, { note: block.message }); throw block; }
    }
    if (inflight.has(ck)) return inflight.get(ck);
    const p = (async () => {
      try {
        const [pth, q] = PATHS[kind](name, platform);
        const data = NORMALIZE[kind](await api(pth, q), { name, platform });
        store.put(ck, kind, data);
        failures.delete(ck);
        return view(kind, { at: now(), data }, { cached: false });
      } catch (e) {
        const ae = e instanceof ApiError ? e : new ApiError('ERROR', e && e.message ? e.message : 'Tuntematon virhe.');
        if (ae.code !== 'AUTH' && ae.code !== 'RATE_LIMIT') failures.set(ck, { until: now() + (ae.code === 'NOT_FOUND' ? FAIL_NOT_FOUND_MS : FAIL_MS), error: ae });
        if (hit) return view(kind, hit, { error: { code: ae.code, message: ae.message }, note: ae.message });
        throw ae;
      } finally {
        inflight.delete(ck);
        notify();
      }
    })();
    inflight.set(ck, p);
    return p;
  }

  // Live-rivin tila välimuistista (ei verkkokutsua): ok | pending | error | budget | none.
  function peek(nameIn, platform = 'uplay') {
    const name = typeof nameIn === 'string' ? nameIn.trim() : '';
    if (!name) return { state: 'none' };
    const ck = cacheKey('summary', platform, name), hit = store.get(ck), t = now();
    const out = hit ? { fetchedAt: hit.at, ageMs: Math.max(0, t - hit.at), stale: t - hit.at >= TTL.summary, ...compact(hit.data, sens()) } : {};
    if (inflight.has(ck)) return { ...out, state: 'pending' };
    if (hit) return { ...out, state: 'ok' };
    const f = failures.get(ck);
    if (f && f.until > t) return { state: 'error', message: f.error.message, code: f.error.code };
    const g = gate('auto');
    return { state: g.ok ? 'none' : (g.code === 'BUDGET' ? 'budget' : 'none'), message: g.ok ? '' : g.message };
  }
  const isFresh = (name, platform) => { const e = store.get(cacheKey('summary', platform, name)); return !!e && now() - e.at < TTL.summary; };
  // Oman profiilin rank-historia välimuistista (ei verkkokutsua): { history: [{ ts, rp, rank }], fetchedAt, stale } tai null. Vaatii avaimen (ilman sitä mitään ei näytetä).
  function peekProfile(nameIn, platform = 'uplay') {
    const name = typeof nameIn === 'string' ? nameIn.trim() : '';
    if (!name || !configured()) return null;
    const hit = store.get(cacheKey('profile', platform, name));
    if (!hit || !hit.data || !Array.isArray(hit.data.history)) return null;
    return { history: hit.data.history, fetchedAt: hit.at, stale: now() - hit.at >= TTL.profile };
  }

  // Käynnistää taustahaut rosterin pelaajille (vain jos avain on asetettu ja automaattihaku päällä). Sama pelaajajoukko ei laukaise uutta suunnitelmaa.
  function ensureRoster(roster, platform = 'uplay', source = 'default') {
    if (!configured() || !autoOn()) return { lookups: [], skipped: [] };
    const sig = `${platform}|${arr(roster).map((p) => (p && typeof p.name === 'string' ? p.name.trim().toLowerCase() : '')).filter(Boolean).sort().join(',')}`;
    if (lastSigs.get(source) === sig) return { lookups: [], skipped: [], same: true };
    lastSigs.set(source, sig);
    const plan = planRoster(roster, {
      isFresh: (nm) => isFresh(nm, platform),
      isPending: (nm) => inflight.has(cacheKey('summary', platform, nm)),
      failed: (nm) => { const f = failures.get(cacheKey('summary', platform, nm)); return !!f && f.until > now(); },
      remaining: Math.max(0, softLimit() - usedEstimate() - inflight.size),
    });
    for (const nm of plan.lookups) lookup('summary', nm, platform, { origin: 'auto' }).catch(() => {});
    return plan;
  }
  // Lisää arz-kenttä rosterin pelaajiin (vain kun avain on ja automaattihaku päällä), muuten palauttaa listan sellaisenaan.
  // o.fetch === false: vain välimuistissa oleva (ei uusia hakuja, esim. päättynyt ottelu). o.source: rosterilähde (gep / replay), jonka pelaajajoukko suunnitellaan erikseen.
  function decorate(list, nameOf, ownOf, o = {}) {
    const platform = o.platform || 'uplay';
    if (!configured() || !autoOn() || !Array.isArray(list)) return list;
    if (o.fetch !== false) ensureRoster(list.map((p) => ({ name: nameOf(p), isOwn: ownOf(p), anonymous: !!(p && p.isAnonymous) })), platform, o.source);
    return list.map((p) => (p && p.isAnonymous ? { ...p, arz: { state: 'none', anonymous: true } } : { ...p, arz: peek(nameOf(p), platform) }));
  }

  function status() {
    return {
      storageAvailable: keys.available(), configured: configured(), auto: autoOn(), usage: usageInfo(), server: store.server(),
      rateLimitedUntil: rateLimitedUntil > now() ? rateLimitedUntil : 0, lastTest, cacheEntries: store.size(), siteUrl: SITE_URL,
    };
  }
  async function refreshUsage(keyOverride) {
    const raw = await api('/me/usage', {}, keyOverride);
    const u = normalizeUsage(raw);
    store.setServer({ at: now(), plan: u.plan, limit: u.limit, totalCalls: u.totalCalls, statsCalls: u.statsCalls, localAt: store.usage().calls });
    return u;
  }
  // Testaa avaimen (GET /me/usage). Annettu ehdokasavain tallennetaan vasta onnistuneen testin jälkeen.
  async function testKey(candidate) {
    const key = candidate ? validateKey(candidate) : loadKey();
    if (!key) throw new ApiError('NO_KEY', 'Arenyze-avainta ei ole asetettu.');
    if (candidate && !keys.available()) throw new ApiError('NO_STORAGE', 'Salausta (safeStorage) ei ole saatavilla, joten avainta ei tallenneta.');
    try {
      await refreshUsage(key);
    } catch (e) {
      lastTest = { ok: false, at: now(), message: e && e.message ? e.message : 'Virhe' };
      throw e;
    }
    if (candidate) { keys.save(key); keyMem = key; lastSigs.clear(); }
    lastTest = { ok: true, at: now(), message: 'Avain toimii.' };
    notify();
    return status();
  }
  function clearKey() {
    const ok = keys.clear();
    keyMem = null; lastSigs.clear(); lastTest = null; failures.clear();
    notify();
    return ok;
  }

  return {
    keys, configured, status, lookup, peek, peekProfile, decorate, ensureRoster, testKey, clearKey, usage: usageInfo,
    refreshUsage: async () => { await refreshUsage(); notify(); return status(); },
    clearCache() { store.clearEntries(); failures.clear(); lastSigs.clear(); notify(); return true; },
    resetPlan() { lastSigs.clear(); },
    flush: store.flush, _store: store, _http: http, _failures: failures,
  };
}

module.exports = {
  BASE, SITE_URL, KEY_FILE, CACHE_FILE, NORM_VERSION, TTL, DEFAULT_SOFT_LIMIT, MANUAL_MIN_MS, PLATFORMS, KINDS, MODES,
  rankFromPoints, parseRankName, pickBoard, parseSegments, parseOperators, parseHistory, hsFromOperators,
  normalizeFullStats, normalizeProfile, normalizeOperators, normalizeUsage,
  toR6Input, evaluate, toCheckForm, compact, validateName, validateKey, validateLookupArg, validateKeyArg,
  createKeyStore, createCacheStore, planRoster, createArenyze,
};
