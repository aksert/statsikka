'use strict';
// "Oma profiili": rankkilogiikka, tilannekuvat (snapshot), muutokset ajanjaksolla, arviot ja ajastin.
// Puhdasta logiikkaa (ei electron-riippuvuuksia) -> testattavissa selftest.js:llä.
const ow = require('./providers/ow');
const rl = require('./rl-core');
const susp = require('./suspicion');
const { ApiError } = require('./http');
const { readJson, writeJsonAtomic } = require('./store');

const SNAPSHOT_CAP = 2000;
const ENTRY_CAP = 500;
const OW_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
const OW_ROLES = ['tank', 'damage', 'support', 'open'];
const DIVISION_FI = { bronze: 'Pronssi', silver: 'Hopea', gold: 'Kulta', platinum: 'Platina', diamond: 'Timantti', master: 'Mestari', grandmaster: 'Suurmestari', champion: 'Champion' };

// ---- Overwatch: rankkiportaat -------------------------------------------
// Bronze 5 = 0 ... Bronze 1 = 4, Silver 5 = 5 ... Champion 1 = 39 (ylin). Tier 5 on alin, 1 ylin.

const DIVS = ow.DIVISIONS;
const TIERS = 5;
const LADDER_MAX = DIVS.length * TIERS - 1;

function ladderValue(division, tier) {
  const d = DIVS.indexOf(String(division || '').toLowerCase());
  const t = Number(tier);
  if (d < 0 || !Number.isInteger(t) || t < 1 || t > TIERS) return null;
  return d * TIERS + (TIERS - t);
}
function rankLabel(division, tier) {
  const d = String(division || '').toLowerCase();
  return `${DIVISION_FI[d] || d} ${tier}`.trim();
}
function ladderRank(value) {
  if (!Number.isInteger(value) || value < 0 || value > LADDER_MAX) return null;
  const division = DIVS[Math.floor(value / TIERS)];
  const tier = TIERS - (value % TIERS);
  return { division, tier, value, label: rankLabel(division, tier) };
}
// Seuraava rankki tai null, jos jo ylimmässä (Champion 1) tai syöte on virheellinen.
function nextRank(division, tier) {
  const v = ladderValue(division, tier);
  if (v === null || v >= LADDER_MAX) return null;
  return ladderRank(v + 1);
}
function ladderTable() {
  return Array.from({ length: LADDER_MAX + 1 }, (_, v) => ladderRank(v));
}

// ---- Overwatch: tilannekuvat ----------------------------------------------

function fin(x) { return Number.isFinite(x) ? x : null; }
function nz(x) { return Number.isFinite(x) ? x : 0; }

// Normalisoidusta OW-profiilista (providers/ow.normalizeProfile) tilannekuva, tai null jos ei dataa.
function makeSnapshot(profile, ts) {
  if (!profile || !Number.isFinite(ts)) return null;
  const ranks = {};
  for (const r of profile.ranks || []) {
    if (!OW_ROLES.includes(r.role)) continue;
    const value = ladderValue(r.division, r.tier);
    if (value !== null) ranks[r.role] = { division: String(r.division).toLowerCase(), tier: Number(r.tier), value };
  }
  const t = profile.tiles || null;
  if (!t && Object.keys(ranks).length === 0) return null;
  return {
    ts,
    ranks,
    games_played: t ? fin(t.games) : null,
    games_won: t ? fin(t.wins) : null,
    games_lost: t ? fin(t.losses) : null,
    eliminations: t ? fin(t.eliminations) : null,
    deaths: t ? fin(t.deaths) : null,
    kd: t ? fin(t.kd) : null,
    winrate: t ? fin(t.winrate) : null,
    season: profile.season != null && Number.isFinite(Number(profile.season)) ? Number(profile.season) : null,
  };
}

