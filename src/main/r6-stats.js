'use strict';
// Rainbow Six Siege: tallennetuista otteluyhteenvedoista (src/main/r6/summary.js) lasketut koosteet. Puhdasta logiikkaa
// (ei fs/electron-riippuvuuksia) -> testattavissa selftest.js:llÃ¤. SyÃ¶te on taulukko ottelutietueita:
// summary-olio + `name` (kansion nimi) + pelaajille valinnainen `opStats` [{ name, role, rounds, kills, deaths, headshots }].
const susp = require('./suspicion');
const advanced = require('./r6-advanced');
const { MATCH_TYPES } = require('./r6/dissect/tables');

const MATCH_FILTERS = ['all', 'ranked', 'unranked', 'quick'];
const ROLLING_WINDOW = 10;
const MIN_ROLLING = 3;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const nz = (n) => (Number.isFinite(n) ? n : 0);
const kdOf = (k, d) => (d > 0 ? round2(k / d) : k);
const hsOf = (h, k) => (k > 0 ? round1((h / k) * 100) : 0);
const kprOf = (k, r) => (r > 0 ? round2(k / r) : 0);
const ratio = (a, b) => (b > 0 ? round1((a / b) * 100) : null);

// AIKALEIMAT: tallenteen sisäinen `timestamp` / `lastRoundTimestamp` on pelikoneen PAIKALLINEN kellonaika, vaikka loppuun on merkitty 'Z'
// (esim. kansio Match-2026-10-26_17-55-02 = klo 17.55 Suomen aikaa, tallenteen timestamp "2026-10-26T17:56:23Z" = oikea UTC olisi 15:56Z).
// Date.parse() antaisi ajan, joka on UTC-eron (2-3 h) verran liian myöhäinen. Tässä Z ohitetaan ja merkkijono tulkitaan paikalliseksi
// (new Date(v, k, p, h, min, s) huomioi kesä- ja talviajan oikein). Tarkistettu oikeasta datasta (47 ottelua): tiedoston mtime - paikallisena
// tulkittu lastRoundTimestamp = 0-8 min joka ottelulle, kun taas Date.parse(timestamp) - mtime = 80-180 min (= UTC-ero).
// Tallennettuja tietoja (r6-matches.json) ei muuteta: tulkinta tehdään vasta luettaessa. Palauttaa oikean UTC-epochin (ms) tai NaN.
function wallTs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z?$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}
const tsOf = (m) => wallTs(m && m.timestamp) || 0;

// Ottelutyypin nimi: tallennettu nimi voi olla vanha "MatchType(N)" (jäsennin ei tuntenut id:tä silloin) -> haetaan nimi id:llä nykyisestä taulukosta.
// Tallennettuun yhteenvetoon ei kosketa.
function typeName(m) {
  const mt = m && m.matchType;
  if (!mt) return '';
  const nm = mt.name || '';
  return /^MatchType\(\d+\)$/.test(nm) && Number.isFinite(mt.id) && MATCH_TYPES[mt.id] ? MATCH_TYPES[mt.id] : nm;
}
function sortChrono(matches) {
  return (matches || []).filter((m) => m && Array.isArray(m.players)).slice()
    .sort((a, b) => tsOf(a) - tsOf(b) || String(a.name || '').localeCompare(String(b.name || '')));
}

// 'ranked' | 'unranked' | 'quick' | 'other'
function typeKey(m) {
  const n = typeName(m).toLowerCase();
  if (n === 'ranked') return 'ranked';
  if (n === 'unranked' || n === 'standard') return 'unranked';
  if (n.startsWith('quick')) return 'quick';
  return 'other';
}
function matchesFilter(m, filter) { return filter === 'all' || typeKey(m) === filter; }

function ownPlayer(m, ownId) {
  if (!m || !ownId) return null;
  return (m.players || []).find((p) => p.profileID === ownId) || null;
}

