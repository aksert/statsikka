'use strict';
// Rainbow Six Siege: ottelutallenteet (Match Replay) -> tilastot. Ei Electron-riippuvuuksia (dialogi ja IPC ovat main.js:ssä),
// joten palvelu on testattavissa node:lla. Tallennettu historia (`r6-matches.json`) säilyy, vaikka peli poistaa vanhoja tallennekansioita.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJson } = require('./store');
const { ApiError } = require('./http');
const stats = require('./r6-stats');
const susp = require('./suspicion');
const advanced = require('./r6-advanced');

// Tallennusskeema: 2 = pelaajakohtaiset edistyneet tilastot (summary.players[].adv, r6-advanced.js). Vanhemmat tietueet jäsennetään
// uudelleen taustalla, jos ottelukansio on vielä olemassa; muuten adv jää puuttumaan (UI näyttää "–").
const STORE_VERSION = 3; // 3: Y11S3-defuserin tekijä (plantit/purut) -> vanhat tietueet jäsennetään uudelleen
const STORE_CAP = 5000;
const MATCH_END_MS = 3 * 60 * 1000;
const NAME_RE = /^Match-[A-Za-z0-9_.-]{1,100}$/;
const ID_RE = /^[\w.:-]{1,80}$/;

function bad(msg) { return new ApiError('BAD_INPUT', msg); }
function isObj(a) { return a && typeof a === 'object' && !Array.isArray(a); }
function onlyKeys(arg, allowed) {
  for (const k of Object.keys(arg)) if (!allowed.includes(k)) throw bad(`Tuntematon kenttä: ${k}.`);
}
function intIn(v, lo, hi, label, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw bad(`${label}: anna kokonaisluku ${lo}–${hi}.`);
  return v;
}

// ---- Syötteiden validointi (IPC) -----------------------------------------------------------------
function validateOwnArg(arg) {
  if (arg === undefined || arg === null) return { matchType: 'all' };
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  onlyKeys(arg, ['matchType']);
  const mt = arg.matchType === undefined ? 'all' : arg.matchType;
  if (!stats.MATCH_FILTERS.includes(mt)) throw bad('Virheellinen ottelutyyppi.');
  return { matchType: mt };
}
function validateMatchesArg(arg) {
  if (arg === undefined || arg === null) return { page: 1, pageSize: 25, matchType: 'all' };
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  onlyKeys(arg, ['page', 'pageSize', 'matchType']);
  const mt = arg.matchType === undefined ? 'all' : arg.matchType;
  if (!stats.MATCH_FILTERS.includes(mt)) throw bad('Virheellinen ottelutyyppi.');
  return { page: intIn(arg.page, 1, 100000, 'Sivu', 1), pageSize: intIn(arg.pageSize, 1, 100, 'Sivukoko', 25), matchType: mt };
}
function validateMatchName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('Virheellinen ottelun tunniste.');
  return name;
}
function validatePlayersArg(arg) {
  if (arg === undefined || arg === null) return { search: '', sort: 'last', page: 1, pageSize: 50, flaggedOnly: false };
  if (!isObj(arg)) throw bad('Virheellinen pyyntö.');
  onlyKeys(arg, ['search', 'sort', 'page', 'pageSize', 'flaggedOnly']);
  let search = '';
  if (arg.search !== undefined && arg.search !== null) {
    if (typeof arg.search !== 'string' || arg.search.length > 40) throw bad('Hakusana on liian pitkä (enintään 40 merkkiä).');
    search = arg.search.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }
  const sort = arg.sort === undefined ? 'last' : arg.sort;
  if (!stats.SORTS.includes(sort)) throw bad('Virheellinen lajittelu.');
  if (arg.flaggedOnly !== undefined && typeof arg.flaggedOnly !== 'boolean') throw bad('Virheellinen suodatin.');
  return { search, sort, page: intIn(arg.page, 1, 100000, 'Sivu', 1), pageSize: intIn(arg.pageSize, 1, 100, 'Sivukoko', 50), flaggedOnly: !!arg.flaggedOnly };
}
function validateProfileId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('Virheellinen pelaajatunniste.');
  return id;
}