function snapshotKey(s) {
  return JSON.stringify([OW_ROLES.map((r) => (s.ranks && s.ranks[r] ? s.ranks[r].value : null)),
    s.games_played, s.games_won, s.games_lost, s.eliminations, s.deaths, s.season]);
}
function snapshotChanged(prev, next) {
  if (!prev) return true;
  return snapshotKey(prev) !== snapshotKey(next);
}
// Lisää tilannekuvan vain jos jokin muuttui viimeisestä. Palauttaa { list, added } (uusi taulukko, rajattu capiin).
function appendSnapshot(list, snap, cap = SNAPSHOT_CAP) {
  const base = Array.isArray(list) ? list : [];
  if (!snap || !Number.isFinite(snap.ts)) return { list: base, added: false };
  if (!snapshotChanged(base[base.length - 1], snap)) return { list: base, added: false };
  const next = base.concat([snap]);
  return { list: next.length > cap ? next.slice(next.length - cap) : next, added: true };
}

// ---- Ajanjaksot ja muutokset ----------------------------------------------

function startOfWeek(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // maanantai
  return d.getTime();
}
function startOfMonth(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Laskurin muutos kahden peräkkäisen mittauksen välillä; pieneneminen = laskurit nollautuneet (uusi kausi) -> uusi arvo.
function counterDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b >= a ? b - a : b;
}

// Muutos aikaleimasta `sinceTs` eteenpäin. Lähtöpiste = viimeinen mittaus ennen rajaa, muuten ensimmäinen (partial).
function deltaSince(snaps, sinceTs) {
  if (!Array.isArray(snaps) || snaps.length === 0) return null;
  let baseIdx = -1;
  for (let i = 0; i < snaps.length; i++) { if (snaps[i].ts < sinceTs) baseIdx = i; else break; }
  const partial = baseIdx < 0;
  if (partial) baseIdx = 0;
  const base = snaps[baseIdx];
  const latest = snaps[snaps.length - 1];
  let wins = 0, losses = 0, games = 0;
  for (let i = baseIdx + 1; i < snaps.length; i++) {
    wins += counterDelta(snaps[i - 1].games_won, snaps[i].games_won);
    losses += counterDelta(snaps[i - 1].games_lost, snaps[i].games_lost);
    games += counterDelta(snaps[i - 1].games_played, snaps[i].games_played);
  }
  const rankChange = {};
  for (const role of OW_ROLES) {
    const a = base.ranks && base.ranks[role];
    const b = latest.ranks && latest.ranks[role];
    rankChange[role] = a && b ? b.value - a.value : null;
  }
  return {
    since: base.ts, partial, wins, losses, games, rankChange,
    seasonChanged: base.season !== latest.season, measurements: snaps.length - baseIdx,
  };
}

// ---- Overwatch: käsin kirjattu edistyminen ---------------------------------

// Viimeisin mittaus, jonka aikaleima <= ts.
function countsAt(snaps, ts) {
  let r = null;
  for (const s of snaps) { if (s.ts <= ts) r = s; else break; }
  return r;
}

// Keskimääräinen edistyminen (prosenttiyksikköä) voittoa kohti peräkkäisten käsin kirjattujen merkintöjen välillä.
// Oletus: voitto ja tappio ovat suunnilleen yhtä suuret -> nettovoitot = voitot - tappiot. Vain saman rankin ja kauden parit.
function estimateProgressPerWin(entries, snaps) {
  const list = (entries || []).slice().sort((a, b) => a.ts - b.ts);
  let dPct = 0, dNet = 0, samples = 0, wins = 0, losses = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (a.value !== b.value) continue;
    if (a.season != null && b.season != null && a.season !== b.season) continue;
    const ca = countsAt(snaps || [], a.ts), cb = countsAt(snaps || [], b.ts);
    if (!ca || !cb) continue;
    const w = nz(cb.games_won) - nz(ca.games_won), l = nz(cb.games_lost) - nz(ca.games_lost);
    if (w < 0 || l < 0) continue;
    const net = w - l, d = b.percent - a.percent;
    if (net <= 0 || d <= 0) continue;
    dPct += d; dNet += net; samples++; wins += w; losses += l;
  }
  if (!samples) return null;
  return { perWin: dPct / dNet, samples, wins, losses };
}