// Kierroksen voittaja (0/1/-1). KÃ¤yttÃ¤Ã¤ jÃ¤sentimen winnerTeamIndex-kenttÃ¤Ã¤, muuten johtaa sen kumulatiivisesta pistetilanteesta.
function roundWinners(m) {
  const out = [];
  let prev = [0, 0];
  for (const r of (m && m.rounds) || []) {
    let w = r && (r.winnerTeamIndex === 0 || r.winnerTeamIndex === 1) ? r.winnerTeamIndex : -1;
    const sc = r && Array.isArray(r.score) && r.score.length >= 2 && Number.isFinite(r.score[0]) && Number.isFinite(r.score[1]) ? r.score : null;
    if (w < 0 && sc) {
      const d0 = sc[0] - prev[0], d1 = sc[1] - prev[1];
      if (d0 > 0 && d1 <= 0) w = 0; else if (d1 > 0 && d0 <= 0) w = 1;
    }
    if (sc) prev = sc;
    out.push(w);
  }
  return out;
}

function resultOf(m) { return m && (m.result === 'win' || m.result === 'loss' || m.result === 'draw') ? m.result : 'unknown'; }

// Edistyneet tilastot (r6-advanced): pelaajan tiivis `adv`-kenttä -> KOST-% tai null (vanha tallenne / TDM / ei kierroksia).
function kostOf(p) {
  const a = p && p.adv;
  return advanced.isAdv(a) ? advanced.finalize(a).kost : null;
}

// Omat tiedot yhdestÃ¤ ottelusta (tai null, jos et ole mukana).
function ownEntry(m, ownId) {
  const p = ownPlayer(m, ownId);
  if (!p) return null;
  const kills = nz(p.kills), deaths = nz(p.deaths);
  return {
    name: m.name, ts: tsOf(m), result: resultOf(m), kills, deaths, assists: nz(p.assists), headshots: nz(p.headshots),
    rounds: nz(p.roundsPlayed), kd: kdOf(kills, deaths), hsPercent: hsOf(nz(p.headshots), kills), kost: kostOf(p),
    map: m.map ? m.map.name : '', mapId: m.map ? m.map.id : null, type: typeName(m),
    own: m.ownTeamIndex, score: Array.isArray(m.teams) ? m.teams.map((t) => nz(t && t.score)) : [0, 0],
  };
}

function streakOf(results) {
  const decided = (results || []).filter((r) => r.result !== 'unknown');
  if (!decided.length) return null;
  const last = decided[decided.length - 1].result;
  if (last === 'draw') return null;
  let count = 0;
  for (let i = decided.length - 1; i >= 0 && decided[i].result === last; i--) count++;
  return { type: last, count };
}

function rolling(results, kind) {
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const slice = results.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1);
    if (slice.length < MIN_ROLLING) continue;
    let value;
    if (kind === 'winrate') {
      const dec = slice.filter((r) => r.result !== 'unknown');
      if (!dec.length) continue;
      value = (dec.filter((r) => r.result === 'win').length / dec.length) * 100;
    } else {
      value = kdOf(slice.reduce((a, r) => a + r.kills, 0), slice.reduce((a, r) => a + r.deaths, 0));
    }
    out.push({ i: i + 1, ts: results[i].ts, value: round2(value) });
  }
  return out;
}

