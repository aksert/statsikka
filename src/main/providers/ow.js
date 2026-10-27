'use strict';
// Overwatch 2 -datalähde: OverFast API (https://overfast-api.tekrop.fr), ei avainta.
const { ApiError } = require('../http');
const S = require('../suspicion');

const BASE = 'https://overfast-api.tekrop.fr';
const TAG_RE = /^([\p{L}\p{N}_]{2,24})[#-](\d{3,8})$/u;
const NAME_RE = /^[\p{L}\p{N}_]{2,24}$/u;
const HASH_ID_RE = /^[0-9a-f]{6,40}(?:%7C|\|)[0-9a-f]{6,40}$/i;

const GAMEMODES = ['competitive', 'quickplay'];
const PLATFORMS = ['pc', 'console'];
const DIVISIONS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'champion'];

// ---- Puhtaat apufunktiot ------------------------------------------------

// "Name#1234" tai "Name-1234" -> { name, number, id: "Name-1234" } tai null
function parseBattleTag(input) {
  if (typeof input !== 'string') return null;
  const m = TAG_RE.exec(input.trim());
  if (!m) return null;
  return { name: m[1], number: m[2], id: `${m[1]}-${m[2]}` };
}

function battleTagToId(input) {
  const p = parseBattleTag(input);
  return p ? p.id : null;
}

function isValidName(input) {
  return typeof input === 'string' && NAME_RE.test(input.trim());
}