// Tila roolin edistymiselle viimeisimmän merkinnän perusteella.
function progressStatus(entries, snaps, currentValue) {
  const list = (entries || []).slice().sort((a, b) => a.ts - b.ts);
  const last = list[list.length - 1];
  if (!last) return null;
  const stale = currentValue != null && last.value !== currentValue; // rankki vaihtunut merkinnän jälkeen
  const out = { lastPercent: last.percent, lastTs: last.ts, remaining: Math.max(0, 100 - last.percent), stale, perWin: null, winsNeeded: null, samples: 0 };
  if (stale) return out;
  const est = estimateProgressPerWin(list, snaps);
  if (est) {
    out.perWin = est.perWin;
    out.samples = est.samples;
    out.winsNeeded = out.remaining === 0 ? 0 : Math.ceil(out.remaining / est.perWin);
  }
  return out;
}

// ---- Rocket League: rankit ---------------------------------------------------

const RL_TIER_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion'];
const RL_ROMAN = ['I', 'II', 'III'];
const RL_RANKS = RL_TIER_NAMES.flatMap((t) => RL_ROMAN.map((r) => `${t} ${r}`)).concat(['Supersonic Legend']);
const RL_SSL = RL_RANKS.length - 1;
const RL_DIVISIONS = 4;
const RL_PLAYLISTS = {
  duel: { label: 'Duel 1v1', ids: [10] },
  doubles: { label: 'Doubles 2v2', ids: [11] },
  standard: { label: 'Standard 3v3', ids: [12, 13] },
  other: { label: 'Muu', ids: [27, 28, 29, 30] },
};
const RL_PLAYLIST_KEYS = Object.keys(RL_PLAYLISTS);
const RL_PLATFORMS = ['epic', 'steam', 'psn', 'xbox', 'switch'];
const RL_DEFAULT_GAIN = 9; // MMR / voitto, kun omista merkinnöistä ei voi johtaa

function rlLadderValue(rank, division) {
  if (!Number.isInteger(rank) || rank < 0 || rank > RL_SSL) return null;
  if (rank === RL_SSL) return rank * RL_DIVISIONS;
  if (!Number.isInteger(division) || division < 1 || division > RL_DIVISIONS) return null;
  return rank * RL_DIVISIONS + (division - 1);
}
function rlRankLabel(rank, division) {
  if (rank === RL_SSL) return RL_RANKS[RL_SSL];
  return `${RL_RANKS[rank]}, Div ${division}`;
}
// Seuraava divisioona / rankki; null jos Supersonic Legend.
function rlNext(rank, division) {
  if (rlLadderValue(rank, division) === null || rank === RL_SSL) return null;
  if (division < RL_DIVISIONS) return { rank, division: division + 1, label: rlRankLabel(rank, division + 1) };
  const nr = rank + 1;
  const nd = 1;
  return { rank: nr, division: nd, label: rlRankLabel(nr, nd) };
}
function rlLadderTable() {
  return RL_RANKS.map((label, rank) => ({ value: rank * RL_DIVISIONS, label }));
}

// Oman pelaajan ratkaistut ottelut aikajärjestyksessä.
function ownResults(matches, own) {
  const out = [];
  for (const rec of matches || []) {
    const o = rl.findOwn(rec.players || [], own);
    if (!o) continue;
    if (rec.winnerTeamNum !== 0 && rec.winnerTeamNum !== 1) continue;
    out.push({
      ts: Date.parse(rec.endedAt) || 0, playlistId: rec.playlistId == null ? null : Number(rec.playlistId),
      won: rec.winnerTeamNum === o.teamNum, goals: o.goals, saves: o.saves, shots: o.shots, guid: rec.guid,
    });
  }
  return out.map((r, i) => ({ r, i })).sort((a, b) => a.r.ts - b.r.ts || a.i - b.i).map((x) => x.r);
}

// Nykyinen voitto-/tappioputki: { type: 'win'|'loss', count } tai null.
function currentStreak(results) {
  if (!results || results.length === 0) return null;
  const lastWon = results[results.length - 1].won;
  let count = 0;
  for (let i = results.length - 1; i >= 0 && results[i].won === lastWon; i--) count++;
  return { type: lastWon ? 'win' : 'loss', count };
}