// Omat kokonaisluvut. opts: { matchType: 'all'|'ranked'|'unranked'|'quick', excludeName } (excludeName = kÃ¤ynnissÃ¤ oleva ottelu).
function aggregateOwn(matches, ownId, opts = {}) {
  const filter = MATCH_FILTERS.includes(opts.matchType) ? opts.matchType : 'all';
  const all = sortChrono(matches).filter((m) => ownPlayer(m, ownId) && m.name !== opts.excludeName);
  const typeCounts = { all: all.length, ranked: 0, unranked: 0, quick: 0 };
  for (const m of all) { const k = typeKey(m); if (k in typeCounts) typeCounts[k]++; }
  const list = all.filter((m) => matchesFilter(m, filter));

  const out = {
    filter, typeCounts, matches: list.length, wins: 0, losses: 0, draws: 0, unknown: 0, winrate: null,
    kills: 0, deaths: 0, assists: 0, headshots: 0, rounds: 0, kd: 0, hsPercent: 0, kpr: 0,
    attack: { played: 0, won: 0, winrate: null }, defense: { played: 0, won: 0, winrate: null },
    streak: null, last10: { games: 0, wins: 0, winrate: null },
    series: { winrate: [], kd: [], kost: [] }, maps: [], operators: [], bestKills: null, bestKd: null, lastTs: null,
    adv: null, advMatches: 0,
  };
  const results = [];
  const advList = [];
  const maps = new Map();
  const ops = new Map();
  for (const m of list) {
    const e = ownEntry(m, ownId);
    results.push(e);
    const ownAdv = ownPlayer(m, ownId).adv;
    if (advanced.isAdv(ownAdv)) {
      advList.push(ownAdv);
      out.series.kost.push({ i: results.length, ts: e.ts, value: e.kost, name: e.name, map: e.map });
    }
    out.kills += e.kills; out.deaths += e.deaths; out.assists += e.assists; out.headshots += e.headshots; out.rounds += e.rounds;
    if (e.result === 'win') out.wins++; else if (e.result === 'loss') out.losses++; else if (e.result === 'draw') out.draws++; else out.unknown++;

    // Kierrokset hyÃ¶kkÃ¤ys/puolustus
    if (m.ownTeamIndex === 0 || m.ownTeamIndex === 1) {
      const wins = roundWinners(m);
      (m.rounds || []).forEach((r, i) => {
        const role = r && Array.isArray(r.teamRoles) ? r.teamRoles[m.ownTeamIndex] : '';
        const bucket = role === 'Attack' ? out.attack : role === 'Defense' ? out.defense : null;
        if (!bucket || wins[i] < 0) return;
        bucket.played++;
        if (wins[i] === m.ownTeamIndex) bucket.won++;
      });
    }

    // Kartta
    const mk = e.mapId != null ? `id:${e.mapId}` : `n:${e.map}`;
    const mp = maps.get(mk) || { name: e.map || 'â€“', id: e.mapId, matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0 };
    mp.matches++; mp.kills += e.kills; mp.deaths += e.deaths;
    if (e.result === 'win') mp.wins++; else if (e.result === 'loss') mp.losses++; else if (e.result === 'draw') mp.draws++;
    maps.set(mk, mp);

    // Operaattorit
    const p = ownPlayer(m, ownId);
    const stats = Array.isArray(p.opStats) && p.opStats.length ? p.opStats : (p.operators || []).map((o) => ({ name: o.name, role: o.role, rounds: o.rounds, kills: null, deaths: null, headshots: null }));
    for (const o of stats) {
      if (!o || !o.name) continue;
      const cur = ops.get(o.name) || { name: o.name, role: o.role || '', rounds: 0, kills: 0, deaths: 0, headshots: 0, hasStats: false };
      cur.rounds += nz(o.rounds);
      if (Number.isFinite(o.kills)) { cur.kills += o.kills; cur.deaths += nz(o.deaths); cur.headshots += nz(o.headshots); cur.hasStats = true; }
      if (!cur.role && o.role) cur.role = o.role;
      ops.set(o.name, cur);
    }

    if (!out.bestKills || e.kills > out.bestKills.kills) out.bestKills = e;
    if (e.rounds >= 2 && (!out.bestKd || e.kd > out.bestKd.kd || (e.kd === out.bestKd.kd && e.kills > out.bestKd.kills))) out.bestKd = e;
    out.lastTs = e.ts;
  }
  const decided = out.wins + out.losses + out.draws;
  out.winrate = decided > 0 ? round1((out.wins / decided) * 100) : null;
  out.kd = kdOf(out.kills, out.deaths);
  out.hsPercent = hsOf(out.headshots, out.kills);
  out.kpr = kprOf(out.kills, out.rounds);
  out.attack.winrate = ratio(out.attack.won, out.attack.played);
  out.defense.winrate = ratio(out.defense.won, out.defense.played);
  out.streak = streakOf(results);
  const l10 = results.filter((r) => r.result !== 'unknown').slice(-10);
  out.last10 = { games: l10.length, wins: l10.filter((r) => r.result === 'win').length, winrate: l10.length ? round1((l10.filter((r) => r.result === 'win').length / l10.length) * 100) : null };
  out.adv = advanced.finalize(advanced.sumAdv(advList));
  out.advMatches = advList.length;
  out.series.winrate = rolling(results, 'winrate');
  out.series.kd = results.map((r, i) => ({ i: i + 1, ts: r.ts, value: r.kd, name: r.name, map: r.map }));
  out.maps = Array.from(maps.values()).map((x) => ({
    ...x, winrate: ratio(x.wins, x.wins + x.losses + x.draws), kd: kdOf(x.kills, x.deaths),
  })).sort((a, b) => b.matches - a.matches || String(a.name).localeCompare(String(b.name)));
  out.operators = Array.from(ops.values()).map((x) => ({
    name: x.name, role: x.role, rounds: x.rounds, hasStats: x.hasStats,
    kills: x.hasStats ? x.kills : null, deaths: x.hasStats ? x.deaths : null, headshots: x.hasStats ? x.headshots : null,
    kd: x.hasStats ? kdOf(x.kills, x.deaths) : null, hsPercent: x.hasStats ? hsOf(x.headshots, x.kills) : null,
  })).sort((a, b) => b.rounds - a.rounds || String(a.name).localeCompare(String(b.name)));
  return out;
}

