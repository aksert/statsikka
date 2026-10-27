'use strict';
// Rocket League Stats API: viestien jäsennys, ottelun seuranta, historia ja koonnit.
// Puhdasta logiikkaa (ei electron-riippuvuuksia) -> testattavissa selftest.js:llä.

const UU_TO_KMH = 0.036;

// ---- Nimitaulukot -------------------------------------------------------

const ARENAS = {
  stadium_p: 'DFH Stadium', stadium_day_p: 'DFH Stadium (päivä)', stadium_foggy_p: 'DFH Stadium (sumu)',
  stadium_winter_p: 'Snowy DFH Stadium', stadium_race_day_p: 'DFH Stadium (Circuit)',
  park_p: 'Beckwith Park', park_night_p: 'Beckwith Park (yö)', park_rainy_p: 'Beckwith Park (sade)',
  utopiastadium: 'Utopia Coliseum', utopiastadium_p: 'Utopia Coliseum', utopiastadium_dusk_p: 'Utopia Coliseum (ilta)',
  utopiastadium_snow_p: 'Utopia Coliseum (lumi)',
  cs_p: 'Champions Field', cs_day_p: 'Champions Field (päivä)', cs_hw_p: 'Rivals Arena',
  eurostadium_p: 'Mannfield', eurostadium_night_p: 'Mannfield (yö)', eurostadium_rainy_p: 'Mannfield (sade)',
  eurostadium_snownight_p: 'Mannfield (lumiyö)',
  neotokyo_p: 'Neo Tokyo', neotokyo_standard_p: 'Neo Tokyo',
  wasteland_p: 'Wasteland', wasteland_night_p: 'Wasteland (yö)', wasteland_s_p: 'Wasteland',
  underwater_p: 'AquaDome', trainstation_p: 'Urban Central', trainstation_night_p: 'Urban Central (yö)',
  farm_p: 'Farmstead', farm_night_p: 'Farmstead (yö)', beach_p: 'Salty Shores', beach_night_p: 'Salty Shores (yö)',
  hoopsstadium_p: 'Dunk House', throwbackstadium_p: 'Throwback Stadium', arc_p: 'Starbase ARC',
  arc_standard_p: 'Starbase ARC', outlaw_p: 'Deadeye Canyon', woods_p: 'Forbidden Temple',
  shattershot_p: 'Shattershot', labs_circle_p: 'Cosmic', labs_cosmic_p: 'Cosmic', labs_doublegoal_p: 'Double Goal',
  labs_octagon_p: 'Octagon', labs_underpass_p: 'Underpass', labs_utopia_p: 'Utopia Retro',
  sovereignheights_p: 'Sovereign Heights', tokyounderpass_p: 'Tokyo Underpass',
};

const PLAYLISTS = {
  1: 'Kaksintaistelu (Casual)', 2: 'Tuplat (Casual)', 3: 'Standard (Casual)', 4: 'Chaos (Casual)',
  6: 'Yksityisottelu', 7: 'Kausi', 8: 'Offline-kausi', 9: 'Jaettu ruutu',
  10: 'Kaksintaistelu (Ranked)', 11: 'Tuplat (Ranked)', 12: 'Solo Standard (Ranked)', 13: 'Standard (Ranked)',
  14: 'Mutator Mashup', 15: 'Snow Day (Casual)', 16: 'Rocket Labs', 17: 'Hoops (Casual)', 18: 'Rumble (Casual)',
  19: 'Workshop', 22: 'Turnaus', 23: 'Dropshot (Casual)', 24: 'Paikallinen ottelu',
  27: 'Hoops (Ranked)', 28: 'Rumble (Ranked)', 29: 'Dropshot (Ranked)', 30: 'Snow Day (Ranked)',
  31: 'Ghost Hunt', 32: 'Beach Ball', 33: 'Spike Rush', 34: 'Turnausottelu', 35: 'Rocket Labs', 37: 'Dropshot Rumble',
  38: 'Heatseeker', 41: 'Boomer', 43: 'Heatseeker Doubles', 44: 'Winter Breakaway', 46: 'Gridiron',
  47: 'Super Cube', 48: 'Spooky Cube',
};