function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Liukuva keskiarvo (ikkuna `window`): kind 'winrate' (%) tai 'goals' (maalit/peli). Vähintään minGames peliä.
function rollingSeries(results, kind, window = 10, minGames = 3) {
  const out = [];
  for (let i = 0; i < (results || []).length; i++) {
    const slice = results.slice(Math.max(0, i - window + 1), i + 1);
    if (slice.length < Math.min(minGames, window)) continue;
    const value = kind === 'winrate'
      ? (slice.filter((x) => x.won).length / slice.length) * 100
      : slice.reduce((a, x) => a + x.goals, 0) / slice.length;
    out.push({ i: i + 1, ts: results[i].ts, value: r2(value) });
  }
  return out;
}
function lastGames(results, n = 10) {
  const slice = (results || []).slice(-n);
  const wins = slice.filter((x) => x.won).length;
  return { games: slice.length, wins, winrate: slice.length ? r2((wins / slice.length) * 100) : null };
}

function recordsBetween(results, ids, fromTs, toTs) {
  let w = 0, l = 0;
  for (const r of results || []) {
    if (r.ts > fromTs && r.ts <= toTs && ids.includes(r.playlistId)) { if (r.won) w++; else l++; }
  }
  return { w, l };
}

// MMR / voitto omista MMR-merkinnöistä + paikallisesta ottelushistoriasta (nettovoitot = voitot - tappiot).
function estimateRlGain(entries, results, ids) {
  const list = (entries || []).filter((e) => Number.isFinite(e.mmr)).sort((a, b) => a.ts - b.ts);
  let dMmr = 0, dNet = 0, samples = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const { w, l } = recordsBetween(results, ids, a.ts, b.ts);
    const net = w - l, d = b.mmr - a.mmr;
    if (net <= 0 || d <= 0) continue;
    dMmr += d; dNet += net; samples++;
  }
  if (!samples) return null;
  return { gain: dMmr / dNet, samples };
}

// "Kuinka paljon tarvitset": vaatii viimeiseltä merkinnältä mmr + nextMmr.
function rlNeed(entries, results, ids) {
  const list = (entries || []).slice().sort((a, b) => a.ts - b.ts);
  const last = list[list.length - 1];
  if (!last || !Number.isFinite(last.mmr) || !Number.isFinite(last.nextMmr)) return null;
  const est = estimateRlGain(list, results, ids);
  const gain = est ? est.gain : RL_DEFAULT_GAIN;
  const need = Math.max(0, Math.ceil(last.nextMmr - last.mmr));
  return { need, gain, derived: !!est, samples: est ? est.samples : 0, winsNeeded: need === 0 ? 0 : Math.ceil(need / gain), nextMmr: last.nextMmr, mmr: last.mmr };
}

// ---- Syötteiden validointi (IPC) ---------------------------------------------

const ID_RE = /^[a-z0-9]{6,32}$/;
function newId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
function bad(msg) { return new ApiError('BAD_INPUT', msg); }
function isObj(a) { return a && typeof a === 'object' && !Array.isArray(a); }
function optInt(v, lo, hi, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) throw bad(`${name}: anna kokonaisluku ${lo}–${hi}.`);
  return n;
}