// ---- Pelaajaindeksi ---------------------------------------------------------------------------

const emptyRel = () => ({ matches: 0, wins: 0, losses: 0, draws: 0 });
function addRel(rel, result) {
  rel.matches++;
  if (result === 'win') rel.wins++; else if (result === 'loss') rel.losses++; else if (result === 'draw') rel.draws++;
}
function playerKey(p) {
  if (p && p.profileID) return p.profileID;
  return p && p.username ? `u:${String(p.username).toLowerCase()}` : '';
}

// Kaikki tallenteissa tavatut pelaajat. Wins/losses ovat SINUN nÃ¤kÃ¶kulmastasi (kanssa: tiimisi tulos, vastaan: sinun tuloksesi).
// opts: { excludeName } jÃ¤ttÃ¤Ã¤ yhden ottelun pois.
function buildPlayersIndex(matches, ownId, opts = {}) {
  const idx = new Map();
  for (const m of sortChrono(matches)) {
    if (m.name === opts.excludeName) continue;
    const ts = tsOf(m);
    const res = resultOf(m);
    for (const p of m.players || []) {
      const key = playerKey(p);
      if (!key) continue;
      let e = idx.get(key);
      if (!e) {
        e = {
          profileID: p.profileID || '', username: p.username || '', usernames: [], matches: 0, with: emptyRel(), against: emptyRel(),
          kills: 0, deaths: 0, assists: 0, headshots: 0, rounds: 0, lastSeen: 0, lastMatch: '', isOwn: !!ownId && p.profileID === ownId,
          advList: [],
        };
        idx.set(key, e);
      }
      e.matches++;
      if (advanced.isAdv(p.adv)) e.advList.push(p.adv);
      e.kills += nz(p.kills); e.deaths += nz(p.deaths); e.assists += nz(p.assists); e.headshots += nz(p.headshots); e.rounds += nz(p.roundsPlayed);
      if (ts >= e.lastSeen) { e.lastSeen = ts; e.lastMatch = m.name || ''; if (p.username) e.username = p.username; }
      if (p.username) {
        const i = e.usernames.indexOf(p.username);
        if (i >= 0) e.usernames.splice(i, 1);
        e.usernames.push(p.username); // kronologisessa kÃ¤sittelyssÃ¤ viimeisin lopussa
      }
      if (!e.isOwn && (m.ownTeamIndex === 0 || m.ownTeamIndex === 1) && (p.teamIndex === 0 || p.teamIndex === 1)) {
        addRel(p.teamIndex === m.ownTeamIndex ? e.with : e.against, res);
      }
    }
  }
  for (const e of idx.values()) {
    e.usernames.reverse(); // viimeisin ensin
    e.kd = kdOf(e.kills, e.deaths);
    e.hsPercent = hsOf(e.headshots, e.kills);
    e.kpr = kprOf(e.kills, e.rounds);
    e.adv = advanced.finalize(advanced.sumAdv(e.advList));
    e.kost = e.adv ? e.adv.kost : null;
    delete e.advList;
  }
  return idx;
}