function arenaName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const k = raw.toLowerCase();
  return ARENAS[k] || ARENAS[k.replace(/_p$/, '') + '_p'] || raw;
}

function playlistName(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || id === null || id === undefined) return '';
  return PLAYLISTS[n] || `Playlist ${n}`;
}

function platformOf(primaryId) {
  const p = String(primaryId || '').split('|')[0].toLowerCase();
  if (p === 'steam') return 'Steam';
  if (p === 'epic') return 'Epic';
  if (p === 'ps4' || p === 'ps5' || p === 'playstation' || p === 'psn') return 'PlayStation';
  if (p === 'xboxone' || p === 'xbox' || p === 'xbl') return 'Xbox';
  if (p === 'switch' || p === 'nintendo') return 'Switch';
  return p ? p : '?';
}

// ---- Viestien jäsennys --------------------------------------------------

// Yksi kehys voi sisältää useita peräkkäisiä JSON-objekteja. Palauttaa taulukon {Event, Data}.
function splitJsonObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
      }
    }
  }
  return out;
}

function parseFrames(raw) {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  const msgs = [];
  const push = (o) => {
    if (!o || typeof o !== 'object' || typeof o.Event !== 'string') return;
    let data = o.Data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { /* jätä merkkijonoksi */ } }
    msgs.push({ Event: o.Event, Data: data && typeof data === 'object' ? data : {} });
  };
  try {
    const one = JSON.parse(text);
    if (Array.isArray(one)) one.forEach(push); else push(one);
    return msgs;
  } catch (_) { /* yritä pilkkoa */ }
  for (const part of splitJsonObjects(text)) {
    try { push(JSON.parse(part)); } catch (_) { /* ohita rikkinäinen */ }
  }
  return msgs;
}

// ---- Oma pelaaja --------------------------------------------------------

function samePlayer(p, own) {
  if (!p || !own) return false;
  if (own.id && p.primaryId && p.primaryId === own.id) return true;
  if (own.name && p.name && String(p.name).trim().toLowerCase() === String(own.name).trim().toLowerCase()) return true;
  return false;
}
function findOwn(players, own) {
  if (!own || (!own.name && !own.id)) return null;
  // PrimaryId on ensisijainen
  if (own.id) { const byId = players.find((p) => p.primaryId === own.id); if (byId) return byId; }
  return players.find((p) => samePlayer(p, { name: own.name })) || null;
}

// ---- Ottelutietue -------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normPlayer(p) {
  return {
    name: String(p.Name ?? ''),
    primaryId: String(p.PrimaryId ?? ''),
    teamNum: num(p.TeamNum),
    score: num(p.Score), goals: num(p.Goals), assists: num(p.Assists), saves: num(p.Saves),
    shots: num(p.Shots), demos: num(p.Demos), touches: num(p.Touches),
  };
}

function resolveWinner(game, hint) {
  if (hint === 0 || hint === 1) return hint;
  const teams = (game && game.Teams) || [];
  const w = game && game.Winner;
  if (w === 0 || w === 1) return w;
  if (typeof w === 'string' && w) {
    const t = teams.find((x) => String(x.Name).toLowerCase() === w.toLowerCase());
    if (t) return num(t.TeamNum);
    if (/^[01]$/.test(w)) return Number(w);
  }
  if (teams.length === 2 && num(teams[0].Score) !== num(teams[1].Score)) {
    return num(teams[0].Score) > num(teams[1].Score) ? num(teams[0].TeamNum) : num(teams[1].TeamNum);
  }
  return null;
}

function buildRecord(guid, data, winnerHint, endedAt) {
  const game = data.Game || {};
  const teams = (game.Teams || []).map((t) => ({ teamNum: num(t.TeamNum), name: String(t.Name ?? ''), score: num(t.Score) }));
  return {
    guid,
    endedAt: endedAt || new Date().toISOString(),
    playlistId: game.PlaylistId ?? null,
    arena: game.Arena || '',
    overtime: !!game.bOvertime,
    winnerTeamNum: resolveWinner(game, winnerHint),
    teams,
    players: (data.Players || []).map(normPlayer),
  };
}