function validateOwProgress(arg) {
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  if (!OW_ROLES.includes(arg.role)) throw bad('Virheellinen rooli.');
  const p = typeof arg.percent === 'string' ? Number(arg.percent.replace(',', '.')) : arg.percent;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) throw bad('Edistymisen pitää olla luku 0–100.');
  return { role: arg.role, percent: Math.round(p * 10) / 10 };
}
function validateRlRank(arg) {
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  if (!RL_PLAYLIST_KEYS.includes(arg.playlist)) throw bad('Virheellinen pelilista.');
  const rank = typeof arg.rank === 'string' && arg.rank.trim() !== '' ? Number(arg.rank) : arg.rank;
  if (!Number.isInteger(rank) || rank < 0 || rank > RL_SSL) throw bad('Virheellinen rankki.');
  let division = typeof arg.division === 'string' && arg.division.trim() !== '' ? Number(arg.division) : arg.division;
  if (rank === RL_SSL) division = 1;
  if (!Number.isInteger(division) || division < 1 || division > RL_DIVISIONS) throw bad('Divisioonan pitää olla 1–4.');
  const mmr = optInt(arg.mmr, 0, 9999, 'MMR');
  const nextMmr = optInt(arg.nextMmr, 0, 9999, 'Seuraavan rajan MMR');
  if (nextMmr !== null && mmr === null) throw bad('Anna myös nykyinen MMR, kun annat seuraavan rajan MMR:n.');
  if (nextMmr !== null && nextMmr <= mmr) throw bad('Seuraavan rajan MMR:n pitää olla suurempi kuin nykyinen MMR.');
  return { playlist: arg.playlist, rank, division, mmr, nextMmr };
}
function validateId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('Virheellinen tunniste.');
  return id;
}

// ---- Historiatiedosto (profile-history.json) ------------------------------------