// EpÃ¤tavallisten tilastojen arvio indeksin riville (herkkyys sovelletaan; 'off' -> null). match = { kills, headshots, rounds } valinnainen.
function suspicionOf(entry, sensitivity, match) {
  if (!entry) return null;
  return susp.evaluateR6Replay({
    matches: entry.matches, rounds: entry.rounds, kills: entry.kills, deaths: entry.deaths, headshots: entry.headshots, match: match || null,
  }, sensitivity || 'normal');
}

const SORTS = ['matches', 'last', 'kd', 'hs', 'kpr', 'kost', 'susp', 'name'];
// Pelaajalistan haku, lajittelu ja sivutus. opts: { search, sort, page, pageSize, flaggedOnly, sensitivity }
function listPlayers(index, opts = {}) {
  const search = String(opts.search || '').trim().toLowerCase();
  const sort = SORTS.includes(opts.sort) ? opts.sort : 'last';
  const pageSize = Math.max(1, Math.min(100, Number(opts.pageSize) || 50));
  const rows = [];
  for (const e of index.values()) {
    if (e.isOwn) continue;
    if (search && !e.usernames.some((u) => u.toLowerCase().includes(search))) continue;
    const suspicion = suspicionOf(e, opts.sensitivity);
    if (opts.flaggedOnly && !(suspicion && suspicion.level !== 'none')) continue;
    rows.push({ e, suspicion });
  }
  const levelRank = (s) => (s ? (s.level === 'suspicious' ? 2 : s.level === 'watch' ? 1 : 0) : 0);
  const cmp = {
    matches: (a, b) => b.e.matches - a.e.matches || b.e.lastSeen - a.e.lastSeen,
    last: (a, b) => b.e.lastSeen - a.e.lastSeen || b.e.matches - a.e.matches,
    kd: (a, b) => b.e.kd - a.e.kd || b.e.matches - a.e.matches,
    hs: (a, b) => b.e.hsPercent - a.e.hsPercent || b.e.matches - a.e.matches,
    kpr: (a, b) => b.e.kpr - a.e.kpr || b.e.matches - a.e.matches,
    kost: (a, b) => (b.e.kost == null ? -1 : b.e.kost) - (a.e.kost == null ? -1 : a.e.kost) || b.e.matches - a.e.matches, // ilman dataa viimeisenä
    susp: (a, b) => levelRank(b.suspicion) - levelRank(a.suspicion) || nz(b.suspicion && b.suspicion.score) - nz(a.suspicion && a.suspicion.score) || b.e.matches - a.e.matches,
    name: (a, b) => a.e.username.localeCompare(b.e.username, 'fi'),
  }[sort];
  rows.sort(cmp);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(pages, Number(opts.page) || 1));
  const flagged = { watch: rows.filter((r) => r.suspicion && r.suspicion.level === 'watch').length, suspicious: rows.filter((r) => r.suspicion && r.suspicion.level === 'suspicious').length };
  return {
    total, page, pages, pageSize, sort, flagged,
    players: rows.slice((page - 1) * pageSize, page * pageSize).map(({ e, suspicion }) => ({ ...e, suspicion })),
  };
}