// Sallii BattleTagin tai OverFastin tunnistehajautuksen (haku nimellä palauttaa tämän).
function normalizePlayerRef(input) {
  const p = parseBattleTag(input);
  if (p) return p.id;
  if (typeof input === 'string' && HASH_ID_RE.test(input.trim())) return input.trim().replace('|', '%7C');
  return null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Tapot / kuolemat, 2 desimaalia. 0 kuolemaa -> tapot; 0/0 -> null.
function kd(eliminations, deaths) {
  const e = Number(eliminations);
  const d = Number(deaths);
  if (!Number.isFinite(e) || !Number.isFinite(d)) return null;
  if (d === 0) return e === 0 ? null : round2(e);
  return round2(e / d);
}

const HERO_EXCEPTIONS = {
  dva: 'D.Va', lucio: 'Lúcio', torbjorn: 'Torbjörn', 'soldier-76': 'Soldier: 76',
  'wrecking-ball': 'Wrecking Ball', 'junker-queen': 'Junker Queen', 'jetpack-cat': 'Jetpack Cat',
};
function prettifyHero(key, heroMap) {
  if (heroMap && heroMap[key] && heroMap[key].name) return heroMap[key].name;
  if (HERO_EXCEPTIONS[key]) return HERO_EXCEPTIONS[key];
  return String(key).split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasKeys(o) {
  return o && typeof o === 'object' && Object.keys(o).length > 0;
}

function rankScore(r) {
  const idx = DIVISIONS.indexOf(String(r.division || '').toLowerCase());
  return idx * 10 + (6 - asNum(r.tier));
}

function stripIconFragment(url) {
  return typeof url === 'string' ? url.replace(/#.*$/, '') : null;
}

// Kerää roolit valitulta alustalta (jos tyhjä, toiselta alustalta merkinnällä).
function normalizeRanks(summary, platform) {
  const comp = (summary && summary.competitive) || {};
  const pick = (pf) => {
    const block = comp[pf];
    if (!block) return [];
    const out = [];
    for (const role of ['tank', 'damage', 'support', 'open']) {
      const r = block[role];
      if (r && r.division) {
        out.push({
          role,
          division: String(r.division).toLowerCase(),
          tier: asNum(r.tier),
          rankIcon: stripIconFragment(r.rank_icon),
          tierIcon: stripIconFragment(r.tier_icon),
          roleIcon: stripIconFragment(r.role_icon),
        });
      }
    }
    return out;
  };
  let used = platform;
  let ranks = pick(platform);
  if (ranks.length === 0) {
    const other = platform === 'pc' ? 'console' : 'pc';
    const alt = pick(other);
    if (alt.length) { ranks = alt; used = other; }
  }
  const season = comp[used] && comp[used].season != null ? comp[used].season : null;
  let best = null;
  for (const r of ranks) if (!best || rankScore(r) > rankScore(best)) best = r;
  return { ranks, rankPlatform: ranks.length ? used : platform, season, bestRank: best };
}

function normalizeStats(stats, career, heroMap) {
  if (!hasKeys(stats) || !stats.general) return null;
  const g = stats.general;
  const total = g.total || {};
  const best = (career && career['all-heroes'] && career['all-heroes'].best) || {};
  const tiles = {
    wins: asNum(g.games_won),
    losses: asNum(g.games_lost),
    games: asNum(g.games_played),
    winrate: g.winrate != null ? round2(g.winrate) : null,
    kd: kd(total.eliminations, total.deaths),
    eliminations: total.eliminations != null ? asNum(total.eliminations) : null,
    deaths: total.deaths != null ? asNum(total.deaths) : null,
    kda: g.kda != null ? round2(g.kda) : null,
    mostElims: best.eliminations_most_in_game != null ? asNum(best.eliminations_most_in_game) : null,
    bestStreak: best.kill_streak_best != null ? asNum(best.kill_streak_best) : null,
    mostFinalBlows: best.final_blows_most_in_game != null ? asNum(best.final_blows_most_in_game) : null,
    timePlayed: asNum(g.time_played),
  };
  const roles = Object.entries(stats.roles || {}).map(([role, r]) => ({
    role,
    games: asNum(r.games_played),
    wins: asNum(r.games_won),
    losses: asNum(r.games_lost),
    winrate: r.winrate != null ? round2(r.winrate) : null,
    kda: r.kda != null ? round2(r.kda) : null,
    kd: kd(r.total && r.total.eliminations, r.total && r.total.deaths),
    timePlayed: asNum(r.time_played),
  })).sort((a, b) => b.timePlayed - a.timePlayed);
  const heroes = Object.entries(stats.heroes || {}).map(([key, r]) => ({
    key,
    name: prettifyHero(key, heroMap),
    portrait: (heroMap && heroMap[key] && heroMap[key].portrait) || null,
    role: (heroMap && heroMap[key] && heroMap[key].role) || null,
    games: asNum(r.games_played),
    winrate: r.winrate != null ? round2(r.winrate) : null,
    kda: r.kda != null ? round2(r.kda) : null,
    timePlayed: asNum(r.time_played),
  })).sort((a, b) => b.timePlayed - a.timePlayed);
  return { tiles, roles, heroes };
}

// summary + stats/summary + stats/career (+ heroes-kartta) -> renderöijälle sopiva muoto.
function normalizeProfile({ id, summary, stats, career, heroMap, platform = 'pc', gamemode = 'competitive', isPublic = null }) {
  const s = summary || {};
  const rk = normalizeRanks(s, platform);
  const st = normalizeStats(stats, career, heroMap);
  const prof = {
    id,
    name: s.username || (id ? id.replace(/-\d+$/, '') : ''),
    avatar: s.avatar || null,
    namecard: s.namecard || null,
    title: s.title || null,
    endorsement: s.endorsement ? { level: asNum(s.endorsement.level), frame: stripIconFragment(s.endorsement.frame) } : null,
    ranks: rk.ranks,
    rankPlatform: rk.rankPlatform,
    season: rk.season,
    bestRank: rk.bestRank,
    platform,
    gamemode,
    hasStats: !!st,
    isPrivate: isPublic === false,
    tiles: st ? st.tiles : null,
    roles: st ? st.roles : [],
    heroes: st ? st.heroes : [],
  };
  // Epätavalliset tilastot (normaaliherkkyys; käyttäjän herkkyys sovelletaan pääprosessissa) ja tarkkuusrivit samasta careerista.
  prof.suspicion = st ? S.evaluate(prof, career) : null;
  prof.accuracy = S.topHitscan(career).map((r) => ({
    ...r,
    name: prettifyHero(r.key, heroMap),
    portrait: (heroMap && heroMap[r.key] && heroMap[r.key].portrait) || null,
  }));
  return prof;
}

// ---- Haku (käyttää http-asiakasta) --------------------------------------

function createOw(http) {
  let heroCache = null; // { at, map }
  const HERO_TTL = 6 * 60 * 60 * 1000;

  async function getHeroMap() {
    if (heroCache && Date.now() - heroCache.at < HERO_TTL) return heroCache.map;
    try {
      const list = await http.getJson(`${BASE}/heroes`);
      const map = {};
      for (const h of Array.isArray(list) ? list : []) {
        if (h && h.key) map[h.key] = { name: h.name, portrait: h.portrait || null, role: h.role || null };
      }
      heroCache = { at: Date.now(), map };
      return map;
    } catch (_) {
      return heroCache ? heroCache.map : {};
    }
  }

  async function search(name) {
    if (!isValidName(name)) throw new ApiError('BAD_INPUT', 'Virheellinen nimi.');
    const data = await http.getJson(`${BASE}/players?name=${encodeURIComponent(name.trim())}`);
    const results = Array.isArray(data && data.results) ? data.results : [];
    return results.slice(0, 20).map((r) => ({
      id: r.player_id,
      name: r.name,
      avatar: r.avatar || null,
      title: r.title || null,
      isPublic: r.is_public !== false,
    }));
  }

  async function getProfile({ ref, gamemode = 'competitive', platform = 'pc' }) {
    const id = normalizePlayerRef(ref);
    if (!id) throw new ApiError('BAD_INPUT', 'Virheellinen BattleTag. Muoto: Nimi#1234.');
    if (!GAMEMODES.includes(gamemode) || !PLATFORMS.includes(platform)) throw new ApiError('BAD_INPUT', 'Virheellinen valinta.');
    const pid = encodeURIComponent(id).replace(/%25/g, '%');
    const q = `gamemode=${gamemode}&platform=${platform}`;

    const summary = await http.getJson(`${BASE}/players/${pid}/summary`);
    const settled = await Promise.allSettled([
      http.getJson(`${BASE}/players/${pid}/stats/summary?${q}`),
      http.getJson(`${BASE}/players/${pid}/stats/career?${q}`),
      getHeroMap(),
    ]);
    const [stR, caR, heR] = settled;
    let stats = null;
    if (stR.status === 'fulfilled') stats = stR.value;
    else if (!(stR.reason instanceof ApiError && stR.reason.code === 'NOT_FOUND')) throw stR.reason;
    const career = caR.status === 'fulfilled' ? caR.value : null;
    const heroMap = heR.status === 'fulfilled' ? heR.value : {};

    let isPublic = null;
    if (!hasKeys(stats) || !stats.general) {
      // Selvitä onko profiili yksityinen (haku palauttaa is_public-kentän).
      try {
        const r = await http.getJson(`${BASE}/players?name=${encodeURIComponent(id)}`);
        const hit = (r && r.results && r.results[0]) || null;
        if (hit && typeof hit.is_public === 'boolean') isPublic = hit.is_public;
      } catch (_) { /* ei kriittinen */ }
    }
    return normalizeProfile({ id, summary, stats, career, heroMap, platform, gamemode, isPublic });
  }

  return { search, getProfile, getHeroMap };
}

module.exports = {
  BASE, createOw, normalizeProfile, normalizeRanks, normalizeStats,
  parseBattleTag, battleTagToId, normalizePlayerRef, isValidName,
  kd, round2, prettifyHero, GAMEMODES, PLATFORMS, DIVISIONS,
};