// ---- Tracker ------------------------------------------------------------

const FEED_MAX = 30;

class RlTracker {
  constructor({ getOwn, history = [], onMatchStored, onChange, now = () => Date.now() } = {}) {
    this.getOwn = getOwn || (() => null);
    this.history = history;
    this.onMatchStored = onMatchStored || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.feedId = 0;
    this.resetMatch();
  }

  resetMatch() {
    this.guid = null;
    this.last = null;        // viimeisin UpdateState
    this.lastLive = null;    // viimeisin ei-replay UpdateState
    this.stored = false;
    this.active = false;
    this.feed = [];
    this.clock = null;       // { timeSeconds, overtime } ClockUpdatedSeconds-viesteistä
  }

  get hasMatch() { return this.active && !!this.last; }

  ensureGuid(d) {
    const g = d && d.MatchGuid;
    if (g) this.guid = String(g);
    else if (!this.guid) this.guid = `local-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  pushFeed(item) {
    this.feed.unshift({ id: ++this.feedId, ...item });
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }

  handle(msg) {
    if (!msg || typeof msg.Event !== 'string') return;
    const d = msg.Data || {};
    try {
      switch (msg.Event) {
        case 'MatchCreated':
        case 'MatchInitialized':
          if (msg.Event === 'MatchCreated' || this.stored) this.resetMatch();
          this.active = true;
          this.ensureGuid(d);
          break;
        case 'UpdateState':
          if (!this.active) { this.active = true; }
          this.ensureGuid(d);
          this.last = d;
          if (!(d.Game && d.Game.bReplay)) this.lastLive = d;
          this.clock = null;
          break;
        case 'ClockUpdatedSeconds':
          this.clock = { timeSeconds: num(d.TimeSeconds), overtime: !!d.bOvertime };
          break;
        case 'GoalScored':
          this.pushFeed({
            kind: 'goal',
            clock: this.currentClock(),
            player: d.Scorer ? d.Scorer.Name : '',
            teamNum: d.Scorer ? num(d.Scorer.TeamNum) : null,
            assister: d.Assister && d.Assister.Name ? d.Assister.Name : '',
            speedKmh: Math.round(num(d.GoalSpeed) * UU_TO_KMH),
          });
          break;
        case 'StatfeedEvent': {
          const en = String(d.EventName || d.Type || '');
          const kind = en === 'Save' ? 'save' : en === 'EpicSave' ? 'epicsave' : (en === 'Demolish' || en === 'Demolition') ? 'demo' : null;
          if (kind) {
            const t = d.MainTarget || {};
            const v = d.SecondaryTarget || {};
            this.pushFeed({ kind, clock: this.currentClock(), player: t.Name || '', teamNum: t.TeamNum != null ? num(t.TeamNum) : null, victim: v.Name || '' });
          }
          break;
        }
        case 'MatchEnded':
          this.ensureGuid(d);
          this.storeMatch(d.WinnerTeamNum);
          break;
        case 'MatchDestroyed':
          if (!this.stored && this.lastLive && this.lastLive.Game && this.lastLive.Game.bHasWinner) this.storeMatch(undefined);
          this.resetMatch();
          break;
        default:
          break; // tuntemattomat tapahtumat ohitetaan
      }
    } catch (e) {
      // Yksittäinen viallinen viesti ei saa kaataa seurantaa.
    }
    this.onChange(msg.Event);
  }

  currentClock() {
    if (this.clock) return this.clock;
    const g = this.last && this.last.Game;
    return g ? { timeSeconds: num(g.TimeSeconds), overtime: !!g.bOvertime } : null;
  }

  storeMatch(winnerHint) {
    if (this.stored) return null;
    const snap = this.lastLive || this.last;
    if (!snap || !snap.Players || snap.Players.length === 0) return null;
    this.stored = true;
    const guid = this.guid || `local-${this.now().toString(36)}`;
    if (this.history.some((m) => m.guid === guid)) return null; // ei kaksoiskappaleita
    const rec = buildRecord(guid, snap, winnerHint, new Date(this.now()).toISOString());
    this.history.push(rec);
    this.onMatchStored(rec);
    return rec;
  }

  // Koko live-tila renderöijälle.
  snapshot() {
    const own = this.getOwn();
    let match = null;
    if (this.hasMatch) {
      const d = this.last;
      const g = d.Game || {};
      const clock = this.clock || { timeSeconds: num(g.TimeSeconds), overtime: !!g.bOvertime };
      const players = (d.Players || []).map(normPlayer);
      const ownP = findOwn(players, own);
      const key = `${this.history.length}|${own ? own.name : ''}|${own ? own.id : ''}`;
      if (!this._idx || this._idx.key !== key) this._idx = { key, index: buildEncounterIndex(this.history, own) };
      const index = this._idx.index;
      const pkey = `${this.history.length}|${this.guid}|${own ? own.name : ''}|${own ? own.id : ''}`;
      if (!this._prev || this._prev.key !== pkey) this._prev = { key: pkey, prev: previousRlMatch(this.history, own, this.guid) };
      const prev = this._prev.prev;
      // Pelaajan oma historia (keskiarvot, voitto-%): indeksi ilman parhaillaan näkyvää ottelua, jotta live-ottelu ei laske itseään aiemmaksi.
      const hkey = `${this.history.length}|${this.guid}|${own ? own.name : ''}|${own ? own.id : ''}`;
      if (!this._hidx || this._hidx.key !== hkey) this._hidx = { key: hkey, index: buildRlPlayerIndex(this.history, own, this.guid) };
      const hidx = this._hidx.index;
      match = {
        guid: this.guid,
        arena: g.Arena || '',
        arenaName: arenaName(g.Arena),
        playlistId: g.PlaylistId ?? null,
        playlistName: playlistName(g.PlaylistId),
        timeSeconds: clock.timeSeconds,
        overtime: clock.overtime || !!g.bOvertime,
        replay: !!g.bReplay,
        hasWinner: !!g.bHasWinner,
        winnerTeamNum: g.bHasWinner ? resolveWinner(g, undefined) : null,
        teams: (g.Teams || []).map((t) => ({ teamNum: num(t.TeamNum), name: String(t.Name ?? ''), score: num(t.Score) })),
        prevMatch: prev ? { guid: prev.guid, endedAt: prev.endedAt, arenaName: prev.arenaName, playlistName: prev.playlistName, result: prev.result } : null,
        players: players.map((p) => ({
          ...p,
          key: rlKey(p),
          platform: platformOf(p.primaryId),
          isOwn: !!ownP && p === ownP,
          sameTeamAsOwn: ownP ? p.teamNum === ownP.teamNum : null,
          encounter: ownP && p !== ownP ? (index.get(p.name.toLowerCase()) || null) : null,
          hist: p === ownP ? null : liveHist(hidx.get(rlKey(p))),
          prev: prev && ownP && p !== ownP ? (prev.sides.get(rlKey(p)) || null) : null,
        })),
      };
    }
    return { match, feed: this.feed.slice() };
  }
}

// ---- Historia: indeksit ja koonnit --------------------------------------

function ownTeamOf(rec, own) {
  const p = findOwn(rec.players || [], own);
  return p ? { player: p, teamNum: p.teamNum } : null;
}

// nimi (pienellä) -> { with:{games,wins}, against:{games,wins} }
function buildEncounterIndex(matches, own) {
  const idx = new Map();
  if (!own || (!own.name && !own.id)) return idx;
  for (const rec of matches) {
    const o = ownTeamOf(rec, own);
    if (!o) continue;
    for (const p of rec.players) {
      if (p === o.player) continue;
      const k = String(p.name).toLowerCase();
      if (!idx.has(k)) idx.set(k, { with: { games: 0, wins: 0 }, against: { games: 0, wins: 0 } });
      const e = idx.get(k);
      const bucket = p.teamNum === o.teamNum ? e.with : e.against;
      bucket.games++;
      if (rec.winnerTeamNum === o.teamNum) bucket.wins++;
    }
  }
  return idx;
}

function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function summarizeHistory(matches, own) {
  const s = {
    total: matches.length, counted: 0, unattributed: 0, wins: 0, losses: 0, winrate: null,
    goalsPerGame: null, savesPerGame: null, shotsPerGame: null, bestGame: null, mostGoals: null, mvps: 0,
  };
  let goals = 0, saves = 0, shots = 0;
  for (const rec of matches) {
    const o = ownTeamOf(rec, own);
    if (!o) { s.unattributed++; continue; }
    if (rec.winnerTeamNum !== 0 && rec.winnerTeamNum !== 1) { s.unattributed++; continue; }
    s.counted++;
    const p = o.player;
    const won = rec.winnerTeamNum === o.teamNum;
    if (won) s.wins++; else s.losses++;
    goals += p.goals; saves += p.saves; shots += p.shots;
    if (!s.bestGame || p.score > s.bestGame.score) s.bestGame = { score: p.score, goals: p.goals, guid: rec.guid, endedAt: rec.endedAt };
    if (!s.mostGoals || p.goals > s.mostGoals.goals) s.mostGoals = { goals: p.goals, guid: rec.guid, endedAt: rec.endedAt };
    if (won) {
      const best = Math.max(...rec.players.filter((x) => x.teamNum === o.teamNum).map((x) => x.score));
      if (p.score >= best) s.mvps++;
    }
  }
  if (s.counted > 0) {
    s.winrate = r2((s.wins / s.counted) * 100);
    s.goalsPerGame = r2(goals / s.counted);
    s.savesPerGame = r2(saves / s.counted);
    s.shotsPerGame = r2(shots / s.counted);
  }
  return s;
}

// Lisää näyttötiedot (areenan/playlistin nimet, alusta, oma pelaaja, tulos) otteluun.
function decorateMatch(rec, own) {
  const o = ownTeamOf(rec, own);
  let result = null;
  if (o && (rec.winnerTeamNum === 0 || rec.winnerTeamNum === 1)) result = rec.winnerTeamNum === o.teamNum ? 'win' : 'loss';
  return {
    ...rec,
    arenaName: arenaName(rec.arena),
    playlistName: playlistName(rec.playlistId),
    result,
    ownTeamNum: o ? o.teamNum : null,
    players: rec.players.map((p) => ({ ...p, key: rlKey(p), platform: platformOf(p.primaryId), isOwn: !!o && p === o.player })),
  };
}

// ---- Pelaajaindeksi, edellinen ottelu ja pelaajaprofiili ------------------------------------

// Pelaajan avain: PrimaryId (jos tunnettu), muuten nimi pienellä. Botit ("Unknown|...") käsitellään nimellä.
function rlKey(p) {
  const id = p && p.primaryId ? String(p.primaryId) : '';
  if (id && !/^unknown\|/i.test(id)) return id;
  return p && p.name ? `n:${String(p.name).toLowerCase()}` : '';
}
const emptySide = () => ({ games: 0, wins: 0, losses: 0 });
const winnerKnown = (rec) => rec.winnerTeamNum === 0 || rec.winnerTeamNum === 1;
function addSide(bucket, rec, teamNum) {
  bucket.games++;
  if (winnerKnown(rec)) { if (rec.winnerTeamNum === teamNum) bucket.wins++; else bucket.losses++; }
}

// avain -> yhteenveto kaikista tallennetuista otteluista (oma pelaaja pois). With/against ja W/L sinun näkökulmastasi.
// pw / pd: pelaajan omat voitot ja pelit, joissa voittaja on tiedossa (pelaajan oma voitto-%). excludeGuid: ohita tämä ottelu (parhaillaan näkyvä).
function buildRlPlayerIndex(matches, own, excludeGuid) {
  const idx = new Map();
  for (const rec of matches) {
    if (excludeGuid && rec.guid === excludeGuid) continue;
    const o = ownTeamOf(rec, own);
    const ts = Date.parse(rec.endedAt) || 0;
    for (const p of rec.players || []) {
      if (o && p === o.player) continue;
      const key = rlKey(p);
      if (!key) continue;
      let e = idx.get(key);
      if (!e) {
        e = { key, primaryId: p.primaryId || '', name: p.name, names: [], platform: platformOf(p.primaryId), games: 0, with: emptySide(), against: emptySide(),
          score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0, pw: 0, pd: 0, lastSeen: 0, best: null };
        idx.set(key, e);
      }
      e.games++;
      for (const f of ['score', 'goals', 'assists', 'saves', 'shots', 'demos', 'touches']) e[f] += num(p[f]);
      if (p.name) { const i = e.names.indexOf(p.name); if (i >= 0) e.names.splice(i, 1); e.names.unshift(p.name); e.name = e.names[0]; }
      if (winnerKnown(rec)) { e.pd++; if (rec.winnerTeamNum === p.teamNum) e.pw++; }
      if (ts >= e.lastSeen) e.lastSeen = ts;
      if (!e.best || p.score > e.best.score) e.best = { score: num(p.score), goals: num(p.goals), guid: rec.guid, endedAt: rec.endedAt };
      if (o) addSide(p.teamNum === o.teamNum ? e.with : e.against, rec, o.teamNum);
    }
  }
  return idx;
}

// Live-näkymän pelaajakohtainen historia indeksirivistä: pelit, kanssa/vastaan, keskiarvot per peli ja pelaajan oma voitto-% (null jos ei aiempia pelejä).
function liveHist(e) {
  if (!e || !e.games) return null;
  const avg = (f) => r2(e[f] / e.games);
  return {
    games: e.games, with: e.with, against: e.against,
    avg: { score: avg('score'), goals: avg('goals'), assists: avg('assists'), saves: avg('saves'), shots: avg('shots'), demos: avg('demos') },
    winrate: e.pd ? r2((e.pw / e.pd) * 100) : null, lastSeen: e.lastSeen,
  };
}

const RL_SORTS = ['games', 'with', 'against', 'last', 'name'];
function listRlPlayers(index, opts = {}) {
  const search = String(opts.search || '').trim().toLowerCase();
  const sort = RL_SORTS.includes(opts.sort) ? opts.sort : 'games';
  const pageSize = Math.max(1, Math.min(100, Number(opts.pageSize) || 50));
  let rows = Array.from(index.values());
  const knownTotal = rows.length;
  if (search) rows = rows.filter((e) => e.names.some((n) => n.toLowerCase().includes(search)));
  const cmp = {
    games: (a, b) => b.games - a.games || b.lastSeen - a.lastSeen,
    with: (a, b) => b.with.games - a.with.games || b.games - a.games,
    against: (a, b) => b.against.games - a.against.games || b.games - a.games,
    last: (a, b) => b.lastSeen - a.lastSeen || b.games - a.games,
    name: (a, b) => String(a.name).localeCompare(String(b.name), 'fi'),
  }[sort];
  rows.sort(cmp);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(pages, Number(opts.page) || 1));
  return { total, knownTotal, page, pages, pageSize, sort, players: rows.slice((page - 1) * pageSize, page * pageSize) };
}

// Edellinen tallennettu ottelu, jossa olit mukana (currentGuid = parhaillaan näkyvä ottelu, joka voi jo olla tallennettu).
function previousRlMatch(matches, own, currentGuid) {
  for (let i = matches.length - 1; i >= 0; i--) {
    const rec = matches[i];
    if (currentGuid && rec.guid === currentGuid) continue;
    const o = ownTeamOf(rec, own);
    if (!o) continue;
    const sides = new Map();
    for (const p of rec.players || []) {
      if (p === o.player) continue;
      const k = rlKey(p);
      if (k) sides.set(k, p.teamNum === o.teamNum ? 'with' : 'against');
    }
    return {
      guid: rec.guid, endedAt: rec.endedAt, arenaName: arenaName(rec.arena), playlistName: playlistName(rec.playlistId),
      result: winnerKnown(rec) ? (rec.winnerTeamNum === o.teamNum ? 'win' : 'loss') : null, sides,
    };
  }
  return null;
}

// Yhden pelaajan profiili: indeksirivi, keskiarvot per peli ja ottelulista (uusin ensin, enintään limit; jokaisessa mukana koko ottelu laajennusta varten).
function rlPlayerProfile(matches, own, key, limit = 100) {
  const e = buildRlPlayerIndex(matches, own).get(key);
  if (!e) return null;
  const g = e.games || 1;
  const avg = (f) => r2(e[f] / g);
  const list = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const rec = matches[i];
    const p = (rec.players || []).find((x) => rlKey(x) === key);
    if (!p) continue;
    const o = ownTeamOf(rec, own);
    if (o && p === o.player) continue;
    list.push({
      guid: rec.guid, endedAt: rec.endedAt, arenaName: arenaName(rec.arena), playlistName: playlistName(rec.playlistId), overtime: !!rec.overtime,
      side: o ? (p.teamNum === o.teamNum ? 'with' : 'against') : 'unknown',
      result: winnerKnown(rec) ? (rec.winnerTeamNum === p.teamNum ? 'win' : 'loss') : null,
      yourResult: o && winnerKnown(rec) ? (rec.winnerTeamNum === o.teamNum ? 'win' : 'loss') : null,
      teamNum: p.teamNum, teams: (rec.teams || []).map((t) => ({ teamNum: t.teamNum, name: t.name, score: t.score })),
      stats: { score: num(p.score), goals: num(p.goals), assists: num(p.assists), saves: num(p.saves), shots: num(p.shots), demos: num(p.demos), touches: num(p.touches) },
      match: list.length < limit ? decorateMatch(rec, own) : null,
    });
  }
  return {
    key, primaryId: e.primaryId, name: e.name, names: e.names, platform: e.platform, games: e.games, with: e.with, against: e.against,
    averages: { score: avg('score'), goals: avg('goals'), assists: avg('assists'), saves: avg('saves'), shots: avg('shots'), demos: avg('demos') },
    winrate: e.pd ? r2((e.pw / e.pd) * 100) : null,
    totals: { score: e.score, goals: e.goals, assists: e.assists, saves: e.saves, shots: e.shots, demos: e.demos },
    best: e.best, lastSeen: e.lastSeen, matchList: list.slice(0, limit), matchTotal: list.length,
  };
}

// IPC-validointi (heittää ApiError BAD_INPUT)
function badInput(msg) { const { ApiError } = require('./http'); return new ApiError('BAD_INPUT', msg); }
function validateRlPlayerKey(k) {
  if (typeof k !== 'string' || k.length < 1 || k.length > 120 || /[\u0000-\u001f\u007f]/.test(k)) throw badInput('Virheellinen pelaajatunniste.');
  return k;
}
function validateRlPlayersArg(arg) {
  if (arg === undefined || arg === null) return { search: '', sort: 'games', page: 1, pageSize: 50 };
  if (typeof arg !== 'object' || Array.isArray(arg)) throw badInput('Virheellinen pyyntö.');
  for (const k of Object.keys(arg)) if (!['search', 'sort', 'page', 'pageSize'].includes(k)) throw badInput(`Tuntematon kenttä: ${k}.`);
  let search = '';
  if (arg.search !== undefined && arg.search !== null) {
    if (typeof arg.search !== 'string' || arg.search.length > 40) throw badInput('Hakusana on liian pitkä (enintään 40 merkkiä).');
    search = arg.search.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }
  const sort = arg.sort === undefined ? 'games' : arg.sort;
  if (!RL_SORTS.includes(sort)) throw badInput('Virheellinen lajittelu.');
  const int = (v, lo, hi, label, d) => {
    if (v === undefined || v === null) return d;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw badInput(`${label}: anna kokonaisluku ${lo}–${hi}.`);
    return v;
  };
  return { search, sort, page: int(arg.page, 1, 100000, 'Sivu', 1), pageSize: int(arg.pageSize, 1, 100, 'Sivukoko', 50) };
}

module.exports = {
  rlKey, buildRlPlayerIndex, listRlPlayers, previousRlMatch, rlPlayerProfile, validateRlPlayerKey, validateRlPlayersArg, RL_SORTS,
  UU_TO_KMH, arenaName, playlistName, platformOf, parseFrames, splitJsonObjects, findOwn, samePlayer,
  buildRecord, resolveWinner, RlTracker, buildEncounterIndex, summarizeHistory, decorateMatch,
};