// Yhden pelaajan ottelut (uusin ensin) omaa nÃ¤kÃ¶kulmaasi.
function playerMatches(matches, ownId, profileID) {
  const out = [];
  for (const m of sortChrono(matches)) {
    const p = (m.players || []).find((x) => playerKey(x) === profileID);
    if (!p) continue;
    const side = (m.ownTeamIndex === 0 || m.ownTeamIndex === 1) && (p.teamIndex === 0 || p.teamIndex === 1)
      ? (p.teamIndex === m.ownTeamIndex ? 'with' : 'against') : 'unknown';
    out.push({
      name: m.name, ts: tsOf(m), map: m.map ? m.map.name : '', type: typeName(m), result: resultOf(m), side,
      username: p.username || '', kills: nz(p.kills), deaths: nz(p.deaths), assists: nz(p.assists), headshots: nz(p.headshots),
      hsPercent: hsOf(nz(p.headshots), nz(p.kills)), kd: kdOf(nz(p.kills), nz(p.deaths)), rounds: nz(p.roundsPlayed),
      score: Array.isArray(m.teams) ? m.teams.map((t) => nz(t && t.score)) : [0, 0], ownTeamIndex: m.ownTeamIndex,
      // Pelaajan oma näkökulma: tulos, tiimin pisteet ensin, operaattorit ja pistetaulun pisteet.
      playerResult: playerResult(m, p), teamScore: playerScore(m, p), operators: operatorNames(p), points: nz(p.score),
      kost: kostOf(p), adv: advanced.finalize(p.adv),
    });
  }
  return out.reverse();
}

// Pelaajakohtaiset operaattoritilastot yhdestÃ¤ ottelusta rivien `stats` (kierroskohtaiset) tiedoista. rounds = parseMatchFolder().rounds.
function operatorStatsByPlayer(rounds) {
  const byUser = new Map();
  for (const rd of rounds || []) {
    const roleOf = new Map();
    for (const p of (rd && rd.players) || []) if (p && p.username && p.operator) roleOf.set(p.username, p.operator.role || '');
    for (const s of (rd && rd.stats) || []) {
      if (!s || !s.username || !s.operator) continue;
      const m = byUser.get(s.username) || new Map();
      const o = m.get(s.operator) || { name: s.operator, role: roleOf.get(s.username) || '', rounds: 0, kills: 0, deaths: 0, headshots: 0 };
      o.rounds++;
      o.kills += nz(s.kills);
      if (s.died) o.deaths++;
      o.headshots += nz(s.headshots);
      m.set(s.operator, o);
      byUser.set(s.username, m);
    }
  }
  const out = new Map();
  for (const [u, m] of byUser) out.set(u, Array.from(m.values()).sort((a, b) => b.rounds - a.rounds));
  return out;
}

// ---- Pelaajan näkökulma, edellinen ottelu ja pelaajaprofiili ------------------------------------

// Ottelun tulos pelaajan omasta näkökulmasta: 'win' | 'loss' | 'draw' | 'unknown'.
function playerResult(m, p) {
  if (!m || !p || (p.teamIndex !== 0 && p.teamIndex !== 1)) return 'unknown';
  if (m.winnerTeamIndex === 0 || m.winnerTeamIndex === 1) return m.winnerTeamIndex === p.teamIndex ? 'win' : 'loss';
  const own = m.ownTeamIndex;
  const r = resultOf(m);
  if ((own === 0 || own === 1) && (r === 'win' || r === 'loss')) return p.teamIndex === own ? r : (r === 'win' ? 'loss' : 'win');
  return r === 'draw' ? 'draw' : 'unknown';
}
// Pelaajan tiimin pisteet ensin: [oma tiimi, vastustaja].
function playerScore(m, p) {
  const sc = Array.isArray(m && m.teams) ? m.teams.map((t) => nz(t && t.score)) : [0, 0];
  const i = p && (p.teamIndex === 0 || p.teamIndex === 1) ? p.teamIndex : 0;
  return [sc[i] || 0, sc[1 - i] || 0];
}
function operatorNames(p) {
  const src = Array.isArray(p && p.opStats) && p.opStats.length ? p.opStats : ((p && p.operators) || []);
  return src.filter((o) => o && o.name).slice().sort((a, b) => nz(b.rounds) - nz(a.rounds)).slice(0, 4).map((o) => ({ name: o.name, rounds: nz(o.rounds) }));
}