// ---- Palvelu ------------------------------------------------------------------------------------
// deps: { dataDir, getSettings(), setSettings(patch), onChange(payload), lib (src/main/r6), now(), watcherOpts }
function createR6Service(deps) {
  const lib = deps.lib || require('./r6');
  const now = deps.now || Date.now;
  const file = path.join(deps.dataDir, 'r6-matches.json');
  const onChange = deps.onChange || (() => {});
  const onMatchStart = deps.onMatchStart || (() => {});

  const records = new Map(); // kansion nimi -> { v, sig, lastMtime, parsedAt, summary|null }
  let gen = 0;               // kasvaa jokaisella (uudelleen)käynnistyksellä; vanhentuneet työt keskeytyvät
  let dir = '';
  let dirSource = null;
  let scanning = null;       // { done, total } | null
  let scanPromise = null;
  let watcher = null;
  let watcherState = 'off';
  let activeName = null;     // käynnissä oleva ottelu (kansion nimi)
  let lastError = '';
  let cache = null;
  let rev = 0;
  let allCache = null;
  let queue = Promise.resolve();
  let saveTimer = null;
  let emitTimer = null;
  let ready = Promise.resolve();

  // ---- tallennus
  function loadStore() {
    const raw = readJson(file, null);
    if (!isObj(raw) || !isObj(raw.matches)) return;
    for (const [name, r] of Object.entries(raw.matches)) {
      if (!NAME_RE.test(name) || !isObj(r)) continue;
      const summary = isObj(r.summary) && Array.isArray(r.summary.players) ? r.summary : null;
      records.set(name, { v: Number(r.v) || 0, sig: String(r.sig || ''), lastMtime: Number(r.lastMtime) || 0, parsedAt: Number(r.parsedAt) || 0, summary });
    }
  }
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    let names = Array.from(records.keys()).sort();
    if (names.length > STORE_CAP) names = names.slice(names.length - STORE_CAP);
    const matches = {};
    for (const n of names) matches[n] = records.get(n);
    try { writeFileAtomic(file, JSON.stringify({ version: STORE_VERSION, matches })); } catch (e) { lastError = `Tallennus epäonnistui: ${e.message}`; }
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 400);
    if (saveTimer.unref) saveTimer.unref();
  }

  // ---- tilat ja ilmoitukset
  function matchCount() { let n = 0; for (const r of records.values()) if (r.summary) n++; return n; }
  function all() {
    if (!allCache) allCache = stats.sortChrono(Array.from(records.values()).map((r) => r.summary).filter(Boolean));
    return allCache;
  }
  function lastMatchTs() { const a = all(); return a.length ? stats.tsOf(a[a.length - 1]) : null; }
  function lite() {
    return { scanning: scanning ? { ...scanning } : null, matchCount: matchCount(), activeName, lastMatchTs: lastMatchTs(), rev, dir, watcher: watcherState };
  }
  function changed() {
    rev++; allCache = null;
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; try { onChange(lite()); } catch (_) { /* ei väliä */ } }, 150);
    if (emitTimer.unref) emitTimer.unref();
  }

  function ownId() {
    const a = all();
    for (let i = a.length - 1; i >= 0; i--) if (a[i].recordingProfileID && stats.ownPlayer(a[i], a[i].recordingProfileID)) return a[i].recordingProfileID;
    return '';
  }
  function ownName() {
    const id = ownId();
    if (!id) return '';
    const a = all();
    for (let i = a.length - 1; i >= 0; i--) { const p = stats.ownPlayer(a[i], id); if (p && p.username) return p.username; }
    return '';
  }
  // Täytä r6Name automaattisesti, jos se on tyhjä (ja käyttäjä ei ole kirjautunut ulos).
  function learnOwn() {
    const s = deps.getSettings();
    const nm = ownName();
    if (nm && !s.r6Name && s.r6AutoName !== false) {
      try { deps.setSettings({ r6Name: nm }); } catch (_) { /* ei väliä */ }
    }
  }

  // ---- jäsentäminen
  async function folderSig(folder) {
    let names = [];
    try { names = (await fs.promises.readdir(folder)).filter((n) => /\.rec$/i.test(n)).sort(); } catch (_) { return { sig: 'none', lastMtime: 0 }; }
    let max = 0, size = 0;
    for (const n of names) {
      try { const st = await fs.promises.stat(path.join(folder, n)); max = Math.max(max, st.mtimeMs); size += st.size; } catch (_) { /* katosi */ }
    }
    return { sig: `${names.length}:${Math.round(max)}:${size}`, lastMtime: Math.round(max) };
  }
  function toRecord(match, fs_) {
    const rec = { v: STORE_VERSION, sig: fs_.sig, lastMtime: fs_.lastMtime, parsedAt: now(), summary: null };
    if (!match || !match.summary) return rec;
    const s = JSON.parse(JSON.stringify(match.summary));
    s.name = match.name;
    const ops = stats.operatorStatsByPlayer(match.rounds);
    for (const p of s.players || []) { const o = ops.get(p.username); if (o) p.opStats = o; }
    s.parseErrors = (match.errors || []).length;
    try {
      const adv = advanced.matchAdv(match.rounds);
      if (adv) { s.advV = advanced.ADV_VERSION; for (const p of s.players || []) if (adv[p.username]) p.adv = adv[p.username]; }
    } catch (e) { lastError = `Edistyneiden tilastojen laskenta epäonnistui: ${e.message}`; }
    rec.summary = s;
    return rec;
  }
  async function ingest(match, folder) {
    const name = path.basename(folder);
    if (!NAME_RE.test(name)) return;
    const sig = await folderSig(folder);
    records.set(name, toRecord(match, sig));
    saveSoon();
    changed();
  }

  async function scan(myGen, force) {
    let folders = [];
    try { folders = await lib.listMatchFolders(dir); } catch (e) { lastError = `Kansiota ei voi lukea: ${e.message}`; return; }
    // backfill = vanhan skeeman tietueita, jotka jäsennetään uudelleen (edistyneet tilastot); UI näyttää etenemisen.
    const backfill = folders.filter((fo) => { const r = records.get(path.basename(fo)); return r && r.summary && r.v !== STORE_VERSION; }).length;
    scanning = { done: 0, total: folders.length, backfill };
    changed();
    for (let i = 0; i < folders.length; i++) {
      if (myGen !== gen) return;
      const folder = folders[i];
      const name = path.basename(folder);
      try {
        const fsig = await folderSig(folder);
        const rec = records.get(name);
        if (force || !rec || rec.sig !== fsig.sig || rec.v !== STORE_VERSION) {
          const match = await lib.parseMatchFolder(folder, { cache });
          if (myGen !== gen) return;
          records.set(name, toRecord(match, fsig));
          saveSoon();
        }
      } catch (e) {
        lastError = `Ottelun ${name} jäsennys epäonnistui: ${e.message}`;
      }
      scanning = { done: i + 1, total: folders.length, backfill };
      changed();
    }
    scanning = null;
    saveNow();
    learnOwn();
    changed();
  }

  function startWatcher(myGen) {
    watcher = lib.createWatcher(dir, { cache, ...(deps.watcherOpts || {}) });
    const run = (fn) => { queue = queue.then(() => (myGen === gen ? fn() : null)).catch((e) => { lastError = e.message; }); };
    watcher.on('round', (ev) => run(async () => {
      const name = path.basename(ev.dir);
      const fresh = !records.has(name); // uusi ottelukansio = ottelu alkoi (peli kirjoittaa R01:n 1. kierroksen lopussa)
      activeName = name;
      await ingest(ev.match, ev.dir);
      learnOwn();
      if (fresh) { try { onMatchStart(name); } catch (_) { /* ei väliä */ } }
    }));
    watcher.on('matchEnd', (ev) => run(async () => {
      await ingest(ev.match, ev.dir);
      if (activeName === path.basename(ev.dir)) activeName = null;
      learnOwn();
      changed();
    }));
    watcher.on('parseError', (ev) => { lastError = `Kierroksen ${ev.file || ''} jäsennys epäonnistui: ${ev.error && ev.error.message}`; });
    return watcher.start().then(() => { watcherState = 'watching'; changed(); }, (e) => { watcherState = 'error'; lastError = e.message; changed(); });
  }

  async function resolveDir() {
    const s = deps.getSettings();
    const saved = s.r6ReplayDir;
    if (saved) {
      try { if ((await fs.promises.stat(saved)).isDirectory()) return { dir: saved, source: 'setting' }; } catch (_) { /* putoa alemmas */ }
    }
    const found = await lib.findReplayDirs();
    if (!found.length) return { dir: '', source: null };
    const env = process.env.R6_REPLAY_DIR;
    const isEnv = env && path.resolve(env).toLowerCase() === path.resolve(found[0]).toLowerCase();
    return { dir: found[0], source: isEnv ? 'env' : 'auto' };
  }

  // Käynnistys: lukee tallennetun historian, skannaa kansion taustalla ja käynnistää tarkkailijan.
  function start(opts = {}) {
    stop(true);
    const myGen = ++gen;
    cache = new lib.ParseCache(40);
    if (!records.size) loadStore();
    allCache = null;
    ready = (async () => {
      const r = await resolveDir();
      if (myGen !== gen) return;
      dir = r.dir; dirSource = r.source;
      learnOwn();
      changed();
      if (!dir) return;
      scanPromise = scan(myGen, !!opts.force);
      await scanPromise;
      if (myGen !== gen) return;
      // Ei yritetä päätellä käynnissä olevaa ottelua, jos viimeisin tallenne on vanha.
      const a = all();
      const newest = a.length ? a[a.length - 1].name : null;
      const rec = newest ? records.get(newest) : null;
      activeName = rec && now() - rec.lastMtime < MATCH_END_MS ? newest : null;
      await startWatcher(myGen);
      // Skannauksen aikana kirjoitetut tiedostot: nopea toinen läpikäynti (muuttumattomat ohitetaan).
      if (myGen === gen) await scan(myGen, false);
      changed();
    })().catch((e) => { lastError = e.message; scanning = null; changed(); });
    return ready;
  }
  function stop(keepData) {
    gen++;
    if (watcher) { try { watcher.stop(); } catch (_) { /* ei väliä */ } watcher = null; }
    watcherState = 'off';
    scanning = null;
    if (saveTimer) saveNow();
    if (!keepData) { clearTimeout(emitTimer); emitTimer = null; }
  }
  function rescan() { return start({ force: true }); }

  // Valittu kansio: hyväksytään itse MatchReplay tai sen yläkansio. Palauttaa käytetyn polun.
  async function setDir(picked) {
    if (typeof picked !== 'string' || picked.length > 400) throw bad('Virheellinen kansio.');
    let target = picked;
    try { if (!(await fs.promises.stat(target)).isDirectory()) throw new Error('ei kansio'); } catch (_) { throw bad('Kansiota ei löydy.'); }
    let has = (await lib.listMatchFolders(target).catch(() => [])).length > 0;
    if (!has) {
      const sub = path.join(picked, 'MatchReplay');
      const n = await lib.listMatchFolders(sub).catch(() => []);
      if (n.length) { target = sub; has = true; }
    }
    if (!has) throw bad('Kansiosta ei löytynyt Match-kansioita. Valitse pelin MatchReplay-kansio.');
    deps.setSettings({ r6ReplayDir: target });
    await start();
    return target;
  }

  // ---- kyselyt
  function sensitivity() { return deps.getSettings().suspicionSensitivity; }
  function excludeActive() { return activeName; }

  function status() {
    const l = lite();
    return {
      dir: l.dir, dirSource, dirFound: !!l.dir, scanning: l.scanning, matchCount: l.matchCount, lastMatchTs: l.lastMatchTs,
      watcher: l.watcher, ownName: ownName(), active: !!activeName, error: lastError,
    };
  }

  function own(arg) {
    const v = validateOwnArg(arg);
    const id = ownId();
    return { ownName: ownName(), hasOwn: !!id, active: !!activeName, ...stats.aggregateOwn(all(), id, { matchType: v.matchType, excludeName: excludeActive() }) };
  }

  function listItem(m, id) {
    const e = stats.ownEntry(m, id);
    const oi = m.ownTeamIndex === 0 || m.ownTeamIndex === 1 ? m.ownTeamIndex : -1;
    const sc = (m.teams || []).map((t) => (t && Number.isFinite(t.score) ? t.score : 0));
    return {
      name: m.name, ts: stats.tsOf(m), map: m.map ? m.map.name : '', matchType: m.matchType ? m.matchType.name : '', gamemode: m.gamemode ? m.gamemode.name : '',
      score: oi >= 0 ? [sc[oi] || 0, sc[1 - oi] || 0] : [sc[0] || 0, sc[1] || 0], ownPerspective: oi >= 0,
      result: m.name === activeName ? 'live' : stats.resultOf(m), roundsParsed: m.roundsParsed || (m.rounds ? m.rounds.length : 0),
      own: e ? { kills: e.kills, deaths: e.deaths, assists: e.assists, kd: e.kd, hsPercent: e.hsPercent, rounds: e.rounds, kost: e.kost } : null,
      players: (m.players || []).length,
    };
  }
  function matches(arg) {
    const v = validateMatchesArg(arg);
    const id = ownId();
    const list = all().filter((m) => stats.matchesFilter(m, v.matchType)).slice().reverse();
    const pages = Math.max(1, Math.ceil(list.length / v.pageSize));
    const page = Math.min(v.page, pages);
    return { total: list.length, page, pages, pageSize: v.pageSize, active: activeName, items: list.slice((page - 1) * v.pageSize, page * v.pageSize).map((m) => listItem(m, id)) };
  }

  // Ottelun täysi näkymä: pelaajat historioineen ja arvioineen. Live-näkymä käyttää samaa rakennetta.
  function matchView(m, opts = {}) {
    const id = ownId();
    const sens = sensitivity();
    const idxAll = stats.buildPlayersIndex(all(), id);
    const idxPrior = stats.buildPlayersIndex(all(), id, { excludeName: m.name });
    // Edellinen ottelu (vain live-näkymä): kuka oli mukana kanssasi / vastaan.
    const prevM = opts.withPrev ? stats.previousMatch(all(), m, id, { live: m.name === activeName }) : null;
    const prevSides = stats.previousEncounters(prevM, id);
    const players = (m.players || []).map((p) => {
      const key = p.profileID || (p.username ? `u:${String(p.username).toLowerCase()}` : '');
      const isOwn = !!id && p.profileID === id;
      const prior = isOwn ? null : idxPrior.get(key);
      const total = idxAll.get(key);
      const hist = prior ? {
        matches: prior.matches, with: prior.with, against: prior.against, kd: prior.kd, hsPercent: prior.hsPercent, kpr: prior.kpr,
        kills: prior.kills, deaths: prior.deaths, rounds: prior.rounds, usernames: prior.usernames.filter((u) => u !== p.username).slice(0, 3),
      } : null;
      return {
        ...p, adv: advanced.finalize(p.adv), isOwn, hist, key, prev: isOwn ? null : (prevSides.get(key) || null),
        suspicion: isOwn || !total ? null : stats.suspicionOf(total, sens, { kills: p.kills, headshots: p.headshots, rounds: p.roundsPlayed }),
      };
    });
    const oi = m.ownTeamIndex === 0 || m.ownTeamIndex === 1 ? m.ownTeamIndex : -1;
    const hasScore = players.some((p) => Number(p.score) > 0), hasAssists = players.some((p) => Number(p.assists) > 0);
    return {
      name: m.name, ts: stats.tsOf(m), lastRoundTs: Date.parse(m.lastRoundTimestamp) || null, map: m.map || null, matchType: m.matchType || null,
      gamemode: m.gamemode || null, gameVersion: m.gameVersion || '', roundsPerMatch: m.roundsPerMatch || 0,
      roundsParsed: m.roundsParsed || (m.rounds ? m.rounds.length : 0), teams: m.teams || [], ownTeamIndex: oi,
      result: m.name === activeName ? 'live' : stats.resultOf(m), rounds: m.rounds || [], roundWinners: stats.roundWinners(m),
      hasScore, hasAssists, hasAdv: players.some((p) => !!p.adv), players, prevMatch: stats.previousInfo(prevM),
    };
  }
  function match(name) {
    validateMatchName(name);
    const rec = records.get(name);
    if (!rec || !rec.summary) throw new ApiError('NOT_FOUND', 'Ottelua ei löytynyt.');
    return matchView(rec.summary);
  }

  function live() {
    const a = all();
    const active = activeName ? a.find((m) => m.name === activeName) : null;
    const m = active || (a.length ? a[a.length - 1] : null);
    if (!m) return { hasData: false, active: false, match: null, dirFound: !!dir, scanning: scanning ? { ...scanning } : null };
    return { hasData: true, active: !!active, match: matchView(m, { withPrev: true }), dirFound: !!dir, scanning: scanning ? { ...scanning } : null };
  }

  function players(arg) {
    const v = validatePlayersArg(arg);
    const idx = stats.buildPlayersIndex(all(), ownId());
    const r = stats.listPlayers(idx, { ...v, sensitivity: sensitivity() });
    return {
      total: r.total, page: r.page, pages: r.pages, pageSize: r.pageSize, sort: r.sort, flagged: r.flagged, knownTotal: Array.from(idx.values()).filter((e) => !e.isOwn).length,
      players: r.players.map((e) => ({
        profileID: e.profileID || `u:${e.username.toLowerCase()}`, username: e.username, otherNames: e.usernames.filter((u) => u !== e.username).slice(0, 3),
        matches: e.matches, with: e.with, against: e.against, kills: e.kills, deaths: e.deaths, kd: e.kd, hsPercent: e.hsPercent, kpr: e.kpr,
        rounds: e.rounds, lastSeen: e.lastSeen, suspicion: e.suspicion, kost: e.kost, advRounds: e.adv ? e.adv.rounds : 0,
      })),
    };
  }
  function player(id) {
    validateProfileId(id);
    const prof = stats.buildPlayerProfile(all(), ownId(), id);
    if (!prof) throw new ApiError('NOT_FOUND', 'Pelaajaa ei löytynyt tallenteista.');
    const e = prof.entry;
    const sens = sensitivity();
    const list = prof.matchList.slice(0, 100).map((x) => {
      const r = susp.evaluateR6Replay({ match: { kills: x.kills, headshots: x.headshots, rounds: x.rounds } });
      return { ...x, unusual: r.reasons.some((q) => q.kind === 'singleMatch') };
    });
    return {
      profileID: e.profileID || id, key: id, username: e.username, usernames: e.usernames, matches: e.matches, with: e.with, against: e.against,
      kills: e.kills, deaths: e.deaths, assists: e.assists, headshots: e.headshots, rounds: e.rounds, kd: e.kd, hsPercent: e.hsPercent, kpr: e.kpr,
      lastSeen: e.lastSeen, isOwn: e.isOwn, suspicion: e.isOwn ? null : stats.suspicionOf(e, sens), matchList: list, matchTotal: prof.matchList.length,
      operators: prof.operators.slice(0, 12), maps: prof.maps.slice(0, 12), adv: e.adv,
    };
  }

  // ---- GEP-rosterin rikastus (live-näkymä ennen ensimmäisen kierroksen tallennetta ja sen jälkeen)
  // Pelaajat tunnistetaan player_id:llä (= tallenteen profileID), muuten nimellä. Historia lasketaan ilman käynnissä olevaa ottelua;
  // tallenteen kierrokset liitetään mukaan (replay: päänlaukaukset / HS-%), kun käynnissä oleva ottelu on jo tallentunut.
  let liveMemo = null;
  // sinceTs = GEP-ottelun alku. Käynnissä oleva tallenne kuuluu tähän otteluun vain, jos sen tiedostoja on kirjoitettu alun jälkeen
  // (muuten se on edellinen ottelu, jonka 3 min "käynnissä"-ikkuna ei ole vielä umpeutunut).
  function liveContext(sinceTs) {
    const id = ownId();
    const rec = activeName ? records.get(activeName) : null;
    const current = !!(rec && rec.summary && sinceTs > 0 && rec.lastMtime >= sinceTs - 5000);
    const exclude = current ? activeName : undefined;
    const memoKey = `${rev}|${exclude || ''}|${sensitivity()}`;
    if (liveMemo && liveMemo.key === memoKey) return liveMemo;
    const a = all();
    const prevM = stats.previousMatch(a, { name: exclude || '' }, id, { live: true });
    const act = current ? rec.summary : null;
    liveMemo = {
      key: memoKey, id, sens: sensitivity(), idxAll: stats.buildPlayersIndex(a, id), idxPrior: stats.buildPlayersIndex(a, id, { excludeName: exclude }),
      prevSides: stats.previousEncounters(prevM, id), prevMatch: stats.previousInfo(prevM), active: act,
    };
    return liveMemo;
  }
  function enrichLive(list, opts = {}) {
    const ctx = liveContext(Number(opts.since) || 0);
    const players = (Array.isArray(list) ? list : []).map((p) => {
      const key = p.playerId || (p.name ? `u:${String(p.name).toLowerCase()}` : '');
      const isOwn = !!p.isLocal || (!!ctx.id && p.playerId === ctx.id);
      const prior = isOwn || !key ? null : ctx.idxPrior.get(key);
      const total = isOwn || !key ? null : ctx.idxAll.get(key);
      const hist = prior ? {
        matches: prior.matches, with: prior.with, against: prior.against, kd: prior.kd, hsPercent: prior.hsPercent, kpr: prior.kpr,
        kills: prior.kills, deaths: prior.deaths, rounds: prior.rounds, usernames: prior.usernames.filter((u) => u !== p.name).slice(0, 3),
      } : null;
      const rp = ctx.active && p.playerId ? (ctx.active.players || []).find((x) => x.profileID === p.playerId) : null;
      const replay = rp ? { kills: rp.kills || 0, deaths: rp.deaths || 0, assists: rp.assists || 0, headshots: rp.headshots || 0, rounds: rp.roundsPlayed || 0, hsPercent: stats.hsOf(rp.headshots || 0, rp.kills || 0) } : null;
      return {
        ...p, key, isOwn, hist, replay, prev: isOwn ? null : (ctx.prevSides.get(key) || null), known: !!(hist && hist.matches),
        suspicion: isOwn || !total ? null : stats.suspicionOf(total, ctx.sens),
      };
    });
    return { players, prevMatch: ctx.prevMatch, activeName: ctx.active ? activeName : null };
  }

  loadStore();
  allCache = null;
  return {
    start, stop, rescan, setDir, status, own, matches, match, live, players, player, ownId, ownName, lite, enrichLive,
    whenReady: () => ready, records, flush: saveNow,
  };
}

module.exports = {
  createR6Service, validateOwnArg, validateMatchesArg, validateMatchName, validatePlayersArg, validateProfileId, STORE_VERSION, MATCH_END_MS,
};