function emptyHistory() {
  return {
    version: 1,
    ow: { tag: '', snapshots: [], progress: { tank: [], damage: [], support: [], open: [] } },
    rl: { ranks: { duel: [], doubles: [], standard: [], other: [] } },
  };
}
function cleanSnapshot(s) {
  if (!isObj(s) || !Number.isFinite(s.ts)) return null;
  const ranks = {};
  for (const role of OW_ROLES) {
    const r = s.ranks && s.ranks[role];
    const v = r ? ladderValue(r.division, r.tier) : null;
    if (v !== null) ranks[role] = { division: String(r.division).toLowerCase(), tier: Number(r.tier), value: v };
  }
  return {
    ts: s.ts, ranks, games_played: fin(s.games_played), games_won: fin(s.games_won), games_lost: fin(s.games_lost),
    eliminations: fin(s.eliminations), deaths: fin(s.deaths), kd: fin(s.kd), winrate: fin(s.winrate), season: fin(s.season),
  };
}
function cleanProgressEntry(e, role) {
  if (!isObj(e) || !Number.isFinite(e.ts) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  const value = ladderValue(e.division, e.tier);
  if (value === null || !Number.isFinite(e.percent) || e.percent < 0 || e.percent > 100) return null;
  return { id: e.id, ts: e.ts, role, percent: e.percent, division: String(e.division).toLowerCase(), tier: Number(e.tier), value, season: fin(e.season) };
}
function cleanRlEntry(e, playlist) {
  if (!isObj(e) || !Number.isFinite(e.ts) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  const rank = e.rank, division = rank === RL_SSL ? 1 : e.division;
  const value = rlLadderValue(rank, division);
  if (value === null) return null;
  return { id: e.id, ts: e.ts, playlist, rank, division, value, mmr: fin(e.mmr), nextMmr: fin(e.nextMmr) };
}
function normalizeHistory(raw) {
  const out = emptyHistory();
  if (!isObj(raw)) return out;
  if (isObj(raw.ow)) {
    out.ow.tag = typeof raw.ow.tag === 'string' ? raw.ow.tag.slice(0, 80) : '';
    out.ow.snapshots = (Array.isArray(raw.ow.snapshots) ? raw.ow.snapshots : []).map(cleanSnapshot).filter(Boolean)
      .sort((a, b) => a.ts - b.ts).slice(-SNAPSHOT_CAP);
    for (const role of OW_ROLES) {
      const src = raw.ow.progress && Array.isArray(raw.ow.progress[role]) ? raw.ow.progress[role] : [];
      out.ow.progress[role] = src.map((e) => cleanProgressEntry(e, role)).filter(Boolean).sort((a, b) => a.ts - b.ts).slice(-ENTRY_CAP);
    }
  }
  if (isObj(raw.rl) && isObj(raw.rl.ranks)) {
    for (const key of RL_PLAYLIST_KEYS) {
      const src = Array.isArray(raw.rl.ranks[key]) ? raw.rl.ranks[key] : [];
      out.rl.ranks[key] = src.map((e) => cleanRlEntry(e, key)).filter(Boolean).sort((a, b) => a.ts - b.ts).slice(-ENTRY_CAP);
    }
  }
  return out;
}
function createHistoryStore(file) {
  const data = normalizeHistory(readJson(file, null));
  return { data, file, save() { writeJsonAtomic(file, data); } };
}

// ---- Dashboard (renderöijälle) --------------------------------------------------

function buildOwSection({ settings, history, ownProfile, now }) {
  const op = settings.owProfile || {};
  const parsed = ow.parseBattleTag(op.battletag || '');
  const key = parsed ? `${parsed.id}|${op.platform}` : '';
  const configured = !!parsed;
  const out = { configured, battletag: parsed ? `${parsed.name}#${parsed.number}` : '', platform: op.platform || 'pc' };
  if (!configured) return out;
  const hist = history.ow.tag === key ? history.ow : { snapshots: [], progress: { tank: [], damage: [], support: [], open: [] } };
  const snaps = hist.snapshots;
  const latest = snaps[snaps.length - 1] || null;
  const prof = ownProfile && ownProfile.profile ? ownProfile.profile : null;

  const byRoleProfile = {};
  if (prof) prof.ranks.forEach((r) => { byRoleProfile[r.role] = r; });
  const roleKeys = ['tank', 'damage', 'support'];
  if ((latest && latest.ranks.open) || (hist.progress.open && hist.progress.open.length) || byRoleProfile.open) roleKeys.push('open');
  const roles = roleKeys.map((role) => {
    const cur = latest && latest.ranks[role] ? latest.ranks[role] : null;
    const next = cur ? nextRank(cur.division, cur.tier) : null;
    const entries = hist.progress[role] || [];
    const pr = byRoleProfile[role] || null;
    return {
      role,
      current: cur ? { division: cur.division, tier: cur.tier, value: cur.value, label: rankLabel(cur.division, cur.tier) } : null,
      next: next ? { division: next.division, tier: next.tier, value: next.value, label: next.label } : null,
      atTop: !!cur && !next,
      rankIcon: pr ? pr.rankIcon : null, tierIcon: pr ? pr.tierIcon : null, roleIcon: pr ? pr.roleIcon : null,
      progress: cur ? progressStatus(entries, snaps, cur.value) : null,
      entries: entries.slice(-5).reverse().map((e) => ({ id: e.id, ts: e.ts, percent: e.percent, label: rankLabel(e.division, e.tier) })),
      entryCount: entries.length,
    };
  });

  const t = prof && prof.tiles ? prof.tiles : null;
  const tiles = t
    ? { wins: t.wins, losses: t.losses, winrate: t.winrate, kd: t.kd, mostElims: t.mostElims, games: t.games }
    : (latest ? { wins: latest.games_won, losses: latest.games_lost, winrate: latest.winrate, kd: latest.kd, mostElims: null, games: latest.games_played } : null);

  Object.assign(out, {
    profile: prof ? {
      name: prof.name, avatar: prof.avatar, title: prof.title, namecard: prof.namecard, season: prof.season,
      hasStats: prof.hasStats, isPrivate: prof.isPrivate, rankPlatform: prof.rankPlatform,
      suspicion: susp.withSensitivity(prof.suspicion, settings.suspicionSensitivity), accuracy: prof.accuracy || [],
    } : null,
    fetchedAt: ownProfile ? ownProfile.fetchedAt || null : null,
    error: ownProfile && ownProfile.error ? ownProfile.error : null,
    season: latest ? latest.season : (prof ? prof.season : null),
    roles, tiles,
    snapshots: snaps.map((s) => ({ ts: s.ts, ranks: s.ranks, winrate: s.winrate, kd: s.kd, season: s.season, games_played: s.games_played })),
    deltas: { week: deltaSince(snaps, startOfWeek(now)), month: deltaSince(snaps, startOfMonth(now)) },
  });
  return out;
}

function buildRlSection({ settings, history, matches, now }) {
  const name = settings.rlOwnName || '';
  const own = { name, id: settings.rlOwnId || '' };
  const out = { configured: !!name, name, platform: settings.rlPlatform || 'epic' };
  if (!out.configured) return out;
  const results = ownResults(matches, own);
  const summary = rl.summarizeHistory(matches, own);
  out.summary = {
    total: summary.total, counted: summary.counted, wins: summary.wins, losses: summary.losses, winrate: summary.winrate,
    goalsPerGame: summary.goalsPerGame, savesPerGame: summary.savesPerGame,
  };
  out.last10 = lastGames(results, 10);
  out.streak = currentStreak(results);
  out.series = { winrate: rollingSeries(results, 'winrate'), goals: rollingSeries(results, 'goals') };
  out.playlists = RL_PLAYLIST_KEYS.map((key) => {
    const entries = history.rl.ranks[key] || [];
    const ids = RL_PLAYLISTS[key].ids;
    const last = entries[entries.length - 1] || null;
    const next = last ? rlNext(last.rank, last.division) : null;
    return {
      key, label: RL_PLAYLISTS[key].label,
      entries: entries.map((e) => ({ id: e.id, ts: e.ts, rank: e.rank, division: e.division, value: e.value, mmr: e.mmr, nextMmr: e.nextMmr, label: rlRankLabel(e.rank, e.division) })),
      current: last ? { rank: last.rank, division: last.division, label: rlRankLabel(last.rank, last.division), mmr: last.mmr, nextMmr: last.nextMmr, ts: last.ts } : null,
      next: next ? { label: next.label } : null,
      atTop: !!last && !next,
      need: rlNeed(entries, results, ids),
    };
  });
  return out;
}

function buildDashboard({ settings, history, ownProfile, matches, now = Date.now() }) {
  return {
    now,
    ladder: ladderTable().map((r) => ({ value: r.value, label: r.label })),
    rlLadder: rlLadderTable(),
    rlRanks: RL_RANKS.slice(),
    rlSsl: RL_SSL,
    rlDefaultGain: RL_DEFAULT_GAIN,
    rlPlaylists: RL_PLAYLIST_KEYS.map((k) => [k, RL_PLAYLISTS[k].label]),
    ow: buildOwSection({ settings, history, ownProfile, now }),
    rl: buildRlSection({ settings, history, matches, now }),
    r6: { configured: !!settings.r6Name, name: settings.r6Name || '' },
  };
}

// ---- Ajastin ----------------------------------------------------------------------

// Ajaa run()-funktion heti käynnistettäessä ja sen jälkeen intervalMs välein. Ei päällekkäisiä ajoja.
function createScheduler({ run, intervalMs = OW_SNAPSHOT_INTERVAL_MS, setIntervalFn = setInterval, clearIntervalFn = clearInterval, onError }) {
  let timer = null;
  let busy = false;
  async function tick() {
    if (busy) return false;
    busy = true;
    try { await run(); return true; }
    catch (e) { if (onError) onError(e); return false; }
    finally { busy = false; }
  }
  return {
    start() {
      if (timer) return Promise.resolve(false);
      timer = setIntervalFn(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return tick();
    },
    stop() { if (timer) { clearIntervalFn(timer); timer = null; } },
    tick,
    get running() { return !!timer; },
  };
}

module.exports = {
  SNAPSHOT_CAP, ENTRY_CAP, OW_SNAPSHOT_INTERVAL_MS, OW_ROLES, DIVISION_FI,
  ladderValue, ladderRank, nextRank, rankLabel, ladderTable, LADDER_MAX,
  makeSnapshot, snapshotChanged, appendSnapshot,
  startOfWeek, startOfMonth, deltaSince, countsAt, estimateProgressPerWin, progressStatus,
  RL_RANKS, RL_SSL, RL_PLAYLISTS, RL_PLAYLIST_KEYS, RL_PLATFORMS, RL_DEFAULT_GAIN,
  rlLadderValue, rlRankLabel, rlNext, ownResults, currentStreak, rollingSeries, lastGames, estimateRlGain, rlNeed,
  newId, validateOwProgress, validateRlRank, validateId,
  emptyHistory, normalizeHistory, createHistoryStore, buildDashboard, createScheduler,
};