// Edellinen ottelu: viimeisin ottelu, jossa olit mukana, ennen nykyistä. opts.live: nykyinen on käynnissä -> uusin muu ottelu.
function previousMatch(matches, current, ownId, opts = {}) {
  if (!current) return null;
  const others = sortChrono(matches).filter((m) => m.name !== current.name && (!ownId || ownPlayer(m, ownId)));
  if (opts.live) return others.length ? others[others.length - 1] : null;
  const ct = tsOf(current), cn = String(current.name || '');
  let best = null;
  for (const m of others) {
    const mt = tsOf(m);
    if (mt < ct || (mt === ct && String(m.name || '').localeCompare(cn) < 0)) best = m; else break;
  }
  return best;
}
// Map pelaajaavain -> 'with' | 'against' edellisessä ottelussa (oma pelaaja pois).
function previousEncounters(prev, ownId) {
  const out = new Map();
  if (!prev || (prev.ownTeamIndex !== 0 && prev.ownTeamIndex !== 1)) return out;
  for (const p of prev.players || []) {
    const key = playerKey(p);
    if (!key || (ownId && p.profileID === ownId) || (p.teamIndex !== 0 && p.teamIndex !== 1)) continue;
    out.set(key, p.teamIndex === prev.ownTeamIndex ? 'with' : 'against');
  }
  return out;
}
function previousInfo(prev) {
  if (!prev) return null;
  return { name: prev.name, ts: tsOf(prev), map: prev.map ? prev.map.name : '', type: typeName(prev), result: resultOf(prev) };
}

// Yhden pelaajan koko profiili: indeksirivi + ottelulista + operaattorit + kartat (kaikki tallenteistasi).
function buildPlayerProfile(matches, ownId, key) {
  const e = buildPlayersIndex(matches, ownId).get(key);
  if (!e) return null;
  const ops = new Map(), maps = new Map();
  for (const m of sortChrono(matches)) {
    const p = (m.players || []).find((x) => playerKey(x) === key);
    if (!p) continue;
    const src = Array.isArray(p.opStats) && p.opStats.length ? p.opStats : (p.operators || []).map((o) => ({ name: o.name, role: o.role, rounds: o.rounds, kills: null }));
    for (const o of src) {
      if (!o || !o.name) continue;
      const cur = ops.get(o.name) || { name: o.name, role: o.role || '', rounds: 0, kills: 0, deaths: 0, headshots: 0, hasStats: false };
      cur.rounds += nz(o.rounds);
      if (Number.isFinite(o.kills)) { cur.kills += o.kills; cur.deaths += nz(o.deaths); cur.headshots += nz(o.headshots); cur.hasStats = true; }
      ops.set(o.name, cur);
    }
    const mn = m.map ? m.map.name : '';
    const mp = maps.get(mn) || { name: mn || '–', matches: 0, wins: 0, losses: 0, kills: 0, deaths: 0 };
    mp.matches++; mp.kills += nz(p.kills); mp.deaths += nz(p.deaths);
    const r = playerResult(m, p);
    if (r === 'win') mp.wins++; else if (r === 'loss') mp.losses++;
    maps.set(mn, mp);
  }
  return {
    entry: e,
    operators: Array.from(ops.values()).map((x) => ({
      name: x.name, role: x.role, rounds: x.rounds, kills: x.hasStats ? x.kills : null, deaths: x.hasStats ? x.deaths : null,
      kd: x.hasStats ? kdOf(x.kills, x.deaths) : null, hsPercent: x.hasStats ? hsOf(x.headshots, x.kills) : null,
    })).sort((a, b) => b.rounds - a.rounds || String(a.name).localeCompare(String(b.name))),
    maps: Array.from(maps.values()).map((x) => ({ ...x, kd: kdOf(x.kills, x.deaths) })).sort((a, b) => b.matches - a.matches || String(a.name).localeCompare(String(b.name))),
    matchList: playerMatches(matches, ownId, key),
  };
}

module.exports = {
  playerResult, playerScore, previousMatch, previousEncounters, previousInfo, buildPlayerProfile, playerKey,
  MATCH_FILTERS, SORTS, typeKey, matchesFilter, sortChrono, ownPlayer, ownEntry, roundWinners, aggregateOwn, buildPlayersIndex,
  suspicionOf, listPlayers, playerMatches, operatorStatsByPlayer, kdOf, hsOf, kprOf, tsOf, wallTs, typeName, resultOf, kostOf,
};
