'use strict';
// Puhtaan logiikan testit: node scripts/selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ow = require('../src/main/providers/ow');
const rlIni = require('../src/main/providers/rl-ini');
const rl = require('../src/main/rl-core');
const { createHttp, ApiError } = require('../src/main/http');
const { sanitize, validate, createSettings } = require('../src/main/settings');
const P = require('../src/main/profile');
const S = require('../src/main/suspicion');

const FX = path.join(__dirname, '..', 'test', 'fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? ((e.name === 'AssertionError' ? e.message.slice(0, 700) + '\n       ' : '') + e.stack.split('\n').slice(0, 3).join('\n       ')) : e}`); }
  })());
}

// ---- BattleTag -----------------------------------------------------------
test('BattleTag: Name#1234 -> Name-1234', () => {
  assert.strictEqual(ow.battleTagToId('TeKrop#2217'), 'TeKrop-2217');
  assert.strictEqual(ow.battleTagToId(' TeKrop-2217 '), 'TeKrop-2217');
  assert.strictEqual(ow.battleTagToId('Nämä#12345'), 'Nämä-12345');
});
test('BattleTag: virheelliset hylätään', () => {
  for (const bad of ['', 'abc', 'a#1', 'Name#12', 'Na me#1234', 'Name#abcd', '../x#1234', 'Name#1234/../x', null, 5]) {
    assert.strictEqual(ow.battleTagToId(bad), null, String(bad));
  }
});
test('Pelaajaviite: hash-id hyväksytään, roskat ei', () => {
  assert.strictEqual(ow.normalizePlayerRef('c65b8798bc61d6ffbba120%7Ccfe9dd77a4382165e2b920bdcc035949'), 'c65b8798bc61d6ffbba120%7Ccfe9dd77a4382165e2b920bdcc035949');
  assert.strictEqual(ow.normalizePlayerRef('abc/../../etc'), null);
});

// ---- K/D -----------------------------------------------------------------
test('K/D: 2 desimaalia ja reunat', () => {
  assert.strictEqual(ow.kd(185, 140), 1.32);
  assert.strictEqual(ow.kd(10, 3), 3.33);
  assert.strictEqual(ow.kd(7, 0), 7);
  assert.strictEqual(ow.kd(0, 0), null);
  assert.strictEqual(ow.kd(undefined, 5), null);
});

// ---- OW-normalisointi oikeaa vastausta vasten ------------------------------
test('OW-profiili: normalisointi tallennetusta OverFast-vastauksesta', () => {
  const heroes = {};
  for (const x of fx('ow-heroes.json')) heroes[x.key] = { name: x.name, portrait: x.portrait, role: x.role };
  const p = ow.normalizeProfile({
    id: 'TeKrop-2217', summary: fx('ow-summary.json'), stats: fx('ow-stats-summary.json'), career: fx('ow-career.json'),
    heroMap: heroes, platform: 'pc', gamemode: 'competitive',
  });
  assert.strictEqual(p.name, 'TeKrop');
  assert.strictEqual(p.title, 'Data Broker');
  assert.strictEqual(p.endorsement.level, 2);
  assert.strictEqual(p.ranks.length, 1);
  assert.strictEqual(p.ranks[0].role, 'support');
  assert.strictEqual(p.ranks[0].division, 'silver');
  assert.strictEqual(p.ranks[0].tier, 4);
  assert.ok(!p.ranks[0].roleIcon.includes('#'), 'ikonin #icon-fragmentti poistettu');
  assert.strictEqual(p.bestRank.role, 'support');
  assert.strictEqual(p.season, 22);
  assert.ok(p.hasStats);
  assert.deepStrictEqual(
    { w: p.tiles.wins, l: p.tiles.losses, g: p.tiles.games, wr: p.tiles.winrate, kd: p.tiles.kd, kda: p.tiles.kda },
    { w: 6, l: 13, g: 19, wr: 31.58, kd: 1.32, kda: 1.71 });
  assert.strictEqual(p.tiles.mostElims, 19);
  assert.strictEqual(p.tiles.bestStreak, 9);
  assert.strictEqual(p.tiles.mostFinalBlows, 13);
  assert.strictEqual(p.roles.length, 2);
  assert.strictEqual(p.roles[0].role, 'support'); // eniten peliaikaa ensin
  assert.strictEqual(p.heroes[0].key, 'baptiste'); // 6056 s > ana 5363 s
  assert.strictEqual(p.heroes[0].name, 'Baptiste');
  assert.ok(p.heroes[0].portrait.startsWith('https://'));
  assert.strictEqual(p.heroes[1].key, 'ana');
});
test('OW-profiili: tyhjät tilastot ({}), konsolialustan sijoitukset puuttuvat', () => {
  const p = ow.normalizeProfile({ id: 'X-1234', summary: fx('ow-summary.json'), stats: {}, career: null, platform: 'console', isPublic: false });
  assert.strictEqual(p.hasStats, false);
  assert.strictEqual(p.isPrivate, true);
  assert.strictEqual(p.rankPlatform, 'pc'); // varalla toinen alusta
  assert.strictEqual(p.tiles, null);
});
test('Heron nimen kaunistus', () => {
  assert.strictEqual(ow.prettifyHero('wrecking-ball'), 'Wrecking Ball');
  assert.strictEqual(ow.prettifyHero('dva'), 'D.Va');
  assert.strictEqual(ow.prettifyHero('soldier-76'), 'Soldier: 76');
  assert.strictEqual(ow.prettifyHero('mei', { mei: { name: 'Mei' } }), 'Mei');
});

// ---- HTTP: välimuisti, 429, rajoitin --------------------------------------
function fakeRes(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body };
}
test('HTTP: välimuisti (5 min) ja inflight-yhdistäminen', async () => {
  let calls = 0; let t = 1000;
  const http = createHttp({ fetchImpl: async () => { calls++; return fakeRes(200, { a: 1 }); }, now: () => t });
  const [x, y] = await Promise.all([http.getJson('u'), http.getJson('u')]);
  assert.deepStrictEqual(x, { a: 1 }); assert.deepStrictEqual(y, { a: 1 });
  await http.getJson('u');
  assert.strictEqual(calls, 1);
  t += 5 * 60 * 1000 + 1;
  await http.getJson('u');
  assert.strictEqual(calls, 2);
});
test('HTTP: 404 -> NOT_FOUND', async () => {
  const http = createHttp({ fetchImpl: async () => fakeRes(404, { error: 'x' }) });
  await assert.rejects(http.getJson('u'), (e) => e instanceof ApiError && e.code === 'NOT_FOUND');
});
test('HTTP: 429 + Retry-After -> odottaa ja yrittää kerran uudelleen', async () => {
  let calls = 0; const waits = []; const notices = [];
  const http = createHttp({
    fetchImpl: async () => (++calls === 1 ? fakeRes(429, {}, { 'retry-after': '2' }) : fakeRes(200, { ok: true })),
    sleep: async (ms) => { waits.push(ms); }, onNotice: (n) => notices.push(n),
  });
  assert.deepStrictEqual(await http.getJson('u'), { ok: true });
  assert.deepStrictEqual(waits, [2000]);
  assert.strictEqual(notices[0].type, 'rate-limit');
  assert.strictEqual(calls, 2);
});
test('HTTP: toinen 429 -> RATE_LIMIT-virhe', async () => {
  const http = createHttp({ fetchImpl: async () => fakeRes(429, {}, { 'retry-after': '1' }), sleep: async () => {} });
  await assert.rejects(http.getJson('u'), (e) => e.code === 'RATE_LIMIT');
});
test('HTTP: rinnakkaisuus enintään 3', async () => {
  let active = 0, peak = 0;
  const http = createHttp({ fetchImpl: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return fakeRes(200, {}); } });
  await Promise.all(Array.from({ length: 10 }, (_, i) => http.getJson(`u${i}`)));
  assert.strictEqual(peak, 3);
});
test('HTTP: aikakatkaisu -> TIMEOUT', async () => {
  const http = createHttp({
    timeoutMs: 30,
    fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; rej(e); })),
  });
  await assert.rejects(http.getJson('u'), (e) => e.code === 'TIMEOUT');
});

// ---- ini-muokkaus ---------------------------------------------------------
test('ini: luo osion puuttuessa ja säilyttää muun sisällön', () => {
  const src = '[Other.Section]\r\nFoo=1\r\n; kommentti\r\n\r\n[Another]\r\nBar=2\r\n';
  const out = rlIni.applyIniValues(src, { PacketSendRate: 10, Port: 49123, WebPort: 49124 });
  assert.ok(out.startsWith(src.trimEnd()), 'alkuperäinen säilyy');
  assert.ok(out.includes('[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=10\r\nPort=49123\r\nWebPort=49124\r\n'));
  assert.deepStrictEqual(rlIni.readSectionValues(out), { PacketSendRate: '10', Port: '49123', WebPort: '49124' });
});
test('ini: päivittää olemassa olevat avaimet, lisää puuttuvat, ei kosketa muuta', () => {
  const src = '[A]\nX=1\n[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\n; huom\nport = 1111\n\n[B]\nPacketSendRate=99\n';
  const out = rlIni.applyIniValues(src, { PacketSendRate: 10, Port: 49123, WebPort: 49200 });
  const lines = out.split('\n');
  assert.ok(lines.includes('PacketSendRate=10'));
  assert.ok(lines.includes('Port=49123'));
  assert.ok(lines.includes('WebPort=49200'));
  assert.ok(!out.includes('port = 1111'));
  assert.ok(out.includes('; huom'));
  assert.ok(out.includes('[B]\nPacketSendRate=99'), 'toisen osion saman niminen avain ennallaan');
  assert.ok(out.indexOf('WebPort=49200') < out.indexOf('[B]'), 'uusi avain omassa osiossaan');
  assert.ok(!out.includes('\r'), 'LF säilyy');
});
test('ini: tyhjä tiedosto', () => {
  const out = rlIni.applyIniValues('', { WebPort: 49124 });
  assert.strictEqual(out, '[TAGame.MatchStatsExporter_TA]\r\nWebPort=49124\r\n');
});
test('ini: enableInstall väliaikaisessa kansiossa (varmuuskopio, Default -> TAStatsAPI)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  try {
    const cfg = path.join(tmp, 'TAGame', 'Config');
    fs.mkdirSync(cfg, { recursive: true });
    const def = path.join(cfg, 'DefaultStatsAPI.ini');
    fs.writeFileSync(def, '[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\nPort=49123\r\nWebPort=49124\r\n\r\n[Keep]\r\nA=B\r\n');
    assert.strictEqual(rlIni.inspectInstall(tmp).values.PacketSendRate, '0');
    const r = rlIni.enableInstall(tmp, 49150);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.file, def);
    assert.ok(fs.existsSync(def + '.bak'));
    assert.ok(fs.readFileSync(def + '.bak', 'utf8').includes('PacketSendRate=0'));
    const after = fs.readFileSync(def, 'utf8');
    assert.ok(after.includes('PacketSendRate=10') && after.includes('WebPort=49150') && after.includes('[Keep]\r\nA=B'));
    // TAStatsAPI.ini ensisijainen kun on olemassa
    const ta = path.join(cfg, 'TAStatsAPI.ini');
    fs.writeFileSync(ta, '[X]\r\nY=1\r\n');
    const r2 = rlIni.enableInstall(tmp, 49124);
    assert.strictEqual(r2.file, ta);
    assert.ok(fs.readFileSync(ta, 'utf8').includes('[X]\r\nY=1'));
    // ei kelvollinen kansio
    assert.strictEqual(rlIni.enableInstall(path.join(tmp, 'nope'), 49124).ok, false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('ini: UTF-16 LE -tiedosto säilyttää koodauksen', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  try {
    const cfg = path.join(tmp, 'TAGame', 'Config'); fs.mkdirSync(cfg, { recursive: true });
    const f = path.join(cfg, 'DefaultStatsAPI.ini');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[Z]\r\nQ=1\r\n', 'utf16le')]));
    assert.ok(rlIni.enableInstall(tmp, 49124).ok);
    const raw = fs.readFileSync(f);
    assert.strictEqual(raw[0], 0xff); assert.strictEqual(raw[1], 0xfe);
    assert.ok(raw.slice(2).toString('utf16le').includes('WebPort=49124'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('Steam libraryfolders.vdf -jäsennys', () => {
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"E:\\\\Games\\\\SteamLib"\n\t}\n}\n';
  assert.deepStrictEqual(rlIni.parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'E:\\Games\\SteamLib']);
});

// ---- RL: viestien jäsennys -----------------------------------------------
test('RL: usea JSON-objekti yhdessä kehyksessä ja rikkinäinen osa', () => {
  const a = JSON.stringify({ Event: 'RoundStarted', Data: { MatchGuid: 'g' } });
  const b = JSON.stringify({ Event: 'ClockUpdatedSeconds', Data: { TimeSeconds: 12, bOvertime: false, s: 'a}{b' } });
  assert.deepStrictEqual(rl.parseFrames(a + b + '{"Event":').map((m) => m.Event), ['RoundStarted', 'ClockUpdatedSeconds']);
  assert.strictEqual(rl.parseFrames(a + '\n' + b).length, 2);
  assert.deepStrictEqual(rl.parseFrames('ei json'), []);
  assert.strictEqual(rl.parseFrames(JSON.stringify({ Event: 'X', Data: JSON.stringify({ k: 1 }) }))[0].Data.k, 1);
});
test('RL: nimitaulukot ja alusta', () => {
  assert.strictEqual(rl.arenaName('Stadium_P'), 'DFH Stadium');
  assert.strictEqual(rl.arenaName('SomeNewMap_P'), 'SomeNewMap_P');
  assert.strictEqual(rl.playlistName(13), 'Standard (Ranked)');
  assert.strictEqual(rl.playlistName(999), 'Playlist 999');
  assert.strictEqual(rl.platformOf('Steam|123|0'), 'Steam');
  assert.strictEqual(rl.platformOf('Epic|abc|0'), 'Epic');
  assert.strictEqual(rl.platformOf('PS5|x|0'), 'PlayStation');
});

// ---- RL: historia ja koonti ----------------------------------------------
function pl(name, id, team, score, goals, shots, assists, saves) {
  return { Name: name, PrimaryId: id, TeamNum: team, Score: score, Goals: goals, Shots: shots, Assists: assists, Saves: saves, Touches: 10, Demos: 0 };
}
function stateOf(guid, players, scores, extra = {}) {
  return {
    MatchGuid: guid, Players: players,
    Game: { Teams: [{ Name: 'Blue', TeamNum: 0, Score: scores[0] }, { Name: 'Orange', TeamNum: 1, Score: scores[1] }], PlaylistId: 13, TimeSeconds: 0, bOvertime: false, bReplay: false, bHasWinner: true, Winner: '', Arena: 'Stadium_P', ...extra },
  };
}
const ME = 'Epic|me|0';
function playMatch(tracker, guid, players, scores, winner, extraEnd) {
  tracker.handle({ Event: 'MatchCreated', Data: { MatchGuid: guid } });
  tracker.handle({ Event: 'UpdateState', Data: stateOf(guid, players, [0, 0], { bHasWinner: false }) });
  tracker.handle({ Event: 'UpdateState', Data: stateOf(guid, players, scores) });
  if (extraEnd) extraEnd();
  tracker.handle({ Event: 'MatchEnded', Data: { MatchGuid: guid, WinnerTeamNum: winner } });
  tracker.handle({ Event: 'PodiumStart', Data: {} });
  tracker.handle({ Event: 'MatchDestroyed', Data: { MatchGuid: guid } });
}
function buildHistory() {
  const stored = [];
  const history = [];
  const t = new rl.RlTracker({ getOwn: () => ({ name: 'akseli', id: '' }), history, onMatchStored: (r) => stored.push(r) });
  // 1: voitto, minä paras (MVP), 2 maalia
  playMatch(t, 'M1', [pl('Akseli', ME, 0, 500, 2, 5, 1, 3), pl('Mate', 'Steam|1|0', 0, 300, 1, 2, 0, 1), pl('Foe', 'Steam|2|0', 1, 200, 1, 3, 0, 0)], [3, 1], 0);
  // 2: tappio, 0 maalia
  playMatch(t, 'M2', [pl('Akseli', ME, 0, 150, 0, 2, 0, 5), pl('Mate', 'Steam|1|0', 0, 100, 1, 2, 0, 1), pl('Foe', 'Steam|2|0', 1, 400, 3, 6, 0, 0)], [1, 3], 1);
  // 3: voitto, mate parempi (ei MVP), 1 maali
  playMatch(t, 'M3', [pl('Akseli', ME, 1, 250, 1, 4, 0, 2), pl('Other', 'Epic|o|0', 1, 600, 3, 4, 1, 0), pl('Mate', 'Steam|1|0', 0, 100, 0, 1, 0, 1)], [1, 4], 1);
  return { t, stored, history };
}
test('RL-historia: tallennus MatchEndedillä, ei kaksoiskappaleita', () => {
  const { t, stored, history } = buildHistory();
  assert.strictEqual(history.length, 3);
  assert.strictEqual(stored.length, 3);
  // sama guid uudelleen -> ei duplikaattia
  playMatch(t, 'M1', [pl('Akseli', ME, 0, 500, 2, 5, 1, 3)], [3, 1], 0);
  assert.strictEqual(history.length, 3);
  assert.strictEqual(history[0].winnerTeamNum, 0);
  assert.strictEqual(history[0].arena, 'Stadium_P');
});
test('RL-historia: tallennus MatchDestroyedilla jos bHasWinner eikä MatchEndedia', () => {
  const history = [];
  const t = new rl.RlTracker({ getOwn: () => null, history });
  t.handle({ Event: 'UpdateState', Data: stateOf('Z1', [pl('A', 'x', 0, 1, 1, 1, 0, 0)], [2, 1]) });
  t.handle({ Event: 'MatchDestroyed', Data: {} });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].winnerTeamNum, 0); // johdetaan pisteistä
  // ei voittajaa -> ei tallennusta
  t.handle({ Event: 'UpdateState', Data: stateOf('Z2', [pl('A', 'x', 0, 1, 1, 1, 0, 0)], [2, 1], { bHasWinner: false }) });
  t.handle({ Event: 'MatchDestroyed', Data: {} });
  assert.strictEqual(history.length, 1);
});
test('RL-historia: toistot (bReplay) eivät korvaa loppu-tilannetta', () => {
  const history = [];
  const t = new rl.RlTracker({ getOwn: () => null, history });
  t.handle({ Event: 'MatchCreated', Data: { MatchGuid: 'R' } });
  t.handle({ Event: 'UpdateState', Data: stateOf('R', [pl('A', 'x', 0, 700, 7, 1, 0, 0)], [7, 0]) });
  t.handle({ Event: 'UpdateState', Data: stateOf('R', [pl('A', 'x', 0, 0, 0, 0, 0, 0)], [0, 0], { bReplay: true }) });
  t.handle({ Event: 'MatchEnded', Data: { WinnerTeamNum: 0 } });
  assert.strictEqual(history[0].players[0].score, 700);
});
test('RL-historia: tuntematon tapahtuma ja viallinen data eivät kaada', () => {
  const t = new rl.RlTracker({ history: [] });
  t.handle({ Event: 'WhoKnows', Data: { a: 1 } });
  t.handle({ Event: 'GoalScored', Data: null });
  t.handle({ Event: 'StatfeedEvent', Data: { EventName: 'Save' } });
  t.handle(null);
  assert.ok(true);
});
test('RL-historia: koonti (V/H, voitto-%, ka/peli, paras peli, MVP)', () => {
  const { history } = buildHistory();
  const s = rl.summarizeHistory(history, { name: 'AKSELI', id: '' });
  assert.strictEqual(s.total, 3); assert.strictEqual(s.counted, 3);
  assert.strictEqual(s.wins, 2); assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.winrate, 66.67);
  assert.strictEqual(s.goalsPerGame, 1); // (2+0+1)/3
  assert.strictEqual(s.savesPerGame, 3.33); // (3+5+2)/3
  assert.strictEqual(s.shotsPerGame, 3.67); // (5+2+4)/3
  assert.deepStrictEqual({ score: s.bestGame.score, goals: s.bestGame.goals }, { score: 500, goals: 2 });
  assert.strictEqual(s.mostGoals.goals, 2);
  assert.strictEqual(s.mvps, 1);
});
test('RL-historia: ilman omaa nimeä W/L ei lasketa; PrimaryId tunnistaa uudelleennimetyn', () => {
  const { history } = buildHistory();
  const none = rl.summarizeHistory(history, { name: '', id: '' });
  assert.strictEqual(none.counted, 0); assert.strictEqual(none.unattributed, 3); assert.strictEqual(none.winrate, null);
  const byId = rl.summarizeHistory(history, { name: 'UusiNimi', id: ME });
  assert.strictEqual(byId.counted, 3); assert.strictEqual(byId.wins, 2);
});
test('RL-historia: kohtaamishistoria (kanssa / vastaan)', () => {
  const { history } = buildHistory();
  const idx = rl.buildEncounterIndex(history, { name: 'Akseli', id: '' });
  const mate = idx.get('mate');   // M1 kanssa (voitto), M2 kanssa (tappio), M3 vastaan (voitto)
  assert.deepStrictEqual(mate.with, { games: 2, wins: 1 });
  assert.deepStrictEqual(mate.against, { games: 1, wins: 1 });
  const foe = idx.get('foe');     // M1 vastaan (voitto), M2 vastaan (tappio)
  assert.deepStrictEqual(foe.against, { games: 2, wins: 1 });
  assert.strictEqual(idx.get('akseli'), undefined);
});
test('RL-live: tilannekuva (oma pelaaja, feed, nopeus km/h)', () => {
  const { t } = buildHistory();
  t.handle({ Event: 'MatchCreated', Data: { MatchGuid: 'L' } });
  t.handle({ Event: 'UpdateState', Data: stateOf('L', [pl('Akseli', ME, 0, 100, 1, 1, 0, 0), pl('Mate', 'Steam|1|0', 0, 50, 0, 0, 0, 0), pl('Foe', 'Steam|2|0', 1, 20, 0, 0, 0, 0)], [1, 0], { bHasWinner: false, TimeSeconds: 125, Arena: 'Park_P' }) });
  t.handle({ Event: 'GoalScored', Data: { GoalSpeed: 2500, Scorer: { Name: 'Akseli', TeamNum: 0 }, Assister: { Name: 'Mate', TeamNum: 0 } } });
  t.handle({ Event: 'StatfeedEvent', Data: { EventName: 'EpicSave', MainTarget: { Name: 'Foe', TeamNum: 1 } } });
  t.handle({ Event: 'StatfeedEvent', Data: { EventName: 'Shot', MainTarget: { Name: 'Foe', TeamNum: 1 } } });
  const s = t.snapshot();
  assert.strictEqual(s.match.arenaName, 'Beckwith Park');
  assert.strictEqual(s.match.timeSeconds, 125);
  assert.ok(s.match.players.find((p) => p.name === 'Akseli').isOwn);
  assert.strictEqual(s.match.players.find((p) => p.name === 'Mate').encounter.with.games, 2);
  assert.strictEqual(s.feed.length, 2);
  assert.strictEqual(s.feed[1].speedKmh, 90);
  assert.strictEqual(s.feed[0].kind, 'epicsave');
});

// ---- Asetukset ----------------------------------------------------------------
test('Asetukset: validointi', () => {
  assert.deepStrictEqual(sanitize({ owPlatform: 'xbox', rlWebPort: 80, evil: 1 }), {});
  assert.deepStrictEqual(sanitize({ owPlatform: 'console', rlWebPort: '49200', rlOwnName: '  Akseli ' }), { owPlatform: 'console', rlWebPort: 49200, rlOwnName: 'Akseli' });
});

test('Asetukset: oma profiili (owProfile, rlPlatform, r6Name) validointi ja osittainen yhdistäminen', () => {
  assert.deepStrictEqual(sanitize({ owProfile: { battletag: ' TeKrop-2217 ', platform: 'console' } }), { owProfile: { battletag: 'TeKrop#2217', platform: 'console' } });
  assert.deepStrictEqual(sanitize({ owProfile: { battletag: 'roska', platform: 'xbox' } }), {});
  assert.deepStrictEqual(sanitize({ owProfile: { battletag: '' } }), { owProfile: { battletag: '' } });
  assert.deepStrictEqual(sanitize({ owProfile: 'x', rlPlatform: 'atari', r6Name: 5 }), {});
  assert.deepStrictEqual(sanitize({ rlPlatform: 'psn', r6Name: '  Ubi\u0007Nimi ' }), { rlPlatform: 'psn', r6Name: 'UbiNimi' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-set-'));
  try {
    const s = createSettings(tmp);
    assert.deepStrictEqual(s.get().owProfile, { battletag: '', platform: 'pc' });
    s.set({ owProfile: { battletag: 'TeKrop#2217' } });
    const after = s.set({ owProfile: { platform: 'console' } });
    assert.deepStrictEqual(after.owProfile, { battletag: 'TeKrop#2217', platform: 'console' });
    assert.deepStrictEqual(createSettings(tmp).get().owProfile, { battletag: 'TeKrop#2217', platform: 'console' }); // pysyy levyllä
    assert.strictEqual(after.rlPlatform, 'epic');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- Oma profiili: OW-rankit ----------------------------------------------------
test('Profiili: rankkiportaat (arvot, seuraava rankki, Champion 1 = ylin)', () => {
  assert.strictEqual(P.ladderValue('bronze', 5), 0);
  assert.strictEqual(P.ladderValue('bronze', 1), 4);
  assert.strictEqual(P.ladderValue('silver', 5), 5);
  assert.strictEqual(P.ladderValue('Silver', 4), 6);
  assert.strictEqual(P.ladderValue('champion', 5), 35);
  assert.strictEqual(P.ladderValue('champion', 1), 39);
  assert.strictEqual(P.LADDER_MAX, 39);
  for (const [d, t] of [['wood', 3], ['gold', 0], ['gold', 6], ['gold', 2.5], [null, 1]]) assert.strictEqual(P.ladderValue(d, t), null);
  assert.strictEqual(P.rankLabel('silver', 4), 'Hopea 4');
  const n = P.nextRank('silver', 4);
  assert.deepStrictEqual({ d: n.division, t: n.tier, label: n.label }, { d: 'silver', t: 3, label: 'Hopea 3' });
  assert.strictEqual(P.nextRank('bronze', 1).label, 'Hopea 5');       // divisioonan vaihto
  assert.strictEqual(P.nextRank('grandmaster', 1).label, 'Champion 5');
  assert.strictEqual(P.nextRank('champion', 2).label, 'Champion 1');
  assert.strictEqual(P.nextRank('champion', 1), null);               // ylin: ei seuraavaa
  assert.strictEqual(P.nextRank('foo', 1), null);
  const tbl = P.ladderTable();
  assert.strictEqual(tbl.length, 40);
  assert.strictEqual(tbl[0].label, 'Pronssi 5');
  assert.strictEqual(tbl[39].label, 'Champion 1');
  assert.strictEqual(P.ladderRank(7).label, 'Hopea 3');
});

function snap(ts, o = {}) {
  return { ts, ranks: o.ranks || {}, games_played: o.p ?? null, games_won: o.w ?? null, games_lost: o.l ?? null, eliminations: o.e ?? null, deaths: o.d ?? null, kd: o.kd ?? null, winrate: o.wr ?? null, season: o.season ?? 22 };
}
const rk = (division, tier) => ({ division, tier, value: P.ladderValue(division, tier) });

test('Profiili: tilannekuva OverFast-fixturesta', () => {
  const p = ow.normalizeProfile({ id: 'TeKrop-2217', summary: fx('ow-summary.json'), stats: fx('ow-stats-summary.json'), career: fx('ow-career.json'), platform: 'pc', gamemode: 'competitive' });
  const s = P.makeSnapshot(p, 1234);
  assert.strictEqual(s.ts, 1234);
  assert.deepStrictEqual(s.ranks, { support: { division: 'silver', tier: 4, value: 6 } });
  assert.deepStrictEqual({ p: s.games_played, w: s.games_won, l: s.games_lost, wr: s.winrate, kd: s.kd, season: s.season }, { p: 19, w: 6, l: 13, wr: 31.58, kd: 1.32, season: 22 });
  assert.ok(Number.isFinite(s.eliminations) && Number.isFinite(s.deaths) && s.deaths > 0);
  assert.strictEqual(P.makeSnapshot(null, 1), null);
  assert.strictEqual(P.makeSnapshot({ ranks: [], tiles: null }, 1), null); // ei mitään tallennettavaa
});

test('Profiili: tilannekuvan deduplikointi ja katto (cap)', () => {
  let list = [];
  let r = P.appendSnapshot(list, snap(1, { w: 1, l: 0, p: 1, ranks: { tank: rk('gold', 5) } }));
  assert.ok(r.added); list = r.list;
  r = P.appendSnapshot(list, snap(2, { w: 1, l: 0, p: 1, ranks: { tank: rk('gold', 5) }, kd: 9, wr: 50 })); // vain johdetut kentät eroavat
  assert.ok(!r.added); assert.strictEqual(r.list.length, 1);
  r = P.appendSnapshot(list, snap(3, { w: 2, l: 0, p: 2, ranks: { tank: rk('gold', 5) } }));
  assert.ok(r.added); list = r.list;
  r = P.appendSnapshot(list, snap(4, { w: 2, l: 0, p: 2, ranks: { tank: rk('gold', 4) } })); // rankki muuttui
  assert.ok(r.added); list = r.list;
  assert.strictEqual(list.length, 3);
  assert.ok(!P.appendSnapshot(list, null).added);
  // cap
  let big = [];
  for (let i = 0; i < 2005; i++) big = P.appendSnapshot(big, snap(i + 1, { w: i, l: 0, p: i })).list;
  assert.strictEqual(big.length, 2000);
  assert.strictEqual(big[0].ts, 6);          // vanhimmat pudotettu
  assert.strictEqual(big[1999].ts, 2005);
  assert.strictEqual(P.appendSnapshot([snap(1, { w: 1 }), snap(2, { w: 2 }), snap(3, { w: 3 })], snap(4, { w: 4 }), 3).list.length, 3);
});

test('Profiili: viikon / kuukauden muutokset (voitot, tappiot, rankkimuutos, kausi)', () => {
  const now = new Date(2026, 9, 25, 15).getTime(); // su 25.10.2026
  assert.strictEqual(P.startOfWeek(now), new Date(2026, 9, 19).getTime());
  assert.strictEqual(P.startOfMonth(now), new Date(2026, 9, 1).getTime());
  const d = (day, h = 12) => new Date(2026, 9, day, h).getTime();
  const snaps = [
    snap(d(12), { w: 10, l: 10, p: 20, ranks: { support: rk('silver', 5), tank: rk('gold', 3) } }),
    snap(d(20), { w: 13, l: 11, p: 24, ranks: { support: rk('silver', 4), tank: rk('gold', 3) } }),
    snap(d(24), { w: 15, l: 12, p: 27, ranks: { support: rk('silver', 3), tank: rk('gold', 3) } }),
  ];
  const wk = P.deltaSince(snaps, P.startOfWeek(now));
  assert.deepStrictEqual({ w: wk.wins, l: wk.losses, g: wk.games, partial: wk.partial, since: wk.since }, { w: 5, l: 2, g: 7, partial: false, since: d(12) });
  assert.strictEqual(wk.rankChange.support, 2);
  assert.strictEqual(wk.rankChange.tank, 0);
  assert.strictEqual(wk.rankChange.damage, null);
  const mo = P.deltaSince(snaps, P.startOfMonth(now));
  assert.ok(mo.partial);                       // ei mittausta ennen kuun alkua -> ensimmäisestä
  assert.strictEqual(mo.wins, 5);
  const none = P.deltaSince(snaps, d(25));    // viimeinen mittaus ennen rajaa -> ei muutosta
  assert.deepStrictEqual({ w: none.wins, l: none.losses }, { w: 0, l: 0 });
  assert.strictEqual(P.deltaSince([], 0), null);
  // kausi vaihtuu: laskurit nollautuvat -> uusi arvo lasketaan kokonaan
  const reset = P.deltaSince([snap(d(20), { w: 50, l: 40, p: 90, season: 22 }), snap(d(24), { w: 4, l: 2, p: 6, season: 23 })], d(19));
  assert.deepStrictEqual({ w: reset.wins, l: reset.losses, sc: reset.seasonChanged }, { w: 4, l: 2, sc: true });
});

test('Profiili: voittoarvio rankin edistymisestä (käsin kirjatut merkinnät + pelimäärät)', () => {
  const v = P.ladderValue('silver', 4);
  const entry = (id, ts, percent, value = v) => ({ id, ts, role: 'support', percent, division: 'silver', tier: 4, value, season: 22 });
  const snaps = [snap(100, { w: 10, l: 10 }), snap(200, { w: 13, l: 10 }), snap(300, { w: 16, l: 12 })];
  // 1 merkintä: ei arviota, vain jäljellä
  let st = P.progressStatus([entry('aaaaaa', 150, 20)], snaps, v);
  assert.strictEqual(st.remaining, 80); assert.strictEqual(st.perWin, null); assert.strictEqual(st.winsNeeded, null);
  // 2 merkintää: 150 -> 250 : voitot 13->13... käytetään aikoja 100 ja 300: 6 voittoa, 2 tappiota = netto 4; 20 -> 50 % = 7,5 / voitto
  const es = [entry('aaaaaa', 100, 20), entry('bbbbbb', 300, 50)];
  assert.strictEqual(P.estimateProgressPerWin(es, snaps).perWin, 7.5);
  st = P.progressStatus(es, snaps, v);
  assert.strictEqual(st.remaining, 50); assert.strictEqual(st.winsNeeded, Math.ceil(50 / 7.5)); assert.strictEqual(st.winsNeeded, 7);
  assert.strictEqual(st.samples, 1); assert.ok(!st.stale);
  // rankki vaihtunut -> vanhentunut, ei arviota
  st = P.progressStatus(es, snaps, P.ladderValue('silver', 3));
  assert.ok(st.stale); assert.strictEqual(st.winsNeeded, null);
  // eri rankit tai negatiivinen kehitys eivät kelpaa
  assert.strictEqual(P.estimateProgressPerWin([entry('aaaaaa', 100, 20), entry('bbbbbb', 300, 50, v + 1)], snaps), null);
  assert.strictEqual(P.estimateProgressPerWin([entry('aaaaaa', 100, 60), entry('bbbbbb', 300, 40)], snaps), null);
  assert.strictEqual(P.estimateProgressPerWin([entry('aaaaaa', 100, 20), entry('bbbbbb', 150, 40)], snaps), null); // ei pelejä välissä
  assert.strictEqual(P.progressStatus([], snaps, v), null);
  // 100 % -> 0 voittoa
  assert.strictEqual(P.progressStatus([entry('aaaaaa', 100, 20), entry('bbbbbb', 300, 100)], snaps, v).winsNeeded, 0);
});

// ---- Oma profiili: Rocket League ----------------------------------------------------
function rlMatch(ts, playlistId, won, extra = {}) {
  return {
    guid: `g${ts}`, endedAt: new Date(ts).toISOString(), playlistId, winnerTeamNum: won ? 0 : 1,
    players: [{ name: 'Akseli', primaryId: '', teamNum: 0, goals: extra.goals ?? 1, saves: 2, shots: 3, score: 100 }, { name: 'Foe', primaryId: '', teamNum: 1, goals: 0, saves: 0, shots: 0, score: 1 }],
  };
}
const OWN = { name: 'akseli', id: '' };

test('Profiili: RL-rankkiportaat ja seuraava divisioona', () => {
  assert.strictEqual(P.RL_RANKS.length, 22);
  assert.strictEqual(P.RL_RANKS[0], 'Bronze I');
  assert.strictEqual(P.RL_RANKS[20], 'Grand Champion III');
  assert.strictEqual(P.RL_RANKS[P.RL_SSL], 'Supersonic Legend');
  assert.strictEqual(P.rlLadderValue(0, 1), 0);
  assert.strictEqual(P.rlLadderValue(2, 3), 2 * 4 + 2);
  assert.strictEqual(P.rlLadderValue(21, 3), 84);            // SSL: divisioonalla ei väliä
  assert.strictEqual(P.rlLadderValue(22, 1), null);
  assert.strictEqual(P.rlLadderValue(3, 5), null);
  assert.deepStrictEqual({ r: P.rlNext(2, 2).rank, d: P.rlNext(2, 2).division }, { r: 2, d: 3 });
  assert.deepStrictEqual({ r: P.rlNext(2, 4).rank, d: P.rlNext(2, 4).division, l: P.rlNext(2, 4).label }, { r: 3, d: 1, l: 'Silver I, Div 1' });
  assert.strictEqual(P.rlNext(20, 4).label, 'Supersonic Legend');
  assert.strictEqual(P.rlNext(21, 1), null);
});

test('Profiili: RL MMR-arvio (johdettu omista merkinnöistä ja varaarvo 9)', () => {
  const T = 1_000_000;
  const matches = [];
  // standard (13): 4 voittoa + 1 tappio merkintöjen välissä; doubles (11) ei lasketa mukaan
  [true, true, false, true, true].forEach((w, i) => matches.push(rlMatch(T + 100 + i, 13, w)));
  matches.push(rlMatch(T + 150, 11, true), rlMatch(T + 151, 11, true));
  const results = P.ownResults(matches, OWN);
  const ids = P.RL_PLAYLISTS.standard.ids;
  const e = (id, ts, mmr, nextMmr) => ({ id, ts, playlist: 'standard', rank: 8, division: 2, value: 34, mmr, nextMmr });
  // derived: (1030 - 1000) / (4 - 1) = 10 MMR/voitto, tarvitaan 1100 - 1030 = 70 -> 7 voittoa
  const entries = [e('aaaaaa', T, 1000, 1100), e('bbbbbb', T + 500, 1030, 1100)];
  const need = P.rlNeed(entries, results, ids);
  assert.deepStrictEqual({ n: need.need, g: need.gain, d: need.derived, w: need.winsNeeded, s: need.samples }, { n: 70, g: 10, d: true, w: 7, s: 1 });
  // varaarvo: vain yksi merkintä -> 9 MMR/voitto: ceil(100 / 9) = 12
  const fb = P.rlNeed([e('aaaaaa', T, 1000, 1100)], results, ids);
  assert.deepStrictEqual({ n: fb.need, g: fb.gain, d: fb.derived, w: fb.winsNeeded }, { n: 100, g: 9, d: false, w: 12 });
  // MMR tappiollisessa jaksossa ei kelpaa arvioon -> varaarvo
  const bad = P.rlNeed([e('aaaaaa', T, 1000, 1100), e('bbbbbb', T + 500, 980, 1100)], results, ids);
  assert.strictEqual(bad.derived, false);
  // ei nextMmr:ää -> ei laskelmaa; raja jo saavutettu -> 0
  assert.strictEqual(P.rlNeed([e('aaaaaa', T, 1000, null)], results, ids), null);
  assert.strictEqual(P.rlNeed([{ ...e('aaaaaa', T, 1100, 1100) }], results, ids).winsNeeded, 0);
  // eri playlist ei sekoitu
  const dbl = P.estimateRlGain(entries, results, P.RL_PLAYLISTS.duel.ids);
  assert.strictEqual(dbl, null);
});

test('Profiili: RL putki, liukuva voitto-% ja 10 viimeisen koonti', () => {
  const T = 5_000_000;
  const seq = [true, true, false, true, true, true, false, false, true, true, false, true];
  const matches = seq.map((w, i) => rlMatch(T + i * 1000, 13, w, { goals: i % 3 }));
  const res = P.ownResults(matches.slice().reverse(), OWN); // järjestetään aikajärjestykseen
  assert.strictEqual(res.length, 12);
  assert.strictEqual(res[0].ts, T);
  assert.deepStrictEqual(P.currentStreak(res), { type: 'win', count: 1 });
  assert.deepStrictEqual(P.currentStreak(res.slice(0, 6)), { type: 'win', count: 3 });
  assert.deepStrictEqual(P.currentStreak(res.slice(0, 8)), { type: 'loss', count: 2 });
  assert.strictEqual(P.currentStreak([]), null);
  const wr = P.rollingSeries(res, 'winrate');
  assert.strictEqual(wr.length, 10);                 // vähintään 3 peliä
  assert.deepStrictEqual({ i: wr[0].i, v: wr[0].value }, { i: 3, v: 66.67 });
  assert.deepStrictEqual({ i: wr[9].i, v: wr[9].value }, { i: 12, v: 60 }); // F,T,T,T,F,F,T,T,F,T = 6/10
  const gl = P.rollingSeries(res, 'goals');
  assert.strictEqual(gl[0].value, 1);                // (0+1+2)/3
  assert.deepStrictEqual(P.lastGames(res, 10), { games: 10, wins: 6, winrate: 60 });
  assert.deepStrictEqual(P.lastGames([], 10), { games: 0, wins: 0, winrate: null });
  // ratkaisemattomat ja vieraat ottelut ohitetaan
  const foreign = { ...rlMatch(T, 13, true), players: [{ name: 'Joku', primaryId: '', teamNum: 0 }] };
  assert.strictEqual(P.ownResults([foreign, { ...rlMatch(T, 13, true), winnerTeamNum: null }], OWN).length, 0);
});

test('Profiili: syötteiden validointi (IPC)', () => {
  assert.deepStrictEqual(P.validateOwProgress({ role: 'tank', percent: '42,55' }), { role: 'tank', percent: 42.6 });
  for (const bad of [null, [], { role: 'x', percent: 5 }, { role: 'tank', percent: -1 }, { role: 'tank', percent: 101 }, { role: 'tank', percent: 'abc' }, { role: 'tank' }, { role: 'tank', percent: NaN }]) {
    assert.throws(() => P.validateOwProgress(bad), (e) => e.code === 'BAD_INPUT', JSON.stringify(bad));
  }
  assert.deepStrictEqual(P.validateRlRank({ playlist: 'duel', rank: 5, division: 2, mmr: '1000', nextMmr: 1100 }), { playlist: 'duel', rank: 5, division: 2, mmr: 1000, nextMmr: 1100 });
  assert.deepStrictEqual(P.validateRlRank({ playlist: 'other', rank: 21, division: 9 }), { playlist: 'other', rank: 21, division: 1, mmr: null, nextMmr: null }); // SSL: ei divisioonaa
  for (const bad of [null, { playlist: 'x', rank: 1, division: 1 }, { playlist: 'duel', rank: 22, division: 1 }, { playlist: 'duel', rank: -1, division: 1 },
    { playlist: 'duel', rank: 1.5, division: 1 }, { playlist: 'duel', rank: 1, division: 5 }, { playlist: 'duel', rank: 1, division: 0 },
    { playlist: 'duel', rank: 1, division: 1, mmr: 'abc' }, { playlist: 'duel', rank: 1, division: 1, mmr: -5 },
    { playlist: 'duel', rank: 1, division: 1, nextMmr: 1100 }, { playlist: 'duel', rank: 1, division: 1, mmr: 1100, nextMmr: 1100 }]) {
    assert.throws(() => P.validateRlRank(bad), (e) => e.code === 'BAD_INPUT', JSON.stringify(bad));
  }
  assert.strictEqual(P.validateId('abc123xyz'), 'abc123xyz');
  for (const bad of ['', 'AB', '../etc', 'a b c d e f', 5, null]) assert.throws(() => P.validateId(bad), (e) => e.code === 'BAD_INPUT');
});

test('Profiili: historiatiedoston normalisointi ja tallennus', () => {
  const clean = P.normalizeHistory({ ow: { tag: 'X-1|pc', snapshots: [snap(2, { w: 1 }), { ts: 'x' }, null, snap(1, { w: 0, ranks: { tank: { division: 'gold', tier: 9, value: 1 } } })],
    progress: { tank: [{ id: 'abcdef', ts: 5, percent: 50, division: 'gold', tier: 3 }, { id: 'x', ts: 5, percent: 50, division: 'gold', tier: 3 }, { id: 'abcdeg', ts: 6, percent: 500, division: 'gold', tier: 3 }] } },
  rl: { ranks: { duel: [{ id: 'abcdef', ts: 1, rank: 3, division: 2, mmr: 900 }, { id: 'abcdeh', ts: 2, rank: 99, division: 1 }], bogus: [{}] } } });
  assert.deepStrictEqual(clean.ow.snapshots.map((s) => s.ts), [1, 2]);       // järjestetty, roskat pois
  assert.deepStrictEqual(clean.ow.snapshots[0].ranks, {});                    // virheellinen tier pudotettu
  assert.strictEqual(clean.ow.progress.tank.length, 1);
  assert.strictEqual(clean.ow.progress.tank[0].value, P.ladderValue('gold', 3));
  assert.strictEqual(clean.rl.ranks.duel.length, 1);
  assert.strictEqual(clean.rl.ranks.duel[0].value, 3 * 4 + 1);
  assert.strictEqual(clean.rl.ranks.bogus, undefined);
  assert.deepStrictEqual(P.normalizeHistory('roska'), P.emptyHistory());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ph-'));
  try {
    const file = path.join(tmp, 'profile-history.json');
    const st = P.createHistoryStore(file);
    st.data.rl.ranks.duel.push({ id: P.newId(), ts: 1, playlist: 'duel', rank: 1, division: 1, value: 4, mmr: null, nextMmr: null });
    st.save();
    assert.strictEqual(P.createHistoryStore(file).data.rl.ranks.duel.length, 1);
    assert.ok(!fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')), 'ei jää väliaikaistiedostoja');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Profiili: dashboard-data (OW-rankit, seuraava, RL-rankit ja arvio)', () => {
  const now = new Date(2026, 9, 25, 15).getTime();
  const v = P.ladderValue('silver', 4);
  const history = P.normalizeHistory({
    ow: { tag: 'TeKrop-2217|pc', snapshots: [snap(now - 5000, { w: 6, l: 13, p: 19, wr: 31.58, kd: 1.32, ranks: { support: rk('silver', 4), tank: rk('champion', 1) } })],
      progress: { support: [{ id: 'aaaaaa', ts: now - 4000, percent: 40, division: 'silver', tier: 4 }] } },
    rl: { ranks: { standard: [{ id: 'bbbbbb', ts: now - 1000, rank: 8, division: 4, mmr: 1000, nextMmr: 1090 }] } },
  });
  const settings = { owProfile: { battletag: 'TeKrop#2217', platform: 'pc' }, rlOwnName: 'Akseli', rlOwnId: '', rlPlatform: 'steam', r6Name: 'UbiTesti' };
  const matches = [rlMatch(now - 3000, 13, true), rlMatch(now - 2000, 13, false)];
  const d = P.buildDashboard({ settings, history, ownProfile: null, matches, now });
  assert.strictEqual(d.ladder.length, 40);
  assert.strictEqual(d.ow.configured, true);
  const sup = d.ow.roles.find((r) => r.role === 'support');
  assert.strictEqual(sup.current.label, 'Hopea 4'); assert.strictEqual(sup.next.label, 'Hopea 3');
  assert.strictEqual(sup.progress.remaining, 60); assert.strictEqual(sup.progress.lastPercent, 40);
  const tank = d.ow.roles.find((r) => r.role === 'tank');
  assert.strictEqual(tank.atTop, true); assert.strictEqual(tank.next, null); assert.strictEqual(tank.progress, null);
  assert.deepStrictEqual(d.ow.tiles && { w: d.ow.tiles.wins, l: d.ow.tiles.losses }, { w: 6, l: 13 });
  assert.ok(d.ow.deltas.week && d.ow.deltas.month);
  assert.strictEqual(d.rl.summary.wins, 1); assert.strictEqual(d.rl.summary.losses, 1);
  const std = d.rl.playlists.find((p) => p.key === 'standard');
  assert.strictEqual(std.current.label, 'Gold III, Div 4'); assert.strictEqual(std.next.label, 'Platinum I, Div 1');
  assert.strictEqual(std.need.need, 90); assert.strictEqual(std.need.winsNeeded, 10); assert.strictEqual(std.need.derived, false);
  assert.strictEqual(d.rl.platform, 'steam');
  assert.deepStrictEqual(d.r6, { configured: true, name: 'UbiTesti' });
  // asetuksia ei ole -> kaikki konfiguroimatta
  const empty = P.buildDashboard({ settings: { owProfile: { battletag: '', platform: 'pc' }, rlOwnName: '', r6Name: '' }, history: P.emptyHistory(), ownProfile: null, matches: [], now });
  assert.deepStrictEqual([empty.ow.configured, empty.rl.configured, empty.r6.configured], [false, false, false]);
  // toinen BattleTag kuin historiassa -> vanha historia ei vuoda näkyviin
  const other = P.buildDashboard({ settings: { ...settings, owProfile: { battletag: 'Muu#9999', platform: 'pc' } }, history, ownProfile: null, matches: [], now });
  assert.strictEqual(other.ow.snapshots.length, 0);
  assert.strictEqual(other.ow.roles.every((r) => r.current === null), true);
});

test('Profiili: ajastin (heti + välein, ei päällekkäisiä ajoja, stop)', async () => {
  let intervalFn = null, cleared = 0, runs = 0, release = null;
  const errors = [];
  const sch = P.createScheduler({
    intervalMs: 1800000,
    run: () => { runs++; return runs === 2 ? Promise.reject(new Error('boom')) : (runs === 3 ? new Promise((r) => { release = r; }) : Promise.resolve()); },
    setIntervalFn: (fn, ms) => { intervalFn = fn; assert.strictEqual(ms, 1800000); return 7; },
    clearIntervalFn: (t) => { assert.strictEqual(t, 7); cleared++; },
    onError: (e) => errors.push(e.message),
  });
  await sch.start();
  assert.strictEqual(runs, 1); assert.ok(sch.running);
  assert.strictEqual(await sch.start(), false);          // ei tuplakäynnistystä
  await intervalFn();                                    // 2. ajo epäonnistuu, virhe raportoidaan
  assert.deepStrictEqual(errors, ['boom']);
  const third = intervalFn();                            // 3. ajo jää kesken
  assert.strictEqual(await intervalFn(), false);         // päällekkäinen ohitetaan
  assert.strictEqual(runs, 3);
  release(); await third;
  sch.stop(); assert.strictEqual(cleared, 1); assert.ok(!sch.running);
  assert.strictEqual(P.OW_SNAPSHOT_INTERVAL_MS, 30 * 60 * 1000);
});

// ---- Epätavalliset tilastot (suspicion.js) ----------------------------------------
// Rakentaa keinotekoisen careerin: kaikki hahmot + valitut hahmot. hero = [peliaika s, aseen tarkkuus, krit. tarkkuus]
function mkCareer({ games = 100, time = 200000, elims = 1000, deaths = 500, finals = 400, heroes = {} } = {}) {
  const c = { 'all-heroes': { game: { time_played: time, games_played: games }, combat: { eliminations: elims, deaths, final_blows: finals } } };
  for (const [k, [t, w, cr]] of Object.entries(heroes)) c[k] = { game: { time_played: t, games_played: 10 }, combat: { weapon_accuracy: w, critical_hit_accuracy: cr } };
  return c;
}
function mkProfile(career, extra = {}) {
  const a = career['all-heroes'];
  const wins = extra.wins != null ? extra.wins : Math.round(a.game.games_played * 0.5);
  return { tiles: { games: a.game.games_played, wins, losses: a.game.games_played - wins, winrate: a.game.games_played ? (wins / a.game.games_played) * 100 : null, eliminations: a.combat.eliminations, deaths: a.combat.deaths, timePlayed: a.game.time_played }, heroes: [] };
}
const run = (career, extra) => S.evaluate(mkProfile(career, extra), career);

test('Epätavalliset: tavallinen pelaaja -> none', () => {
  const r = run(mkCareer({ heroes: { cassidy: [7200, 40, 10], ana: [7200, 30, 0] } }));
  assert.strictEqual(r.level, 'none'); assert.strictEqual(r.score, 0); assert.ok(r.sampleOk); assert.deepStrictEqual(r.reasons, []);
});
test('Epätavalliset: puuttuva data (yksityinen) -> null', () => {
  assert.strictEqual(S.evaluate({ tiles: null }, null), null);
  assert.strictEqual(S.withSensitivity(null, 'normal'), null);
});
test('Epätavalliset: final blows / kuolema (>=2.0 paino 1, >=3.0 paino 2) ja K/D (>=4.0 paino 1, >=5.5 paino 2)', () => {
  const w = (o) => { const r = run(mkCareer(o)); return r.reasons.filter((x) => x.kind === 'finalBlows' || x.kind === 'kd').map((x) => [x.kind, x.weight]); };
  assert.deepStrictEqual(w({ deaths: 100, finals: 199, elims: 300 }), []);
  assert.deepStrictEqual(w({ deaths: 100, finals: 200, elims: 300 }), [['finalBlows', 1]]);
  assert.deepStrictEqual(w({ deaths: 100, finals: 300, elims: 300 }), [['finalBlows', 2]]);
  assert.deepStrictEqual(w({ deaths: 100, finals: 100, elims: 400 }), [['kd', 1]]);
  assert.deepStrictEqual(w({ deaths: 100, finals: 100, elims: 550 }), [['kd', 2]]);
  assert.deepStrictEqual(w({ deaths: 100, finals: 300, elims: 550 }), [['finalBlows', 2], ['kd', 2]]);
  const r = run(mkCareer({ deaths: 100, finals: 300, elims: 550 }));
  assert.strictEqual(r.score, 4); assert.strictEqual(r.level, 'suspicious');
  assert.ok(r.reasons.every((x) => typeof x.text === 'string' && 'value' in x && 'threshold' in x && 'weight' in x));
});
test('Epätavalliset: nolla kuolemaa ei jaa nollalla', () => {
  const r = run(mkCareer({ deaths: 0, finals: 300, elims: 600 }));
  assert.strictEqual(r.reasons.length, 0); assert.strictEqual(r.level, 'none');
});
test('Epätavalliset: hitscan-rajat (ylitys paino 1, +25 % paino 2, tasan raja ei ylitä)', () => {
  const kinds = (heroes) => run(mkCareer({ heroes })).reasons.filter((x) => x.kind === 'hitscan').map((x) => [x.hero, x.weight]);
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 70, 50] }), []);                       // tasan rajat
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 60, 51] }), [['widowmaker', 1]]);      // krit yli
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 71, 40] }), [['widowmaker', 1]]);      // ase yli
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 60, 62.5] }), [['widowmaker', 2]]);    // krit +25 %
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 87.5, 10] }), [['widowmaker', 2]]);    // ase +25 %
  assert.deepStrictEqual(kinds({ widowmaker: [7200, 71, 51] }), [['widowmaker', 1]]);      // molemmat yli mutta alle +25 %: yksi syy, paino 1
  assert.deepStrictEqual(kinds({ ana: [7200, 76, 99] }), [['ana', 1]]);                    // Anan kritiä ei arvioida
  assert.deepStrictEqual(kinds({ ana: [7200, 94, 0] }), [['ana', 2]]);                     // 75 * 1.25 = 93.75
  assert.deepStrictEqual(kinds({ soldier76: [7200, 99, 99] }), []);                        // ei hitscan-taulukossa
  assert.ok(run(mkCareer({ heroes: { 'soldier-76': [7200, 61, 10] } })).reasons.find((x) => x.kind === 'hitscan').text.startsWith('Soldier: 76'));
});
test('Epätavalliset: hitscan vain top 3 peliajan mukaan ja >= 1 h', () => {
  const heroes = { widowmaker: [20000, 50, 10], ashe: [15000, 50, 10], cassidy: [10000, 50, 10], tracer: [9000, 90, 90], sombra: [8000, 90, 90], bastion: [3599, 99, 99] };
  const top = S.topHitscan(mkCareer({ heroes }));
  assert.deepStrictEqual(top.map((r) => r.key), ['widowmaker', 'ashe', 'cassidy']);
  assert.ok(top.every((r, i, a) => i === 0 || a[i - 1].timePlayed >= r.timePlayed));
  // huomattavan korkea tracer jää top 3:n ulkopuolelle -> ei vaikutusta
  assert.strictEqual(run(mkCareer({ heroes })).score, 0);
  // alle tunnin pelattu hahmo ei kelpaa vaikka tarkkuus olisi huikea
  assert.deepStrictEqual(S.topHitscan(mkCareer({ heroes: { bastion: [3599, 99, 99] } })), []);
  assert.strictEqual(S.topHitscan(mkCareer({ heroes: { bastion: [3600, 99, 99] } })).length, 1);
  // tarkkuuskortin rivit sisältävät rajat
  const w = S.topHitscan(mkCareer({ heroes: { widowmaker: [7200, 80, 60] } }))[0];
  assert.deepStrictEqual([w.critLimit, w.weaponLimit, w.critOver, w.weaponOver], [50, 70, true, true]);
});
test('Epätavalliset: mahdollinen smurffi (voitto-% >= 75, >= 30 peliä)', () => {
  const c = mkCareer({ games: 40, deaths: 100, finals: 100, elims: 100 });
  const r = S.evaluate(mkProfile(c, { wins: 30 }), c);
  assert.deepStrictEqual(r.reasons.map((x) => [x.kind, x.weight]), [['smurf', 1]]);
  assert.ok(r.reasons[0].text.includes('smurffi'));
  assert.strictEqual(S.evaluate(mkProfile(c, { wins: 29 }), c).reasons.length, 0);           // 72,5 %
  const c2 = mkCareer({ games: 29, deaths: 100, finals: 100, elims: 100 });
  assert.strictEqual(S.evaluate(mkProfile(c2, { wins: 29 }), c2).reasons.length, 0);          // alle 30 peliä
});
test('Epätavalliset: liian pieni otos -> sampleOk false, none', () => {
  const c = mkCareer({ games: 19, deaths: 10, finals: 100, elims: 200, heroes: { widowmaker: [7200, 99, 99] } });
  const r = run(c);
  assert.strictEqual(r.sampleOk, false); assert.strictEqual(r.level, 'none'); assert.strictEqual(r.score, 0);
  assert.strictEqual(r.reasons.length, 1); assert.strictEqual(r.reasons[0].text, 'liian vähän pelejä arvioon');
  assert.strictEqual(run(mkCareer({ games: 50, time: 3600, deaths: 10, finals: 100, elims: 200 })).sampleOk, false); // liian vähän peliaikaa
  assert.strictEqual(S.withSensitivity(r, 'strict').level, 'none');
});
test('Epätavalliset: tasot (2-3 watch, >=4 suspicious) ja herkkyys', () => {
  const lv = (n, sens) => S.levelFor(n, sens);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map((n) => lv(n, 'normal')), ['none', 'none', 'watch', 'watch', 'suspicious', 'suspicious']);
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((n) => lv(n, 'strict')), ['none', 'watch', 'watch', 'suspicious', 'suspicious']);
  assert.strictEqual(S.THRESHOLDS.levels.strict.watch, S.THRESHOLDS.levels.normal.watch - 1);
  assert.strictEqual(S.THRESHOLDS.levels.strict.suspicious, S.THRESHOLDS.levels.normal.suspicious - 1);
  // pisteet 3 -> normaalilla watch, tiukalla suspicious; pois -> null
  const r = run(mkCareer({ deaths: 100, finals: 300, elims: 300, heroes: { widowmaker: [7200, 60, 51] } }));
  assert.strictEqual(r.score, 3); assert.strictEqual(r.level, 'watch');
  assert.strictEqual(S.withSensitivity(r, 'normal').level, 'watch');
  assert.strictEqual(S.withSensitivity(r, 'strict').level, 'suspicious');
  assert.strictEqual(S.withSensitivity(r, 'off'), null);
  assert.strictEqual(S.withSensitivity(r, 'roska').level, 'watch');            // tuntematon -> normaali
  assert.strictEqual(r.level, 'watch');                                         // alkuperäinen ei muutu
  const low = run(mkCareer({ heroes: { widowmaker: [7200, 60, 51] } }));
  assert.strictEqual(low.level, 'none'); assert.strictEqual(S.withSensitivity(low, 'strict').level, 'watch');
});
test('Epätavalliset: raja-arvotaulukko on yhdessä paikassa ja kaikki hahmot määritelty', () => {
  assert.deepStrictEqual(Object.keys(S.THRESHOLDS.hitscan.heroes).sort(), ['ana', 'ashe', 'baptiste', 'bastion', 'cassidy', 'widowmaker', 'sojourn', 'soldier-76', 'sombra', 'tracer'].sort());
  assert.deepStrictEqual(S.THRESHOLDS.hitscan.heroes.widowmaker, { crit: 50, weapon: 70 });
  assert.strictEqual(S.THRESHOLDS.hitscan.heroes.ana.crit, null);
  assert.throws(() => { S.THRESHOLDS.minGames = 1; }, TypeError); // jäädytetty (tiedosto on 'use strict')
});
test('Epätavalliset: OverFast-fixture kulkee providerin läpi (suspicion + accuracy mukana)', () => {
  const heroes = {};
  for (const x of fx('ow-heroes.json')) heroes[x.key] = { name: x.name, portrait: x.portrait, role: x.role };
  const p = ow.normalizeProfile({ id: 'TeKrop-2217', summary: fx('ow-summary.json'), stats: fx('ow-stats-summary.json'), career: fx('ow-career.json'), heroMap: heroes });
  assert.ok(p.suspicion && ['none', 'watch', 'suspicious'].includes(p.suspicion.level));
  assert.strictEqual(p.suspicion.sampleOk, false);     // fixturessa 19 peliä
  assert.ok(Array.isArray(p.accuracy));
  for (const a of p.accuracy) assert.ok(a.name && a.timePlayed >= 3600 && a.weaponLimit > 0);
  const priv = ow.normalizeProfile({ id: 'X-1234', summary: fx('ow-summary.json'), stats: {}, career: null, isPublic: false });
  assert.strictEqual(priv.suspicion, null); assert.deepStrictEqual(priv.accuracy, []);
  JSON.stringify(p); // serialisoitavissa IPC:n yli
});
test('Epätavalliset: dashboard soveltaa herkkyyttä oman profiilin merkkiin', () => {
  const c = mkCareer({ deaths: 100, finals: 300, elims: 300, heroes: { widowmaker: [7200, 60, 51] } });
  const prof = { name: 'X', avatar: null, title: null, namecard: null, season: 22, hasStats: true, isPrivate: false, rankPlatform: 'pc', ranks: [], tiles: mkProfile(c).tiles, heroes: [], suspicion: S.evaluate(mkProfile(c), c), accuracy: S.topHitscan(c) };
  const dash = (sens) => P.buildDashboard({ settings: { owProfile: { battletag: 'Muu#9999', platform: 'pc' }, rlOwnName: '', r6Name: '', suspicionSensitivity: sens }, history: P.emptyHistory(), ownProfile: { fetchedAt: 1, profile: prof, error: null, key: 'k' }, matches: [], now: Date.now() }).ow.profile;
  assert.strictEqual(dash('normal').suspicion.level, 'watch');
  assert.strictEqual(dash('strict').suspicion.level, 'suspicious');
  assert.strictEqual(dash('off').suspicion, null);
  assert.strictEqual(dash('normal').accuracy.length, 1);
});

// ---- Asetusten tiukka validointi ja oman profiilin linkitys / uloskirjaus -----------
test('Asetukset: validate hylkää huonon syötteen (IPC)', () => {
  for (const bad of [null, 5, 'x', [], {}, { evil: 1 }, { rlInstallDir: 'C:\\x' }, { rlOwnId: 'x' }, { rlWebPort: 80 }, { rlWebPort: 70000 }, { rlWebPort: 'abc' }, { rlWebPort: '' }, { rlWebPort: true }, { rlWebPort: 1234.5 },
    { owPlatform: 'xbox' }, { owGamemode: 'arcade' }, { suspicionSensitivity: 'max' }, { rlPlatform: 'atari' }, { rlOwnName: 5 }, { rlOwnName: 'x'.repeat(65) },
    { r6Name: 5 }, { r6Name: 'x'.repeat(33) }, { r6Name: 'a\u0007b' }, { owProfile: 'x' }, { owProfile: [] }, { owProfile: { battletag: 'roska' } }, { owProfile: { battletag: 5 } },
    { owProfile: { platform: 'ps' } }, { owProfile: { battletag: 'Nimi#1234', evil: 1 } }]) {
    assert.ok(typeof validate(bad) === 'string', JSON.stringify(bad));
  }
});
test('Asetukset: validate hyväksyy kelvolliset (linkitys, uloskirjaus, uudet asetukset)', () => {
  for (const ok of [{ owProfile: { battletag: 'TeKrop#2217', platform: 'console' } }, { owProfile: { battletag: '' } }, { owProfile: { platform: 'pc' } }, { rlOwnName: 'Akseli', rlPlatform: 'psn' }, { rlOwnName: '' },
    { r6Name: 'UbiNimi' }, { r6Name: '' }, { rlWebPort: 49200 }, { rlWebPort: '49200' }, { owPlatform: 'console' }, { owGamemode: 'quickplay' }, { suspicionSensitivity: 'off' }, { suspicionSensitivity: 'strict' }]) {
    assert.strictEqual(validate(ok), null, JSON.stringify(ok));
  }
});
test('Asetukset: uudet avaimet (owGamemode, suspicionSensitivity) ja oletukset', () => {
  assert.deepStrictEqual(sanitize({ owGamemode: 'quickplay', suspicionSensitivity: 'strict' }), { owGamemode: 'quickplay', suspicionSensitivity: 'strict' });
  assert.deepStrictEqual(sanitize({ owGamemode: 'x', suspicionSensitivity: 'y' }), {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statsikka-set-'));
  try {
    const s = createSettings(tmp);
    assert.strictEqual(s.get().owGamemode, 'competitive'); assert.strictEqual(s.get().suspicionSensitivity, 'normal');
    s.set({ owGamemode: 'quickplay', suspicionSensitivity: 'off' });
    const again = createSettings(tmp).get();
    assert.strictEqual(again.owGamemode, 'quickplay'); assert.strictEqual(again.suspicionSensitivity, 'off');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('Oma profiili: linkitys ja uloskirjaus tallentuvat samaan asetukseen (kaikki pelit)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statsikka-link-'));
  try {
    const s = createSettings(tmp);
    for (const patch of [{ owProfile: { battletag: ' TeKrop-2217 ', platform: 'console' } }, { rlOwnName: 'Akseli', rlPlatform: 'steam' }, { r6Name: 'UbiNimi' }]) {
      assert.strictEqual(validate(patch), null); s.set(patch);
    }
    const linked = createSettings(tmp).get();
    assert.deepStrictEqual(linked.owProfile, { battletag: 'TeKrop#2217', platform: 'console' });
    assert.strictEqual(linked.rlOwnName, 'Akseli'); assert.strictEqual(linked.r6Name, 'UbiNimi');
    const d = P.buildDashboard({ settings: linked, history: P.emptyHistory(), ownProfile: null, matches: [], now: Date.now() });
    assert.deepStrictEqual([d.ow.configured, d.rl.configured, d.r6.configured], [true, true, true]);
    // kirjaudu ulos: tyhjentää vain kyseisen pelin
    s.set({ owProfile: { battletag: '' } });
    let o = createSettings(tmp).get();
    assert.strictEqual(o.owProfile.battletag, ''); assert.strictEqual(o.owProfile.platform, 'console'); assert.strictEqual(o.rlOwnName, 'Akseli'); assert.strictEqual(o.r6Name, 'UbiNimi');
    s.set({ rlOwnName: '' }); s.set({ r6Name: '' });
    o = createSettings(tmp).get();
    const d2 = P.buildDashboard({ settings: o, history: P.emptyHistory(), ownProfile: null, matches: [], now: Date.now() });
    assert.deepStrictEqual([d2.ow.configured, d2.rl.configured, d2.r6.configured], [false, false, false]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('Oma profiili: OW-historia ei vuoda toiseen profiiliin uloskirjauksen / vaihdon jälkeen', () => {
  const hist = P.emptyHistory();
  hist.ow.tag = 'TeKrop-2217|pc';
  hist.ow.snapshots = [{ ts: 1, ranks: {}, games_played: 5, games_won: 3, games_lost: 2, eliminations: 1, deaths: 1, kd: 1, winrate: 60, season: 22 }];
  const mk = (bt, platform) => P.buildDashboard({ settings: { owProfile: { battletag: bt, platform }, rlOwnName: '', r6Name: '' }, history: hist, ownProfile: null, matches: [], now: Date.now() }).ow;
  assert.strictEqual(mk('TeKrop#2217', 'pc').snapshots.length, 1);      // sama profiili -> historia säilyy
  assert.strictEqual(mk('TeKrop#2217', 'console').snapshots.length, 0); // alusta vaihtui
  assert.strictEqual(mk('Muu#9999', 'pc').snapshots.length, 0);
  assert.strictEqual(mk('', 'pc').configured, false);
});

// ---- Rainbow Six Siege: käsin syötetty arvio (evaluateR6) ----------------------------
const r6 = (o) => S.evaluateR6({ kd: 1.0, hsPercent: 40, winrate: 50, matches: 200, kills: 3000, ...o });
const r6w = (o) => r6(o).reasons.map((x) => [x.kind, x.weight]);

test('R6: tavallinen pelaaja -> none', () => {
  const r = r6({});
  assert.strictEqual(r.level, 'none'); assert.strictEqual(r.score, 0); assert.ok(r.sampleOk); assert.deepStrictEqual(r.reasons, []);
});
test('R6: K/D (>=2.0 paino 1, >=3.0 paino 2, vaatii >= 50 ottelua)', () => {
  assert.deepStrictEqual(r6w({ kd: 1.99 }), []);
  assert.deepStrictEqual(r6w({ kd: 2.0 }), [['kd', 1]]);
  assert.deepStrictEqual(r6w({ kd: 3.0 }), [['kd', 2]]);
  assert.deepStrictEqual(r6w({ kd: 3.0, matches: 49 }), []);       // 49 ottelua: sääntö ei ole käytössä (otos kuitenkin >= 30)
  assert.deepStrictEqual(r6w({ kd: 3.0, matches: 50 }), [['kd', 2]]);
});
test('R6: headshot-% (>=60 paino 1, >=75 paino 2, vaatii >= 100 tappoa)', () => {
  assert.deepStrictEqual(r6w({ hsPercent: 59.9 }), []);
  assert.deepStrictEqual(r6w({ hsPercent: 60 }), [['headshot', 1]]);
  assert.deepStrictEqual(r6w({ hsPercent: 75 }), [['headshot', 2]]);
  assert.deepStrictEqual(r6w({ hsPercent: 80, kills: 99 }), []);
  assert.deepStrictEqual(r6w({ hsPercent: 80, kills: 100 }), [['headshot', 2]]);
  assert.deepStrictEqual(r6w({ hsPercent: 80, kills: null }), []);
});
test('R6: voitto-% (smurffi, >= 75 %, vaatii >= 30 ottelua), tappoja/kierros ja matala taso + korkea rank', () => {
  assert.deepStrictEqual(r6w({ winrate: 74.9 }), []);
  assert.deepStrictEqual(r6w({ winrate: 75 }), [['smurf', 1]]);
  assert.ok(r6({ winrate: 80 }).reasons[0].text.includes('smurffi'));
  assert.deepStrictEqual(r6w({ killsPerRound: 1.29 }), []);
  assert.deepStrictEqual(r6w({ killsPerRound: 1.3 }), [['killsPerRound', 1]]);
  assert.deepStrictEqual(r6w({ level: 49, rank: 'Diamond' }), [['smurf', 1]]);
  assert.deepStrictEqual(r6w({ level: 49, rank: 'champion' }), [['smurf', 1]]);
  assert.deepStrictEqual(r6w({ level: 50, rank: 'Diamond' }), []);
  assert.deepStrictEqual(r6w({ level: 10, rank: 'Emerald' }), []);
  assert.deepStrictEqual(r6w({ level: 10 }), []);
  assert.ok(r6({ level: 20, rank: 'Diamond' }).reasons[0].text.includes('smurffi'));
});
test('R6: tasot none / watch / suspicious ja sama reasons-muoto kuin OW:lla', () => {
  assert.strictEqual(r6({ kd: 2.1 }).level, 'none');                                   // pisteet 1
  const watch = r6({ kd: 2.1, hsPercent: 61 });                                        // 2
  assert.deepStrictEqual([watch.score, watch.level], [2, 'watch']);
  const w3 = r6({ kd: 3.2, hsPercent: 61 });                                           // 3
  assert.deepStrictEqual([w3.score, w3.level], [3, 'watch']);
  const sus = r6({ kd: 3.2, hsPercent: 80, killsPerRound: 1.5, level: 20, rank: 'Champion' }); // 2+2+1+1
  assert.deepStrictEqual([sus.score, sus.level], [6, 'suspicious']);
  assert.ok(sus.reasons.every((x) => typeof x.text === 'string' && 'value' in x && 'threshold' in x && 'weight' in x));
  assert.deepStrictEqual(Object.keys(sus).sort(), ['level', 'reasons', 'sampleOk', 'score', 'sensitivity']);
});
test('R6: liian pieni otos -> sampleOk false, none', () => {
  const r = r6({ matches: 29, kd: 9, hsPercent: 99, winrate: 99, killsPerRound: 3, level: 5, rank: 'Champion' });
  assert.strictEqual(r.sampleOk, false); assert.strictEqual(r.level, 'none'); assert.strictEqual(r.score, 0);
  assert.strictEqual(r.reasons[0].text, 'liian vähän pelejä arvioon');
  assert.strictEqual(S.evaluateR6({}).sampleOk, false);
  assert.strictEqual(S.evaluateR6(null).sampleOk, false);
  assert.strictEqual(r6({ matches: 30 }).sampleOk, true);
  assert.strictEqual(S.withSensitivity(r, 'strict').level, 'none');
});
test('R6: herkkyys (Tiukka -1, Pois piilottaa) koskee myös R6:ta', () => {
  const w3 = r6({ kd: 3.2, hsPercent: 61 });           // 3 pistettä
  assert.strictEqual(S.withSensitivity(w3, 'normal').level, 'watch');
  assert.strictEqual(S.withSensitivity(w3, 'strict').level, 'suspicious');
  assert.strictEqual(S.withSensitivity(w3, 'off'), null);
  const one = r6({ kd: 2.1 });                         // 1 piste
  assert.strictEqual(S.withSensitivity(one, 'normal').level, 'none');
  assert.strictEqual(S.withSensitivity(one, 'strict').level, 'watch');
  assert.strictEqual(S.R6_THRESHOLDS.kd.tiers[1].min, 3.0);
  assert.throws(() => { S.R6_THRESHOLDS.minMatches = 1; }, TypeError);
});
test('R6: syötteen validointi (IPC) ja providers/r6.assess', () => {
  const v = S.validateR6Input({ matches: '60', kd: '2,5', hsPercent: 61, rank: 'diamond', level: '30' });
  assert.ok(v.value); assert.deepStrictEqual([v.value.matches, v.value.kd, v.value.rank, v.value.level, v.value.kills], [60, 2.5, 'Diamond', 30, null]);
  for (const bad of [null, 5, [], {}, { matches: '' }, { matches: -1 }, { matches: 1.5 }, { matches: 'abc' }, { matches: 100001 }, { matches: 50, kd: 21 }, { matches: 50, hsPercent: 101 },
    { matches: 50, winrate: -1 }, { matches: 50, killsPerRound: 6 }, { matches: 50, level: 1.5 }, { matches: 50, rank: 'Bronzee' }, { matches: 50, rank: 5 }, { matches: 50, evil: 1 }, { matches: true }, { matches: 50, kd: {} }]) {
    assert.ok(S.validateR6Input(bad).error, JSON.stringify(bad));
  }
  const r6p = require('../src/main/providers/r6');
  assert.deepStrictEqual(r6p.assess({ matches: 100, kd: 3.5, hsPercent: 80, kills: 500 }), S.evaluateR6({ matches: 100, kd: 3.5, hsPercent: 80, kills: 500 }));
  assert.strictEqual(r6p.createR6().available, false);
  assert.strictEqual(typeof r6p.createR6().assess, 'function');
});

// ---- R6: ottelutallenteet (r6-stats, evaluateR6Replay, r6-service) ----------------------------------
const R6S = require('../src/main/r6-stats');
const R6Svc = require('../src/main/r6-service');
const R6ME = 'me-0000';
const pad2 = (n) => String(n).padStart(2, '0');
// Tallenteen aikaleima on paikallinen kellonaika 'Z':lla merkittynä: muotoillaan ms -> paikallinen seinäkello + 'Z'.
const wallZ = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}Z`; };
// Rakentaa ottelun yhteenvedon. ps: [profileID, teamIndex, kills, deaths, headshots, rounds]; rounds: [[score0, score1, winnerIdx, roleOfTeam0, roleOfTeam1]].
function fxMatch(name, ts, type, mapName, ownTeam, scores, ps, rounds, extra = {}) {
  const winner = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : -1;
  return {
    name, matchId: name, timestamp: wallZ(ts), lastRoundTimestamp: wallZ(ts + 60000), map: { name: mapName, id: mapName.length },
    matchType: { name: type, id: 1 }, gamemode: { name: 'Bomb', id: 1 }, roundsPerMatch: 6, roundsParsed: rounds.length, recordingProfileID: R6ME,
    teams: [0, 1].map((i) => ({ index: i, name: i === ownTeam ? 'YOUR TEAM' : 'ENEMY TEAM', score: scores[i], won: winner === i })),
    winnerTeamIndex: winner, ownTeamIndex: ownTeam, result: winner < 0 ? 'draw' : winner === ownTeam ? 'win' : 'loss',
    players: ps.map(([id, team, k, d, hs, r, ops]) => ({
      profileID: id, username: `N-${id}`, teamIndex: team, operators: [{ name: 'Ash', id: 1, role: 'Attack', rounds: r }], kills: k, deaths: d, assists: 0, headshots: hs,
      hsPercent: k ? Math.round((hs / k) * 1000) / 10 : 0, kd: d ? Math.round((k / d) * 100) / 100 : k, roundsPlayed: r, kpr: Math.round((k / r) * 100) / 100, score: 0,
      opStats: ops || [{ name: 'Ash', role: 'Attack', rounds: r, kills: k, deaths: d, headshots: hs }],
    })),
    rounds: rounds.map(([s0, s1, w, r0, r1], i) => ({ roundNumber: i, site: 'X', score: [s0, s1], winnerTeamIndex: w, winCondition: '', teamRoles: [r0, r1] })),
    ...extra,
  };
}
const R6T0 = Date.UTC(2026, 9, 1, 12);
const R6HR = 3600000;
function fixtures() {
  return [
    // M1: voitto 2-1, oma tiimi 0, Ranked, kartta A. Round 1 winner puuttuu (-1) -> johdetaan pisteistä.
    fxMatch('Match-1', R6T0, 'Ranked', 'Bank', 0, [2, 1], [[R6ME, 0, 10, 4, 5, 3], ['a', 0, 3, 3, 1, 3], ['x', 1, 6, 8, 2, 3]],
      [[1, 0, -1, 'Attack', 'Defense'], [1, 1, 1, 'Defense', 'Attack'], [2, 1, 0, 'Attack', 'Defense']]),
    // M2: tappio 0-2, oma tiimi 1, Unranked, kartta B.
    fxMatch('Match-2', R6T0 + R6HR, 'Unranked', 'Oregon', 1, [2, 0], [[R6ME, 1, 2, 6, 0, 2], ['a', 0, 4, 1, 2, 2], ['x', 0, 5, 1, 4, 2]],
      [[1, 0, 0, 'Attack', 'Defense'], [2, 0, 0, 'Defense', 'Attack']]),
    // M3: voitto 2-0 Ranked kartta A; x on nyt vastustaja.
    fxMatch('Match-3', R6T0 + 2 * R6HR, 'Ranked', 'Bank', 0, [2, 0], [[R6ME, 0, 8, 2, 4, 2, [{ name: 'Ash', role: 'Attack', rounds: 1, kills: 5, deaths: 1, headshots: 3 }, { name: 'Zofia', role: 'Attack', rounds: 1, kills: 3, deaths: 1, headshots: 1 }]], ['a', 1, 1, 4, 0, 2], ['x', 1, 2, 6, 1, 2]],
      [[1, 0, 0, 'Attack', 'Defense'], [2, 0, 0, 'Defense', 'Attack']]),
    // M4: voitto 2-1 QuickMatch.
    fxMatch('Match-4', R6T0 + 3 * R6HR, 'QuickMatch', 'Villa', 1, [1, 2], [[R6ME, 1, 5, 5, 2, 3], ['a', 1, 0, 3, 0, 3]],
      [[0, 1, 1, 'Attack', 'Defense'], [1, 1, -1, 'Defense', 'Attack'], [1, 2, 1, 'Attack', 'Defense']]),
  ];
}

test('R6 tilastot: omat summat, voitto-%, K/D, HS-%, KPR ja putki', () => {
  const a = R6S.aggregateOwn(fixtures(), R6ME);
  assert.deepStrictEqual([a.matches, a.wins, a.losses, a.draws], [4, 3, 1, 0]);
  assert.strictEqual(a.winrate, 75);
  assert.deepStrictEqual([a.kills, a.deaths, a.headshots, a.rounds], [25, 17, 11, 10]);
  assert.strictEqual(a.kd, 1.47); assert.strictEqual(a.hsPercent, 44); assert.strictEqual(a.kpr, 2.5);
  assert.deepStrictEqual(a.streak, { type: 'win', count: 2 });
  assert.deepStrictEqual(a.last10, { games: 4, wins: 3, winrate: 75 });
  assert.deepStrictEqual(a.typeCounts, { all: 4, ranked: 2, unranked: 1, quick: 1 });
  assert.strictEqual(a.lastTs, R6T0 + 3 * R6HR);
});
test('R6 tilastot: ottelutyyppisuodatin ja käynnissä olevan ottelun poisjättö', () => {
  const r = R6S.aggregateOwn(fixtures(), R6ME, { matchType: 'ranked' });
  assert.deepStrictEqual([r.matches, r.wins, r.kills, r.deaths], [2, 2, 18, 6]);
  assert.strictEqual(R6S.aggregateOwn(fixtures(), R6ME, { matchType: 'unranked' }).losses, 1);
  assert.strictEqual(R6S.aggregateOwn(fixtures(), R6ME, { matchType: 'quick' }).matches, 1);
  assert.strictEqual(R6S.aggregateOwn(fixtures(), R6ME, { matchType: 'roska' }).filter, 'all');
  const ex = R6S.aggregateOwn(fixtures(), R6ME, { excludeName: 'Match-4' });
  assert.strictEqual(ex.matches, 3); assert.strictEqual(ex.streak.count, 1);
  assert.strictEqual(R6S.aggregateOwn(fixtures(), 'ei-ole').matches, 0);
  assert.strictEqual(R6S.aggregateOwn([], R6ME).winrate, null);
});
test('R6 tilastot: kierrokset hyökkäys/puolustus (puuttuva voittaja johdetaan pisteistä)', () => {
  const m = fixtures();
  assert.deepStrictEqual(R6S.roundWinners(m[0]), [0, 1, 0]);
  assert.deepStrictEqual(R6S.roundWinners(m[3]), [1, 0, 1]);
  const a = R6S.aggregateOwn(m, R6ME);
  // Oma tiimi: M1 tiimi 0 (H, P, H) tulokset [voitto, tappio, voitto]; M2 tiimi 1 (P, H) [tappio, tappio];
  // M3 tiimi 0 (H, P) [voitto, voitto]; M4 tiimi 1 (P, H, P) [voitto, tappio... ] -> katso laskut alla
  assert.deepStrictEqual([a.attack.played, a.defense.played], [5, 5]);
  assert.deepStrictEqual([a.attack.won, a.defense.won], [3, 3]);
  assert.deepStrictEqual([a.attack.winrate, a.defense.winrate], [60, 60]);
});
test('R6 tilastot: kartat ja operaattorit (kierroskohtaiset tapot)', () => {
  const a = R6S.aggregateOwn(fixtures(), R6ME);
  const bank = a.maps.find((x) => x.name === 'Bank');
  assert.deepStrictEqual([a.maps.length, bank.matches, bank.wins, bank.winrate, bank.kd], [3, 2, 2, 100, 3]);
  assert.strictEqual(a.maps[0].name, 'Bank');
  const ash = a.operators.find((x) => x.name === 'Ash'), zofia = a.operators.find((x) => x.name === 'Zofia');
  assert.deepStrictEqual([ash.rounds, ash.kills, ash.deaths, ash.kd], [3 + 1 + 2 + 3, 10 + 2 + 5 + 5, 4 + 6 + 1 + 5, 1.38]);
  assert.deepStrictEqual([zofia.rounds, zofia.kills, zofia.hsPercent], [1, 3, 33.3]);
  assert.ok(a.operators[0].rounds >= a.operators[1].rounds);
  // ilman opStats-kenttää käytetään operators-listaa (kuolemat/tapot tuntemattomia)
  const m = fixtures()[0]; for (const p of m.players) delete p.opStats;
  const b = R6S.aggregateOwn([m], R6ME);
  assert.deepStrictEqual([b.operators[0].name, b.operators[0].rounds, b.operators[0].kills, b.operators[0].kd], ['Ash', 3, null, null]);
});
test('R6 tilastot: sarjat (liukuva voitto-%, K/D per ottelu) ja parhaat ottelut', () => {
  const a = R6S.aggregateOwn(fixtures(), R6ME);
  assert.deepStrictEqual(a.series.kd.map((p) => p.value), [2.5, 0.33, 4, 1]);
  assert.deepStrictEqual(a.series.winrate.map((p) => p.value), [66.67, 75]); // vähintään 3 ottelua ikkunassa
  assert.strictEqual(a.bestKills.name, 'Match-1'); assert.strictEqual(a.bestKills.kills, 10);
  assert.strictEqual(a.bestKd.name, 'Match-3');
});
test('R6 pelaajaindeksi: kanssa/vastaan, V-H sinun näkökulmastasi, nimet ja ajat', () => {
  const idx = R6S.buildPlayersIndex(fixtures(), R6ME);
  const a = idx.get('a'), x = idx.get('x');
  // a: M1 kanssa (voitto), M2 vastaan (tappio), M3 vastaan (voitto), M4 kanssa (voitto)
  assert.deepStrictEqual([a.matches, a.with.matches, a.against.matches], [4, 2, 2]);
  assert.deepStrictEqual([a.with.wins, a.with.losses, a.against.wins, a.against.losses], [2, 0, 1, 1]);
  assert.deepStrictEqual([x.matches, x.with.matches, x.against.matches, x.against.wins, x.against.losses], [3, 0, 3, 2, 1]);
  assert.strictEqual(a.kills, 3 + 4 + 1 + 0); assert.strictEqual(a.kd, 0.73); // 8 tappoa / 11 kuolemaa
  assert.strictEqual(a.lastSeen, R6T0 + 3 * R6HR); assert.strictEqual(a.lastMatch, 'Match-4');
  assert.strictEqual(idx.get(R6ME).isOwn, true);
  assert.strictEqual(R6S.buildPlayersIndex(fixtures(), R6ME, { excludeName: 'Match-4' }).get('a').matches, 3);
  // nimenvaihdokset: viimeisin ensin
  const m = fixtures(); m[3].players[1].username = 'Uusi';
  assert.deepStrictEqual(R6S.buildPlayersIndex(m, R6ME).get('a').usernames.slice(0, 2), ['Uusi', 'N-a']);
});
test('R6 pelaajalista: haku, lajittelu, sivutus, oma pelaaja pois, merkityt', () => {
  const idx = R6S.buildPlayersIndex(fixtures(), R6ME);
  const all = R6S.listPlayers(idx, { sort: 'matches' });
  assert.deepStrictEqual(all.players.map((p) => p.profileID), ['a', 'x']); // omaa ei listata
  assert.strictEqual(R6S.listPlayers(idx, { search: 'N-X' }).total, 1);
  assert.strictEqual(R6S.listPlayers(idx, { search: 'zzz' }).total, 0);
  assert.strictEqual(R6S.listPlayers(idx, { sort: 'kd' }).players[0].profileID, 'x');
  const pg = R6S.listPlayers(idx, { pageSize: 1, page: 2, sort: 'matches' });
  assert.deepStrictEqual([pg.page, pg.pages, pg.players.length, pg.players[0].profileID], [2, 2, 1, 'x']);
  assert.strictEqual(R6S.listPlayers(idx, { page: 99, pageSize: 1 }).page, 2);
  assert.strictEqual(R6S.listPlayers(idx, { flaggedOnly: true }).total, 0);
  assert.strictEqual(R6S.playerMatches(fixtures(), R6ME, 'x')[0].name, 'Match-3'); // uusin ensin
  assert.deepStrictEqual(R6S.playerMatches(fixtures(), R6ME, 'x').map((r) => r.side), ['against', 'against', 'against']);
});

// evaluateR6Replay
const rr = (o) => S.evaluateR6Replay(o);
test('R6 replay: ei otosta -> sampleOk false, none', () => {
  const r = rr({ matches: 2, rounds: 10, kills: 15, deaths: 1, headshots: 15 });
  assert.strictEqual(r.sampleOk, false); assert.strictEqual(r.level, 'none'); assert.strictEqual(r.score, 0); assert.strictEqual(r.source, 'replay');
  assert.strictEqual(r.reasons[0].text, 'liian vähän pelejä arvioon');
  assert.strictEqual(rr(null).sampleOk, false); assert.strictEqual(rr({}).sampleOk, false);
});
test('R6 replay: HS-% rajat (vaatii 20 tappoa)', () => {
  assert.strictEqual(rr({ matches: 1, rounds: 5, kills: 19, deaths: 5, headshots: 19 }).reasons.some((q) => q.kind === 'headshot'), false);
  const a = rr({ matches: 1, rounds: 5, kills: 20, deaths: 20, headshots: 13 }); // 65 %
  assert.deepStrictEqual([a.reasons[0].kind, a.reasons[0].weight, a.reasons[0].threshold], ['headshot', 1, 65]);
  const b = rr({ matches: 1, rounds: 5, kills: 20, deaths: 20, headshots: 16 }); // 80 %
  assert.deepStrictEqual([b.reasons[0].weight, b.reasons[0].threshold], [2, 80]);
  assert.ok(/Headshot-% 80,0 %.*raja 80 %/.test(b.reasons[0].text));
  assert.strictEqual(rr({ matches: 1, rounds: 5, kills: 20, deaths: 20, headshots: 12 }).reasons.length, 0); // 60 %
});
test('R6 replay: K/D (vähintään 3 ottelua tai 15 kierrosta) ja KPR (15 kierrosta)', () => {
  assert.strictEqual(rr({ matches: 2, rounds: 14, kills: 20, deaths: 4, headshots: 0 }).reasons.length, 0); // otos liian pieni
  const k1 = rr({ matches: 3, rounds: 14, kills: 15, deaths: 6, headshots: 0 }); // 2,5 ; KPR ei (14 krs)
  assert.deepStrictEqual(k1.reasons.map((q) => [q.kind, q.weight]), [['kd', 1]]);
  const k2 = rr({ matches: 1, rounds: 15, kills: 24, deaths: 6, headshots: 0 }); // K/D 4 -> 2 ; KPR 1,6 -> 1
  assert.deepStrictEqual(k2.reasons.map((q) => [q.kind, q.weight]), [['kd', 2], ['killsPerRound', 1]]);
  assert.strictEqual(k2.score, 3); assert.strictEqual(k2.level, 'watch');
  const k3 = rr({ matches: 5, rounds: 20, kills: 40, deaths: 8, headshots: 0 }); // KPR 2 -> 2 , K/D 5 -> 2
  assert.strictEqual(k3.score, 4); assert.strictEqual(k3.level, 'suspicious');
  assert.strictEqual(rr({ matches: 5, rounds: 20, kills: 10, deaths: 0, headshots: 0 }).reasons[0].value, 10); // 0 kuolemaa -> K/D = tapot
});
test('R6 replay: yksittäisen ottelun merkki (HS-% >= 85 vähintään 8 tapolla tai 12 tappoa <= 6 kierroksessa)', () => {
  const none = { matches: 0, rounds: 0, kills: 0, deaths: 0, headshots: 0 };
  const h1 = rr({ ...none, match: { kills: 8, headshots: 7, rounds: 8 } }); // 87,5 %
  assert.strictEqual(h1.sampleOk, true); assert.deepStrictEqual(h1.reasons.map((q) => [q.kind, q.weight]), [['singleMatch', 1]]);
  assert.strictEqual(rr({ ...none, match: { kills: 7, headshots: 7, rounds: 8 } }).sampleOk, false); // alle 8 tappoa
  assert.strictEqual(rr({ ...none, match: { kills: 10, headshots: 8, rounds: 9 } }).sampleOk, false); // 80 % < 85
  const f = rr({ ...none, match: { kills: 12, headshots: 0, rounds: 6 } });
  assert.deepStrictEqual(f.reasons.map((q) => q.kind), ['singleMatch']); assert.ok(f.reasons[0].text.includes('12 tappoa 6 kierroksessa'));
  assert.strictEqual(rr({ ...none, match: { kills: 12, headshots: 0, rounds: 7 } }).sampleOk, false);
  assert.strictEqual(rr({ ...none, match: { kills: 11, headshots: 0, rounds: 5 } }).sampleOk, false);
  // vain yksi tapaus lasketaan (HS-ehto ensin)
  assert.strictEqual(rr({ ...none, match: { kills: 12, headshots: 12, rounds: 6 } }).reasons.length, 1);
});
test('R6 replay: herkkyys (Tiukka -1, Pois piilottaa) ja pisteet -> taso', () => {
  const one = { matches: 3, rounds: 14, kills: 15, deaths: 6, headshots: 0 }; // 1 piste
  assert.strictEqual(S.evaluateR6Replay(one, 'normal').level, 'none');
  assert.strictEqual(S.evaluateR6Replay(one, 'strict').level, 'watch');
  assert.strictEqual(S.evaluateR6Replay(one, 'off'), null);
  assert.strictEqual(S.evaluateR6Replay(one).level, 'none'); // ilman herkkyyttä = normaali
  const three = { matches: 5, rounds: 20, kills: 24, deaths: 6, headshots: 18 }; // HS 75 -> 1, K/D 4 -> 2, KPR 1,2 -> 0
  assert.strictEqual(S.evaluateR6Replay(three, 'normal').level, 'watch');
  assert.strictEqual(S.evaluateR6Replay(three, 'strict').level, 'suspicious');
  const big = { matches: 5, rounds: 20, kills: 40, deaths: 8, headshots: 36 }; // HS 90 -> 2, K/D 5 -> 2, KPR 2 -> 2
  assert.strictEqual(S.evaluateR6Replay(big, 'normal').level, 'suspicious'); assert.strictEqual(S.evaluateR6Replay(big).score, 6);
  assert.strictEqual(S.R6_REPLAY_THRESHOLDS.singleMatch.hsMin, 85);
  assert.throws(() => { S.R6_REPLAY_THRESHOLDS.kd.minMatches = 1; }, TypeError);
  assert.strictEqual(S.withSensitivity(S.evaluateR6Replay(big), 'off'), null);
});
test('R6 suspicionOf: indeksirivi + yksittäinen ottelu', () => {
  const e = { matches: 5, rounds: 20, kills: 40, deaths: 8, headshots: 36 };
  assert.strictEqual(R6S.suspicionOf(e, 'normal').level, 'suspicious');
  assert.strictEqual(R6S.suspicionOf(e, 'off'), null);
  assert.strictEqual(R6S.suspicionOf(null, 'normal'), null);
  assert.ok(R6S.suspicionOf({ matches: 1, rounds: 6, kills: 12, deaths: 3, headshots: 1 }, 'strict', { kills: 12, headshots: 1, rounds: 6 }).reasons.some((q) => q.kind === 'singleMatch'));
});
test('R6 palvelu: syötteiden validointi (IPC)', () => {
  const V = R6Svc;
  assert.deepStrictEqual(V.validateOwnArg(undefined), { matchType: 'all' });
  assert.deepStrictEqual(V.validateOwnArg({ matchType: 'ranked' }), { matchType: 'ranked' });
  for (const bad of [5, [], { matchType: 'x' }, { matchType: 1 }, { evil: 1 }]) assert.throws(() => V.validateOwnArg(bad), /./, JSON.stringify(bad));
  assert.deepStrictEqual(V.validateMatchesArg(null), { page: 1, pageSize: 25, matchType: 'all' });
  for (const bad of [{ page: 0 }, { page: 1.5 }, { page: '1' }, { pageSize: 101 }, { matchType: 'q' }, { x: 1 }, 'a']) assert.throws(() => V.validateMatchesArg(bad), /./, JSON.stringify(bad));
  assert.strictEqual(V.validateMatchName('Match-2026-10-25_19-02-45-9292'), 'Match-2026-10-25_19-02-45-9292');
  for (const bad of ['', '../x', 'Match-../x', 'Match-a/b', 5, null, 'match-1', `Match-${'a'.repeat(101)}`]) assert.throws(() => V.validateMatchName(bad), /./, String(bad));
  assert.deepStrictEqual(V.validatePlayersArg({ search: ' Ab\u0001c ', sort: 'kd', flaggedOnly: true }), { search: 'Abc', sort: 'kd', page: 1, pageSize: 50, flaggedOnly: true });
  for (const bad of [{ sort: 'x' }, { search: 'x'.repeat(41) }, { search: 5 }, { flaggedOnly: 1 }, { pageSize: 0 }, { evil: 1 }, []]) assert.throws(() => V.validatePlayersArg(bad), /./, JSON.stringify(bad));
  assert.strictEqual(V.validateProfileId('d8591237-2892-4246-bb64-a668bd3bd7ba'), 'd8591237-2892-4246-bb64-a668bd3bd7ba');
  assert.strictEqual(V.validateProfileId('u:nimi_1'), 'u:nimi_1');
  for (const bad of ['', 'a b', 'a/b', '..\\x', 5, null, 'x'.repeat(81)]) assert.throws(() => V.validateProfileId(bad), /./, String(bad));
});
test('R6 palvelu: käynnistys, tallennus, oma nimi, live, päivitys ja historian säilyminen (valelähde)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6svc-'));
  const folderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6src-'));
  const ms = fixtures();
  // valejäsennin: kansion sisältö = JSON-tiedosto `m.json` (ei oikeita .rec-tiedostoja)
  const listing = () => fs.readdirSync(folderDir).filter((n) => /^Match-/.test(n)).sort().map((n) => path.join(folderDir, n));
  const lib = {
    ParseCache: class { get() {} set() {} },
    listMatchFolders: async (d) => { if (!fs.existsSync(d)) throw new Error('ei kansiota'); return fs.readdirSync(d).filter((n) => /^Match-/.test(n)).sort().map((n) => path.join(d, n)); },
    findReplayDirs: async () => [folderDir],
    parseMatchFolder: async (f) => {
      const s = JSON.parse(fs.readFileSync(path.join(f, 'm.json'), 'utf8'));
      return { dir: f, name: path.basename(f), rounds: [], stats: [], errors: [], summary: s };
    },
    createWatcher: () => ({ on() {}, async start() {}, stop() {} }),
  };
  const writeMatch = (m) => { const f = path.join(folderDir, m.name); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, 'm.json'), JSON.stringify(m)); const rec = path.join(f, 'a-R01.rec'); fs.writeFileSync(rec, 'x'.repeat(m.players.length)); const old = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(rec, old, old); }; // vanha mtime: ei näytä käynnissä olevalta
  ms.slice(0, 3).forEach(writeMatch);
  let st = { suspicionSensitivity: 'normal', r6Name: '', r6AutoName: true, r6ReplayDir: '' };
  const events = [];
  const mk = () => R6Svc.createR6Service({ dataDir: dir, getSettings: () => st, setSettings: (p) => { st = { ...st, ...p }; }, onChange: (p) => events.push(p), lib });
  let svc = mk();
  assert.strictEqual(svc.status().matchCount, 0); assert.strictEqual(svc.live().hasData, false);
  await svc.start();
  assert.strictEqual(svc.status().matchCount, 3); assert.strictEqual(svc.status().dir, folderDir);
  assert.strictEqual(st.r6Name, 'N-me-0000'); // oma nimi täyttyi automaattisesti
  assert.strictEqual(svc.ownId(), R6ME);
  const own = svc.own({ matchType: 'all' });
  assert.deepStrictEqual([own.hasOwn, own.matches, own.wins, own.losses], [true, 3, 2, 1]);
  const lv = svc.live();
  assert.deepStrictEqual([lv.hasData, lv.active, lv.match.name, lv.match.players.length, lv.match.result], [true, false, 'Match-3', 3, 'win']);
  const pa = lv.match.players.find((p) => p.profileID === 'a');
  assert.deepStrictEqual([pa.hist.matches, pa.hist.with.matches, pa.hist.against.matches], [2, 1, 1]); // aiemmin: M1 kanssa, M2 vastaan (M3 ei lasketa)
  assert.strictEqual(lv.match.players.find((p) => p.isOwn).hist, null);
  const list = svc.matches({ page: 1, pageSize: 2, matchType: 'all' });
  assert.deepStrictEqual([list.total, list.pages, list.items.length, list.items[0].name, list.items[0].score], [3, 2, 2, 'Match-3', [2, 0]]);
  assert.strictEqual(svc.matches({ matchType: 'unranked' }).total, 1);
  assert.strictEqual(svc.match('Match-2').players.length, 3);
  assert.throws(() => svc.match('Match-ei'), /ei löytynyt/);
  assert.throws(() => svc.match('../x'), /Virheellinen/);
  assert.strictEqual(svc.players({ search: 'n-a' }).total, 1);
  assert.strictEqual(svc.player('x').matchList.length, 3);
  assert.throws(() => svc.player('ei-ole'), /ei löytynyt/);
  // tallennettu tiedosto + uudelleenkäynnistys ei jäsennä uudelleen (sig täsmää)
  svc.stop();
  assert.ok(fs.existsSync(path.join(dir, 'r6-matches.json')));
  let parsed = 0;
  const origParse = lib.parseMatchFolder;
  lib.parseMatchFolder = async (...a) => { parsed++; return origParse(...a); };
  svc = mk();
  assert.strictEqual(svc.status().matchCount, 3); // heti levyltä
  await svc.start();
  assert.strictEqual(parsed, 0);
  // uusi ottelu ilmestyy -> jäsennetään vain se
  writeMatch(ms[3]);
  await svc.start();
  assert.strictEqual(parsed, 1); assert.strictEqual(svc.status().matchCount, 4);
  // peli poistaa vanhan tallennekansion -> historia säilyy
  fs.rmSync(path.join(folderDir, 'Match-1'), { recursive: true, force: true });
  await svc.start();
  assert.strictEqual(svc.status().matchCount, 4); assert.strictEqual(svc.own({}).matches, 4);
  // uloskirjautuneelle (r6AutoName=false) nimeä ei täytetä uudelleen
  st = { ...st, r6Name: '', r6AutoName: false };
  await svc.start();
  assert.strictEqual(st.r6Name, '');
  svc.stop();
  // viallinen tallennustiedosto ei kaada
  fs.writeFileSync(path.join(dir, 'r6-matches.json'), '{rikki');
  assert.strictEqual(mk().status().matchCount, 0);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(folderDir, { recursive: true, force: true });
});
test('R6 asetukset: sisäiset avaimet (r6AutoName, r6ReplayDir) eivät kelpaa IPC:ssä mutta säilyvät levyllä', () => {
  assert.ok(validate({ r6AutoName: false })); assert.ok(validate({ r6ReplayDir: 'C:\\x' }));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-set-'));
  const s = createSettings(d);
  assert.strictEqual(s.get().r6AutoName, true); assert.strictEqual(s.get().r6ReplayDir, '');
  s.set({ r6AutoName: false, r6ReplayDir: 'C:\\Peli\\MatchReplay' });
  const s2 = createSettings(d);
  assert.deepStrictEqual([s2.get().r6AutoName, s2.get().r6ReplayDir], [false, 'C:\\Peli\\MatchReplay']);
  assert.strictEqual(sanitize({ r6AutoName: 'ei' }).r6AutoName, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- R6: RP-muutos per ranked-ottelu (r6-rank, Arenyzen rank-historia) ------------------------------------------
const R6RK = require('../src/main/r6-rank');
// Ottelu, joka päättyy hetkellä endMs: viimeisen kierroksen alku (paikallisena) = loppu - 4 min.
function rkMatch(name, endMs, type = 'Ranked', own = true) {
  const m = fxMatch(name, endMs - 30 * 60000, type, 'Bank', 0, [2, 1], [[own ? R6ME : 'muu', 0, 5, 4, 2, 3], ['a', 1, 3, 3, 1, 3]], [[1, 0, 0, 'Attack', 'Defense']]);
  m.lastRoundTimestamp = wallZ(endMs - 4 * 60000);
  return m;
}
const RK0 = Date.UTC(2026, 9, 26, 12);
const RKM = 60000;
const rkHist = (...pairs) => pairs.map(([t, rp]) => ({ ts: RK0 + t * RKM, rp }));

test('R6 RP: yksi oma ranked-ottelu välillä -> delta, ennen ja jälkeen (myös tappio ja epäjärjestyksessä oleva historia)', () => {
  const m = [rkMatch('Match-A', RK0 + 30 * RKM)];
  const r = R6RK.attachRpDeltas(m, rkHist([0, 2500], [45, 2523]), { ownId: R6ME });
  assert.deepStrictEqual(r.get('Match-A'), { rpBefore: 2500, rpAfter: 2523, rpDelta: 23 });
  const loss = R6RK.attachRpDeltas(m, rkHist([45, 2481], [0, 2500]), { ownId: R6ME });
  assert.deepStrictEqual(loss.get('Match-A'), { rpBefore: 2500, rpAfter: 2481, rpDelta: -19 });
});
test('R6 RP: useita otteluita peräkkäin, kukin omalla välillään', () => {
  const m = [rkMatch('Match-A', RK0 + 30 * RKM), rkMatch('Match-B', RK0 + 90 * RKM), rkMatch('Match-C', RK0 + 150 * RKM)];
  const r = R6RK.attachRpDeltas(m, rkHist([0, 2500], [40, 2520], [100, 2502], [160, 2530]), { ownId: R6ME });
  assert.deepStrictEqual([r.get('Match-A').rpDelta, r.get('Match-B').rpDelta, r.get('Match-C').rpDelta], [20, -18, 28]);
});
test('R6 RP: kaksi ottelua saman välin sisällä -> ei deltaa kummallekaan (ei arvailua)', () => {
  const m = [rkMatch('Match-A', RK0 + 20 * RKM), rkMatch('Match-B', RK0 + 50 * RKM), rkMatch('Match-C', RK0 + 130 * RKM)];
  const r = R6RK.attachRpDeltas(m, rkHist([0, 2500], [60, 2540], [140, 2560]), { ownId: R6ME });
  assert.strictEqual(r.has('Match-A'), false); assert.strictEqual(r.has('Match-B'), false);
  assert.strictEqual(r.get('Match-C').rpDelta, 20, 'seuraava väli, jolla on vain yksi ottelu, saa deltan');
});
test('R6 RP: ei-ranked, "et ollut mukana", poissuljettu (käynnissä oleva) ja ottelu ilman väliä -> ei deltaa', () => {
  const h = rkHist([0, 2500], [45, 2523]);
  const opts = { ownId: R6ME };
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-U', RK0 + 30 * RKM, 'Unranked')], h, opts).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-Q', RK0 + 30 * RKM, 'QuickMatch')], h, opts).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-X', RK0 + 30 * RKM, 'Ranked', false)], h, opts).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-L', RK0 + 30 * RKM)], h, { ownId: R6ME, excludeName: 'Match-L' }).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-E', RK0 - 10 * RKM)], h, opts).size, 0, 'ennen ensimmäistä historiapistettä (ei "ennen"-arvoa)');
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-F', RK0 + 60 * RKM)], h, opts).size, 0, 'viimeisen historiapisteen jälkeen');
  assert.strictEqual(R6RK.attachRpDeltas([rkMatch('Match-A', RK0 + 30 * RKM)], h, { ownId: '' }).size, 0);
});
test('R6 RP: historiapiste yli 3 h ottelun päättymisen jälkeen -> ei deltaa; täsmälleen 3 h kelpaa', () => {
  const m = [rkMatch('Match-A', RK0 + 30 * RKM)];
  assert.strictEqual(R6RK.attachRpDeltas(m, rkHist([0, 2500], [30 + 181, 2523]), { ownId: R6ME }).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas(m, rkHist([0, 2500], [30 + 180, 2523]), { ownId: R6ME }).size, 1);
  assert.strictEqual(R6RK.attachRpDeltas(m, rkHist([0, 2500], [30 + 120, 2523]), { ownId: R6ME, maxLagMs: 60 * RKM }).size, 0, 'maxLagMs-asetus');
});
test('R6 RP: ei historiaa / liian vähän pisteitä / roskaa -> tyhjä tulos ilman virhettä', () => {
  const m = [rkMatch('Match-A', RK0 + 30 * RKM)];
  for (const h of [undefined, null, [], rkHist([0, 2500]), 'x', [null, { ts: 'a', rp: 1 }, { ts: 1 }]]) {
    assert.strictEqual(R6RK.attachRpDeltas(m, h, { ownId: R6ME }).size, 0);
  }
  assert.strictEqual(R6RK.attachRpDeltas(null, rkHist([0, 1], [10, 2]), { ownId: R6ME }).size, 0);
  assert.strictEqual(R6RK.attachRpDeltas(m, rkHist([0, 1], [10, 2])).size, 0);
});
test('R6 RP: aikaleima on paikallinen kellonaika Z:lla (ei UTC); mtime ensisijainen kun se täsmää', () => {
  // Kansio Match-2026-10-26_17-55-02 = paikallinen aika; viimeisen kierroksen alku "2026-10-26T18:26:51Z" = paikallinen 18:26:51.
  const localStart = new Date(2026, 9, 26, 18, 26, 51).getTime();
  assert.strictEqual(R6RK.localWallMs('2026-10-26T18:26:51Z'), localStart);
  assert.strictEqual(R6RK.localWallMs('2026-10-26T18:26:51'), localStart);
  assert.ok(Number.isNaN(R6RK.localWallMs('roska')) && Number.isNaN(R6RK.localWallMs(undefined)));
  const m = { timestamp: '2026-10-26T17:56:23Z', lastRoundTimestamp: '2026-10-26T18:26:51Z' };
  assert.strictEqual(R6RK.matchEndMs(m, 0), localStart + 4 * 60000, 'ilman mtimea: paikallinen viimeisen kierroksen alku + 4 min');
  assert.strictEqual(R6RK.matchEndMs(m, localStart + 3 * 60000), localStart + 3 * 60000, 'mtime täsmää (3 min kierroksen alusta) -> mtime');
  assert.strictEqual(R6RK.matchEndMs(m, localStart + 5 * 3600000), localStart + 4 * 60000, 'mtime kaukana (kopioitu/koskettu myöhemmin) -> paikallinen aika');
  assert.strictEqual(R6RK.matchEndMs({ timestamp: '2026-10-26T17:56:23Z' }, 0), new Date(2026, 9, 26, 17, 56, 23).getTime() + 4 * 60000, 'ilman lastRoundTimestampia: timestamp');
  assert.strictEqual(R6RK.matchEndMs({}, 12345), 12345, 'pelkkä mtime kelpaa');
  assert.strictEqual(R6RK.matchEndMs({}, 0), 0);
});
test('R6 aikaleima: wallTs / tsOf tulkitsevat Z:n paikalliseksi seinäkelloksi (ei riipu koneen aikavyöhykkeestä)', () => {
  const exp = (y, mo, d, h, mi, sec) => new Date(y, mo - 1, d, h, mi, sec).getTime(); // paikallinen, ei kovakoodattua UTC-millisekuntia
  assert.strictEqual(R6S.wallTs('2026-10-26T17:56:23Z'), exp(2026, 10, 26, 17, 56, 23));
  assert.strictEqual(R6S.wallTs('2026-10-26T17:56:23'), exp(2026, 10, 26, 17, 56, 23), 'ilman Z:aa sama');
  assert.strictEqual(R6S.wallTs('2026-10-26T17:56:23.000Z'), exp(2026, 10, 26, 17, 56, 23), 'millisekunnit ohitetaan');
  assert.strictEqual(R6S.wallTs('2026-07-01T00:00:00Z'), exp(2026, 7, 1, 0, 0, 0), 'kesäaika');
  assert.strictEqual(R6S.wallTs('2026-01-01T00:00:00Z'), exp(2026, 1, 1, 0, 0, 0), 'talviaika');
  assert.ok(Number.isNaN(R6S.wallTs('roska')) && Number.isNaN(R6S.wallTs(undefined)) && Number.isNaN(R6S.wallTs('')));
  const m = { timestamp: '2026-10-26T17:56:23Z' };
  assert.strictEqual(R6S.tsOf(m), exp(2026, 10, 26, 17, 56, 23));
  assert.strictEqual(R6S.tsOf({}), 0); assert.strictEqual(R6S.tsOf(null), 0); assert.strictEqual(R6S.tsOf({ timestamp: 'x' }), 0);
  // Sama funktio r6-rankissa (ei kahta toteutusta) ja wallZ-kiertomatka
  assert.strictEqual(R6RK.localWallMs, R6S.wallTs);
  const t = new Date(2026, 9, 26, 17, 56, 23).getTime();
  assert.strictEqual(R6S.wallTs(wallZ(t)), t);
  // Järjestys säilyy (siirtymä on vakio): aikaisempi aikaleima on aina ennen
  const sorted = R6S.sortChrono([{ name: 'b', players: [], timestamp: '2026-10-26T18:00:00Z' }, { name: 'a', players: [], timestamp: '2026-10-26T17:00:00Z' }, { name: 'c', players: [], timestamp: '2026-10-27T03:19:25Z' }]);
  assert.deepStrictEqual(sorted.map((x) => x.name), ['a', 'b', 'c']);
  // Vertailu oikeaan aikaan: tallenne, joka on alkanut paikallisesti 17:56 ja jonka tiedostot on kirjoitettu 17:58, ei ole "tulevaisuudessa" Date.now():iin nähden
  const nowMs = exp(2026, 10, 26, 18, 0, 0);
  assert.ok(R6S.tsOf(m) < nowMs && nowMs - R6S.tsOf(m) < 10 * 60000, 'ottelu ~4 min sitten, ei 2-3 h');
});
test('R6 ottelutyyppi 7: nimi taulukosta, vanha tallennettu "MatchType(7)" korjataan lukiessa, ryhmä "other"', () => {
  const T6 = require('../src/main/r6/dissect/tables');
  assert.strictEqual(T6.matchTypeName(7), T6.MATCH_TYPES[7]);
  assert.ok(!T6.matchTypeName(7).startsWith('MatchType('));
  assert.strictEqual(T6.matchTypeName(2), 'Ranked'); assert.strictEqual(T6.matchTypeName(99), 'MatchType(99)');
  const old = { matchType: { name: 'MatchType(7)', id: 7 }, players: [] };
  assert.strictEqual(R6S.typeName(old), T6.MATCH_TYPES[7]);
  assert.strictEqual(R6S.typeName({ matchType: { name: 'MatchType(99)', id: 99 } }), 'MatchType(99)');
  assert.strictEqual(R6S.typeName({ matchType: { name: 'Ranked', id: 1 } }), 'Ranked', 'tallennettu tunnettu nimi säilyy');
  assert.strictEqual(R6S.typeName({}), ''); assert.strictEqual(R6S.typeName(null), '');
  assert.strictEqual(R6S.typeKey(old), 'other');
  for (const f of ['ranked', 'unranked', 'quick']) assert.strictEqual(R6S.matchesFilter(old, f), false);
  assert.strictEqual(R6S.matchesFilter(old, 'all'), true);
});
test('R6 RP: delta löytyy oikeasta UTC-hetkestä, vaikka tallenteen "Z"-aikaleima on paikallista aikaa (mtime puuttuu)', () => {
  const end = Date.UTC(2026, 9, 26, 15, 30); // oikea UTC-hetki
  const m = rkMatch('Match-A', end);            // lastRoundTimestamp = paikallinen seinäkello + 'Z'
  const r = R6RK.attachRpDeltas([m], [{ ts: end - 40 * RKM, rp: 3000 }, { ts: end + 5 * RKM, rp: 3021 }], { ownId: R6ME });
  assert.strictEqual(r.get('Match-A').rpDelta, 21);
});
test('R6 RP: mtimes-kartta (Map tai olio) kelpaa, kun se täsmää; muuten käytetään seinäkelloa', () => {
  const m = rkMatch('Match-A', RK0 + 30 * RKM);
  const h = rkHist([0, 2500], [45, 2523]);
  assert.strictEqual(R6RK.attachRpDeltas([m], h, { ownId: R6ME, mtimes: { 'Match-A': RK0 + 33 * RKM } }).get('Match-A').rpDelta, 23);
  assert.strictEqual(R6RK.attachRpDeltas([m], h, { ownId: R6ME, mtimes: new Map([['Match-A', RK0 + 33 * RKM]]) }).get('Match-A').rpDelta, 23);
  // mtime 50 min seinäkellosta -> yli 20 min, käytetään seinäkelloa (30 + 4 min) -> delta säilyy
  assert.strictEqual(R6RK.attachRpDeltas([m], h, { ownId: R6ME, mtimes: { 'Match-A': RK0 + 80 * RKM } }).get('Match-A').rpDelta, 23);
});
test('R6 RP: r6-service liittää RP-muutoksen ottelulistaan vain kun historia annetaan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6rp-'));
  const m1 = rkMatch('Match-2026-10-26_17-55-02', RK0 + 30 * RKM), m2 = rkMatch('Match-2026-10-26_18-55-02', RK0 + 100 * RKM, 'Unranked');
  const rec = (m, end) => ({ v: R6Svc.STORE_VERSION, sig: 'x', lastMtime: end, parsedAt: end, summary: m });
  fs.writeFileSync(path.join(dir, 'r6-matches.json'), JSON.stringify({ version: R6Svc.STORE_VERSION, matches: { [m1.name]: rec(m1, RK0 + 32 * RKM), [m2.name]: rec(m2, RK0 + 102 * RKM) } }));
  const svc = R6Svc.createR6Service({ dataDir: dir, getSettings: () => ({ suspicionSensitivity: 'normal', r6Name: '', r6AutoName: false, r6ReplayDir: '' }), setSettings() {}, onChange() {}, lib: {} });
  assert.ok(svc.matches({}).items.every((i) => i.rp === null), 'ilman historiaa ei RP-chipejä');
  const h = rkHist([0, 2500], [45, 2523], [120, 2530]);
  const items = svc.matches({}, { rpHistory: h }).items;
  const a = items.find((i) => i.name === m1.name), b = items.find((i) => i.name === m2.name);
  assert.deepStrictEqual(a.rp, { rpBefore: 2500, rpAfter: 2523, rpDelta: 23 });
  assert.strictEqual(b.rp, null, 'Unranked ei saa deltaa');
  assert.strictEqual(svc.matches({}, { rpHistory: h }).items.find((i) => i.name === m1.name).rp.rpDelta, 23, 'toinen kutsu (muistista)');
  assert.deepStrictEqual(a.own.operators, [{ name: 'Ash', rounds: 3 }]);
  assert.strictEqual(a.own.entryKills, null, 'ilman adv-dataa entry puuttuu');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Pelaajaprofiilit, "Edellinen"-merkki ja lobbyistunnot (r6-stats, rl-core, ow-lobbies, game-detect) -------------------
const Lob = require('../src/main/ow-lobbies');
const GD = require('../src/main/game-detect');

test('R6 edellinen ottelu: ei-live = ottelua edeltävä, live = uusin muu; vain ottelut joissa olit mukana', () => {
  const ms = fixtures();
  assert.strictEqual(R6S.previousMatch(ms, ms[3], R6ME).name, 'Match-3');
  assert.strictEqual(R6S.previousMatch(ms, ms[1], R6ME).name, 'Match-1');
  assert.strictEqual(R6S.previousMatch(ms, ms[0], R6ME), null);
  assert.strictEqual(R6S.previousMatch(ms, ms[0], R6ME, { live: true }).name, 'Match-4'); // live: uusin muu ottelu (ts ei ratkaise)
  assert.strictEqual(R6S.previousMatch(ms, ms[3], R6ME, { live: true }).name, 'Match-3');
  // ottelu, jossa oma pelaaja ei ole mukana, ohitetaan
  const foreign = fxMatch('Match-3', R6T0 + 2 * R6HR, 'Ranked', 'Bank', 0, [2, 0], [['q', 0, 1, 1, 0, 2], ['r', 1, 1, 1, 0, 2]], [[1, 0, 0, 'Attack', 'Defense'], [2, 0, 0, 'Defense', 'Attack']], { ownTeamIndex: -1, recordingProfileID: 'q' });
  assert.strictEqual(R6S.previousMatch([ms[0], ms[1], foreign, ms[3]], ms[3], R6ME).name, 'Match-2');
  assert.strictEqual(R6S.previousMatch(ms, null, R6ME), null);
});
test('R6 edellinen ottelu: kuka oli kanssa / vastaan (oma pelaaja pois)', () => {
  const ms = fixtures();
  const e1 = R6S.previousEncounters(ms[0], R6ME); // M1: a kanssa, x vastaan
  assert.deepStrictEqual([e1.get('a'), e1.get('x'), e1.has(R6ME)], ['with', 'against', false]);
  const e2 = R6S.previousEncounters(ms[1], R6ME); // M2: oma tiimi 1; a ja x tiimissä 0 -> vastaan
  assert.deepStrictEqual([e2.get('a'), e2.get('x')], ['against', 'against']);
  assert.strictEqual(R6S.previousEncounters(null, R6ME).size, 0);
  assert.strictEqual(R6S.previousEncounters({ ...ms[0], ownTeamIndex: -1 }, R6ME).size, 0);
  const info = R6S.previousInfo(ms[2]);
  assert.deepStrictEqual([info.name, info.map, info.type, info.result], ['Match-3', 'Bank', 'Ranked', 'win']);
});
test('R6 pelaajaprofiili: ottelulista pelaajan näkökulmasta, operaattorit, kartat, kanssa/vastaan', () => {
  const ms = fixtures();
  const pr = R6S.buildPlayerProfile(ms, R6ME, 'a');
  assert.strictEqual(pr.entry.matches, 4);
  assert.deepStrictEqual(pr.matchList.map((m) => m.name), ['Match-4', 'Match-3', 'Match-2', 'Match-1']); // uusin ensin
  assert.deepStrictEqual(pr.matchList.map((m) => m.playerResult), ['win', 'loss', 'win', 'win']); // pelaajan oma tulos
  assert.deepStrictEqual(pr.matchList.map((m) => m.side), ['with', 'against', 'against', 'with']);
  assert.deepStrictEqual(pr.matchList.map((m) => m.result), ['win', 'win', 'loss', 'win']); // sinun tuloksesi
  assert.deepStrictEqual(pr.matchList[1].teamScore, [0, 2]); // M3: a oli tiimissä 1 (0 voittoa) vastaan 2
  assert.deepStrictEqual(pr.matchList[3].operators, [{ name: 'Ash', rounds: 3 }]);
  assert.deepStrictEqual([pr.matchList[1].kills, pr.matchList[1].deaths, pr.matchList[1].assists], [1, 4, 0]);
  const ash = pr.operators.find((o) => o.name === 'Ash');
  assert.deepStrictEqual([ash.rounds, ash.kd], [10, 0.73]); // kierrokset 3+2+2+3, tapot 8, kuolemat 11
});
test('R6 pelaajaprofiili: tuntematon avain -> null, kartat ja pelaajan V-H', () => {
  const ms = fixtures();
  assert.strictEqual(R6S.buildPlayerProfile(ms, R6ME, 'ei-ole'), null);
  const pr = R6S.buildPlayerProfile(ms, R6ME, 'x');
  const bank = pr.maps.find((m) => m.name === 'Bank');
  assert.deepStrictEqual([pr.maps.length, bank.matches, bank.wins, bank.losses], [2, 2, 0, 2]); // x hävisi molemmat Bank-ottelut (M1, M3)
  const oregon = pr.maps.find((m) => m.name === 'Oregon');
  assert.deepStrictEqual([oregon.wins, oregon.losses], [1, 0]);
});

// ---- R6: edistyneet kierrostilastot (r6-advanced) --------------------------------------------------
const ADV = require('../src/main/r6-advanced');
// Synteettinen kierros. a/b = tiimien 0/1 pelaajat; feed: [tyyppi, tekijä, kohde, aika]; winner 0/1/-1; opts: { matchType, roles, startOnly }
function advRound(a, b, feed, winner, opts = {}) {
  const ev = feed.map(([type, username, target, t]) => ({ type: { name: type }, username, target: target || '', time: '', timeInSeconds: t }));
  const roles = opts.roles || ['Attack', 'Defense'];
  return {
    matchType: { id: opts.matchType || 2, name: opts.matchType === 13 ? 'TeamDeathmatch' : 'Ranked' }, gamemode: { name: 'Bomb' }, roundNumber: opts.roundNumber || 0,
    teams: [0, 1].map((i) => ({ startingScore: 0, score: winner === i ? 1 : 0, won: winner === i, role: roles[i] })),
    players: [...a.map((u) => ({ username: u, teamIndex: 0, profileID: `p-${u}` })), ...b.map((u) => ({ username: u, teamIndex: 1, profileID: `p-${u}` }))],
    matchFeedback: opts.feed === false ? [] : ev, stats: [],
  };
}
const A3 = ['A1', 'A2', 'A3'], B3 = ['B1', 'B2', 'B3'];
const rowOf = (res, u) => res.rows.find((r) => r.username === u);

test('R6 advanced: entry kill/death, trade ikkunan sisällä ja ulkopuolella, tradattu kuolema, selviytyminen, KOST', () => {
  const r = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'A2', 'B1', 165], ['Kill', 'B2', 'A2', 100], ['Kill', 'A3', 'B2', 85]], 0));
  assert.strictEqual(r.skip, null);
  assert.ok(rowOf(r, 'B1').entryKill && rowOf(r, 'A1').entryDeath);
  assert.strictEqual(r.rows.filter((x) => x.entryKill).length, 1); assert.strictEqual(r.rows.filter((x) => x.entryDeath).length, 1);
  assert.ok(rowOf(r, 'A2').tradeKills === 1 && rowOf(r, 'A1').tradedDeath, 'A2 kosti A1:n 5 s kuluessa');
  assert.ok(rowOf(r, 'A3').tradeKills === 0 && !rowOf(r, 'A2').tradedDeath, 'A3:n tappo 15 s myöhemmin ei ole trade');
  assert.ok(rowOf(r, 'A3').survived && !rowOf(r, 'A1').survived && rowOf(r, 'B3').survived);
  assert.ok(rowOf(r, 'A1').kost && rowOf(r, 'A1').kills === 0, 'KOST pelkästä tradatusta kuolemasta');
  assert.ok(rowOf(r, 'A2').kost && rowOf(r, 'A2').dead && !rowOf(r, 'A2').tradedDeath, 'KOST pelkästä tapposta');
  assert.strictEqual(ADV.TRADE_WINDOW_S, 10);
});
test('R6 advanced: trade-ikkunan raja (10 s mukaan, 11 s ei) ja tradet vain saman vaiheen sisällä asennukseen nähden', () => {
  const t = (dt) => ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 100], ['Kill', 'A2', 'B1', 100 - dt]], 0));
  assert.ok(rowOf(t(10), 'A2').tradeKills === 1 && rowOf(t(10), 'A1').tradedDeath);
  assert.ok(rowOf(t(11), 'A2').tradeKills === 0 && !rowOf(t(11), 'A1').tradedDeath);
  assert.ok(rowOf(t(0), 'A2').tradeKills === 1, 'sama sekunti = trade');
  // vihollisen tappamaa tiimikaveria ei kosta eri vihollinen -> ei tradea; kello nousee (eri vaihe) -> ei tradea
  const other = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 100], ['Kill', 'A2', 'B2', 95]], 0));
  assert.ok(rowOf(other, 'A2').tradeKills === 0 && !rowOf(other, 'A1').tradedDeath);
  const up = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 40], ['Kill', 'A2', 'B1', 43]], 0));
  assert.ok(rowOf(up, 'A2').tradeKills === 0);
  const phase = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 60], ['DefuserPlantComplete', 'A3', '', 50], ['Kill', 'A2', 'B1', 45]], 0));
  assert.ok(rowOf(phase, 'A2').tradeKills === 0, 'asennuksen yli ei verrata kelloja');
  // uhri on tiimikaverin tappaja vain oikeassa tiimissä: oman tiimin tappo ei ole trade
  const tk = ADV.computeRound(advRound(A3, B3, [['Kill', 'A1', 'A2', 100], ['Kill', 'A3', 'A1', 95]], 0));
  assert.ok(rowOf(tk, 'A3').tradeKills === 0 && rowOf(tk, 'A3').kills === 0 && !rowOf(tk, 'A2').tradedDeath);
});
test('R6 advanced: tiimitappo, itsemurha ja rosterin ulkopuolinen tappaja eivät ole tappoja eivätkä entry; clutch 1v3 tappio', () => {
  const r = ADV.computeRound(advRound(A3, B3, [['Death', 'A1', '', 160], ['Kill', 'A2', 'A3', 150], ['Kill', 'B1', 'A2', 140]], 1));
  assert.strictEqual(rowOf(r, 'A2').kills, 0); assert.strictEqual(rowOf(r, 'A3').kills, 0);
  assert.ok(!rowOf(r, 'A1').entryDeath && !rowOf(r, 'A3').entryDeath, 'itsemurha / tiimitapon uhri ei ole entry-kuolema');
  assert.ok(rowOf(r, 'B1').entryKill && rowOf(r, 'A2').entryDeath);
  for (const u of A3) assert.ok(!rowOf(r, u).kost, `${u} ilman KOST:ia`);
  for (const u of B3) assert.ok(rowOf(r, u).kost);
  assert.deepStrictEqual([rowOf(r, 'A2').clutchX, rowOf(r, 'A2').clutchWon], [3, false], 'A2 jäi viimeiseksi 3 vihollista vastaan ja hävisi');
  const ghost = ADV.computeRound(advRound(A3, B3, [['Kill', 'Ghost', 'A1', 170], ['Kill', 'B1', 'A2', 160]], 1));
  assert.ok(rowOf(ghost, 'B1').entryKill && rowOf(ghost, 'A2').entryDeath && !rowOf(ghost, 'A1').entryDeath);
  assert.ok(!rowOf(ghost, 'A1').survived, 'rosterin ulkopuolisen tappamana kuollut ei ole selviytynyt');
  // sama kuolema kahdesti -> toinen ohitetaan
  const dup = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'B2', 'A1', 169]], 1));
  assert.strictEqual(rowOf(dup, 'B2').kills, 0);
});
test('R6 advanced: clutch 1v1 / 1v3 voitto, multikill ja trade-tappo kerran tappoa kohti', () => {
  const r = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'B2', 'A2', 160], ['Kill', 'A3', 'B2', 150], ['Kill', 'A3', 'B1', 120], ['Kill', 'A3', 'B3', 100]], 0));
  const a3 = rowOf(r, 'A3');
  assert.deepStrictEqual([a3.clutchX, a3.clutchWon, a3.kills, a3.tradeKills], [3, true, 3, 1]);
  assert.ok(rowOf(r, 'A2').tradedDeath && !rowOf(r, 'A1').tradedDeath);
  // B: B2 kuoli (B:ssä 2 elossa), sitten B1 -> B3 viimeinen A3:a vastaan = 1v1 (hävisi, B3 ei tehnyt mitään)
  assert.deepStrictEqual([rowOf(r, 'B3').clutchX, rowOf(r, 'B3').clutchWon], [1, false]);
  const m = ADV.computeMatch([advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'B2', 'A2', 160], ['Kill', 'A3', 'B2', 150], ['Kill', 'A3', 'B1', 120], ['Kill', 'A3', 'B3', 100]], 0)]);
  const a = m.players.get('A3');
  assert.deepStrictEqual([a.ca, a.cw, a.mk], [[0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 1, 0, 0]]);
  // ei tunnettua voittajaa -> clutch ohitetaan
  const nw = ADV.computeRound(advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'B2', 'A2', 160]], -1));
  assert.ok(nw.rows.every((x) => x.clutchX === 0));
  const one = ADV.computeRound(advRound(['A1', 'A2'], ['B1', 'B2'], [['Kill', 'A1', 'B1', 170], ['Kill', 'B2', 'A2', 160]], 0));
  assert.deepStrictEqual([rowOf(one, 'B2').clutchX, rowOf(one, 'B2').clutchWon, rowOf(one, 'A1').clutchX, rowOf(one, 'A1').clutchWon], [2, false, 1, true], 'B2 1v2 (hävisi), sitten A1 1v1 (voitti)');
});
test('R6 advanced: multikillit 2K / 3K / 4K / ace, overtime-kierros mukana', () => {
  const A5 = ['A1', 'A2', 'A3', 'A4', 'A5'], B5 = ['B1', 'B2', 'B3', 'B4', 'B5'];
  const kills = (n) => B5.slice(0, n).map((b, i) => ['Kill', 'A1', b, 170 - i * 20]);
  const rounds = [2, 3, 4, 5].map((n, i) => advRound(A5, B5, kills(n), 0, { roundNumber: 6 + i })); // roundNumber >= roundsPerMatch = overtime
  const m = ADV.computeMatch(rounds);
  assert.deepStrictEqual(m.players.get('A1').mk, [1, 1, 1, 1]);
  assert.strictEqual(m.players.get('A1').r, 4); assert.strictEqual(m.players.get('A1').kl, 14);
  assert.strictEqual(m.players.get('A1').ek, 4, 'entry-tappo joka kierroksella');
  assert.strictEqual(ADV.finalize(m.players.get('A1')).multi.ace, 1);
});
test('R6 advanced: plantit ja purut (tekijä vain Start-tapahtumalla), objektiivi-KOST, tunnistamaton tekijä', () => {
  const feed = [['Kill', 'B1', 'A2', 170], ['DefuserPlantStart', 'A1', '', 150], ['DefuserPlantComplete', 'A1', '', 143], ['Kill', 'B2', 'A1', 120],
    ['DefuserDisableStart', 'B3', '', 100], ['DefuserDisableComplete', 'B3', '', 92]];
  const r = ADV.computeRound(advRound(A3, B3, feed, 1));
  assert.ok(rowOf(r, 'A1').plants === 1 && rowOf(r, 'A1').kost && rowOf(r, 'A1').kills === 0 && rowOf(r, 'A1').dead, 'asentaja saa KOST:n objektiivista');
  assert.strictEqual(rowOf(r, 'B3').defuses, 1);
  assert.strictEqual(r.objUnknown, 0);
  // purku, vaikka puolustaja hävisi -> hylätään; asennus ilman Start-tapahtumaa -> tunnistamaton (jäsennin arvaa rosterin 1. pelaajan)
  const badRound = advRound(A3, B3, [['Kill', 'B1', 'A2', 170], ['DefuserPlantComplete', 'A1', '', 143], ['DefuserDisableStart', 'B3', '', 100], ['DefuserDisableComplete', 'B3', '', 92]], 0);
  const bad = ADV.computeRound(badRound);
  assert.ok(bad.rows.every((x) => x.plants === 0 && x.defuses === 0));
  assert.strictEqual(bad.objUnknown, 1);
  assert.strictEqual(ADV.finalize(ADV.computeMatch([advRound(A3, B3, feed, 1), badRound]).players.get('A1')).plants, 1);
  assert.strictEqual(ADV.finalize(ADV.computeMatch([advRound(A3, B3, feed, 1), badRound]).players.get('A1')).objectiveUnknown, 1);
});
test('R6 advanced: Y11S3-jäsentimen tuottama tekijä (Start + Complete) hyväksytään, kuollut tai nimetön tekijä ei', () => {
  // jäsennin nimeää tekijän pelaajahahmon kautta (dissect/defuse.js): Start-tapahtuma tulee vain tunnistetulle tekijälle
  const ok = ADV.computeRound(advRound(A3, B3, [['DefuserPlantStart', 'A2', '', 150], ['DefuserPlantComplete', 'A2', '', 143],
    ['DefuserDisableStart', 'B1', '', 100], ['DefuserDisableComplete', 'B1', '', 92]], 1));
  assert.strictEqual(rowOf(ok, 'A2').plants, 1);
  assert.strictEqual(rowOf(ok, 'B1').defuses, 1);
  assert.strictEqual(ok.objUnknown, 0);
  // tekijä kuollut jo ennen asennusta -> ei hyväksytä vaikka Start löytyy (feedin järjestys on ristiriidassa)
  const dead = ADV.computeRound(advRound(A3, B3, [['DefuserPlantStart', 'A1', '', 150], ['Kill', 'B1', 'A1', 148], ['DefuserPlantComplete', 'A1', '', 143]], 0));
  assert.strictEqual(rowOf(dead, 'A1').plants, 0);
  assert.strictEqual(dead.objUnknown, 1);
  // nimetön Complete (jäsennin ei tunnistanut tekijää) ja väärän puolen tekijä lasketaan tunnistamattomaksi
  const anon = ADV.computeRound(advRound(A3, B3, [['DefuserPlantComplete', '', '', 143], ['DefuserPlantStart', 'B2', '', 100], ['DefuserPlantComplete', 'B2', '', 92]], 0));
  assert.ok(anon.rows.every((x) => x.plants === 0));
  assert.strictEqual(anon.objUnknown, 2);
  // kuollut purkaja hylätään myös
  const deadDef = ADV.computeRound(advRound(A3, B3, [['DefuserPlantStart', 'A1', '', 150], ['DefuserPlantComplete', 'A1', '', 143], ['DefuserDisableStart', 'B1', '', 100],
    ['Kill', 'A2', 'B1', 98], ['DefuserDisableComplete', 'B1', '', 92]], 1));
  assert.strictEqual(rowOf(deadDef, 'B1').defuses, 0);
  assert.strictEqual(deadDef.objUnknown, 1);
  assert.strictEqual(rowOf(deadDef, 'A1').plants, 1);
});
test('R6 advanced: TDM ohitetaan, puutteellinen feedi ohitetaan, muut kierrokset lasketaan', () => {
  assert.strictEqual(ADV.computeRound(advRound(A3, B3, [['Kill', 'A1', 'B1', 100]], 0, { matchType: 13 })).skip, 'tdm');
  assert.strictEqual(ADV.computeMatch([advRound(A3, B3, [['Kill', 'A1', 'B1', 100]], 0, { matchType: 13 })]), null);
  assert.strictEqual(ADV.computeRound(advRound(A3, B3, [], 0, { feed: false })).skip, 'noFeedback');
  assert.strictEqual(ADV.computeRound(advRound(A3, B3, [['OperatorSwap', 'A1', '', 5]], 0)).skip, 'noFeedback');
  const sb = advRound(A3, B3, [['DefuserPlantComplete', 'A1', '', 100]], 0);
  assert.strictEqual(ADV.computeRound(sb).skip, null, 'asennus ilman tappoja ja ilman pistetaulun tappoja on kelvollinen kierros');
  sb.stats = [{ username: 'A1', sbKills: 2 }];
  assert.strictEqual(ADV.computeRound(sb).skip, 'noFeedback', 'pistetaulu näyttää tappoja, feedissä ei yhtään');
  assert.strictEqual(ADV.computeRound({ matchFeedback: [], players: [] }).skip, 'noRoster');
  assert.strictEqual(ADV.computeRound(null).skip, 'noRoster');
  const m = ADV.computeMatch([advRound(A3, B3, [['Kill', 'B1', 'A1', 100]], 1), advRound(A3, B3, [], 1, { feed: false }), advRound(A3, B3, [['Kill', 'A1', 'B1', 100]], 0, { matchType: 13 })]);
  assert.strictEqual(m.meta.used, 1); assert.deepStrictEqual(m.meta.skipped, { tdm: 1, noFeedback: 1, noRoster: 0 });
  assert.strictEqual(m.players.get('A1').r, 1);
});
test('R6 advanced: KOST-%, entry-%, summaus ja näyttömuoto', () => {
  const rounds = [
    advRound(A3, B3, [['Kill', 'B1', 'A1', 170], ['Kill', 'A2', 'B1', 165], ['Kill', 'B2', 'A2', 100], ['Kill', 'A3', 'B2', 85]], 0),
    advRound(A3, B3, [['Death', 'A1', '', 160], ['Kill', 'A2', 'A3', 150], ['Kill', 'B1', 'A2', 140]], 1),
  ];
  const m = ADV.computeMatch(rounds);
  const f = ADV.finalize(m.players.get('A1')); // R1: tradattu kuolema -> KOST, R2: itsemurha ilman KOST:ia
  assert.deepStrictEqual([f.rounds, f.kostRounds, f.kost], [2, 1, 50]);
  const f2 = ADV.finalize(m.players.get('A2')); // R1 tappo, R2 teamkill + entry-kuolema
  assert.deepStrictEqual([f2.kostRounds, f2.kost, f2.entryDeaths, f2.entryKills, f2.entryPct], [1, 50, 1, 0, 0]);
  const b1 = ADV.finalize(m.players.get('B1'));
  assert.deepStrictEqual([b1.entryKills, b1.entryDeaths, b1.entryPct, b1.kost], [2, 0, 100, 100]);
  // summaus ja virheellisen syötteen ohitus
  const s = ADV.sumAdv([m.players.get('A1'), m.players.get('A2'), null, {}, { r: 'x' }]);
  assert.strictEqual(s.r, 4); assert.strictEqual(ADV.finalize(s).kost, 50);
  assert.strictEqual(ADV.sumAdv([null, undefined]), null); assert.strictEqual(ADV.finalize(null), null); assert.strictEqual(ADV.finalize({ r: 0 }), null);
  // JSON-kierto (levyltä)
  assert.deepStrictEqual(ADV.finalize(JSON.parse(JSON.stringify(m.players.get('A2')))), f2);
});
test('R6 advanced: omat summat, KOST-sarja, pelaajaindeksi ja KOST-lajittelu (r6-stats)', () => {
  const ms = fixtures();
  const stamp = (m, id, adv) => { m.players.find((p) => p.profileID === id).adv = adv; };
  const mk = (r, kr, ek, ed) => Object.assign(ADV.emptyAdv(), { r, kr, ek, ed, kl: 5, dt: 3, tk: 1, td: 2, sv: 2, ca: [1, 0, 0, 0, 0], cw: [1, 0, 0, 0, 0], mk: [1, 0, 0, 0] });
  stamp(ms[0], R6ME, mk(3, 2, 1, 1)); stamp(ms[2], R6ME, mk(2, 2, 0, 1)); stamp(ms[0], 'a', mk(3, 1, 0, 0)); stamp(ms[1], 'a', mk(2, 2, 0, 0)); stamp(ms[0], 'x', mk(3, 3, 0, 0));
  const a = R6S.aggregateOwn(ms, R6ME);
  assert.strictEqual(a.advMatches, 2);
  assert.deepStrictEqual([a.adv.rounds, a.adv.kostRounds, a.adv.kost, a.adv.entryKills, a.adv.entryDeaths, a.adv.entryPct], [5, 4, 80, 1, 2, 33.3]);
  assert.deepStrictEqual([a.adv.clutch.attemptsTotal, a.adv.clutch.winsTotal, a.adv.clutch.winPct, a.adv.multi.k2, a.adv.tradeKills, a.adv.tradedDeaths], [2, 2, 100, 2, 2, 4]);
  assert.deepStrictEqual(a.series.kost.map((p) => [p.i, p.value]), [[1, 66.7], [3, 100]]);
  assert.strictEqual(R6S.aggregateOwn(ms, R6ME, { matchType: 'unranked' }).adv, null, 'ei dataa -> null');
  assert.strictEqual(R6S.aggregateOwn(fixtures(), R6ME).adv, null);
  assert.strictEqual(R6S.aggregateOwn(ms, R6ME, { matchType: 'ranked' }).adv.rounds, 5);
  const idx = R6S.buildPlayersIndex(ms, R6ME);
  assert.deepStrictEqual([idx.get('a').kost, idx.get('a').adv.rounds, idx.get('x').kost, idx.get(R6ME).kost], [60, 5, 100, 80]);
  assert.strictEqual(idx.get('a').advList, undefined);
  assert.deepStrictEqual(R6S.listPlayers(idx, { sort: 'kost' }).players.map((p) => p.profileID), ['x', 'a']);
  const none = R6S.buildPlayersIndex(fixtures(), R6ME);
  assert.strictEqual(none.get('a').kost, null);
  assert.deepStrictEqual(R6S.listPlayers(none, { sort: 'kost' }).players.map((p) => p.profileID), ['a', 'x'], 'ilman dataa: matches-tasaus');
  assert.ok(R6S.SORTS.includes('kost'));
  const pm = R6S.playerMatches(ms, R6ME, 'a');
  assert.deepStrictEqual(pm.map((m) => m.kost), [null, null, 100, 33.3]);
  assert.strictEqual(R6S.ownEntry(ms[0], R6ME).kost, 66.7);
});
test('R6 palvelu: edistyneet tilastot tallentuvat yhteenvetoon, vanhat tietueet täydennetään taustalla ja kadonneet kansiot jäävät ilman', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6adv-'));
  const folderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6advsrc-'));
  const ms = fixtures().slice(0, 3); // Match-1, 2, 3
  // tallennettu vanha (v1) tiedosto: kaikki kolme ottelua ilman adv-kenttää
  const old = {};
  for (const m of ms) old[m.name] = { v: 1, sig: 'vanha', lastMtime: 0, parsedAt: 1, summary: m };
  fs.writeFileSync(path.join(dir, 'r6-matches.json'), JSON.stringify({ version: 1, matches: old }));
  // vain Match-3:n kansio on vielä olemassa; sen kierrokset: oma pelaaja tekee entry-tapon
  const f3 = path.join(folderDir, 'Match-3'); fs.mkdirSync(f3);
  const rec = path.join(f3, 'a-R01.rec'); fs.writeFileSync(rec, 'x'); fs.utimesSync(rec, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const rounds = [advRound([`N-${R6ME}`, 'N-a'], ['N-x'], [['Kill', `N-${R6ME}`, 'N-x', 170]], 0)];
  let backfillSeen = null, svc = null;
  const lib = {
    ParseCache: class { get() {} set() {} },
    listMatchFolders: async (d) => fs.readdirSync(d).filter((n) => /^Match-/.test(n)).sort().map((n) => path.join(d, n)),
    findReplayDirs: async () => [folderDir],
    parseMatchFolder: async (f) => { backfillSeen = svc.status().scanning; return { dir: f, name: path.basename(f), rounds, stats: [], errors: [], summary: JSON.parse(JSON.stringify(ms[2])) }; },
    createWatcher: () => ({ on() {}, async start() {}, stop() {} }),
  };
  svc = R6Svc.createR6Service({ dataDir: dir, getSettings: () => ({ suspicionSensitivity: 'normal', r6Name: 'x', r6AutoName: true, r6ReplayDir: '' }), setSettings() {}, onChange() {}, lib });
  assert.strictEqual(svc.status().matchCount, 3);
  assert.strictEqual(svc.own({}).adv, null, 'ennen täydennystä ei adv-dataa');
  await svc.start();
  assert.deepStrictEqual([backfillSeen.total, backfillSeen.backfill], [1, 1], 'täydennys näkyy skannauksen tilassa');
  assert.strictEqual(svc.records.get('Match-3').v, R6Svc.STORE_VERSION); assert.strictEqual(R6Svc.STORE_VERSION, 3);
  assert.strictEqual(svc.records.get('Match-1').v, 1, 'kadonnut kansio: vanha tietue säilyy');
  assert.ok(!svc.records.get('Match-1').summary.players.some((p) => p.adv));
  const me3 = svc.records.get('Match-3').summary.players.find((p) => p.profileID === R6ME);
  assert.deepStrictEqual([me3.adv.r, me3.adv.ek, me3.adv.kr], [1, 1, 1]);
  assert.strictEqual(svc.records.get('Match-3').summary.advV, ADV.ADV_VERSION);
  const own = svc.own({});
  assert.deepStrictEqual([own.matches, own.advMatches, own.adv.entryKills, own.adv.kost], [3, 1, 1, 100]);
  const mv = svc.match('Match-3');
  assert.strictEqual(mv.hasAdv, true); assert.strictEqual(mv.players.find((p) => p.isOwn).adv.entryKills, 1);
  assert.strictEqual(svc.match('Match-1').hasAdv, false); assert.strictEqual(svc.match('Match-1').players[0].adv, null);
  assert.strictEqual(svc.matches({}).items.find((i) => i.name === 'Match-3').own.kost, 100);
  assert.strictEqual(svc.matches({}).items.find((i) => i.name === 'Match-1').own.kost, null);
  const pl = svc.players({ sort: 'kost' });
  assert.strictEqual(pl.players[0].kost, 100); assert.strictEqual(pl.players[0].advRounds, 1);
  assert.strictEqual(svc.player('a').adv.rounds, 1); assert.strictEqual(svc.player('a').matchList.filter((m) => m.adv).length, 1);
  assert.strictEqual(R6Svc.validatePlayersArg({ sort: 'kost' }).sort, 'kost');
  // levylle tallentunut -> uudelleenkäynnistys ei jäsennä uudelleen
  svc.stop();
  const svc2 = R6Svc.createR6Service({ dataDir: dir, getSettings: () => ({ suspicionSensitivity: 'normal', r6Name: 'x', r6AutoName: true, r6ReplayDir: '' }), setSettings() {}, onChange() {}, lib });
  let parses = 0; const pf = lib.parseMatchFolder; lib.parseMatchFolder = async (...a) => { parses++; return pf(...a); };
  assert.strictEqual(svc2.own({}).advMatches, 1);
  await svc2.start(); assert.strictEqual(parses, 0);
  svc2.stop();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(folderDir, { recursive: true, force: true });
});

test('R6 palvelu: live näyttää edellisen ottelun merkin, uusi ottelukansio kutsuu onMatchStart kerran, r6:player laajennettu', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6prev-'));
  const folderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6prevsrc-'));
  const ms = fixtures().slice(0, 3);
  const handlers = {};
  const lib = {
    ParseCache: class { get() {} set() {} },
    listMatchFolders: async (d) => fs.readdirSync(d).filter((n) => /^Match-/.test(n)).sort().map((n) => path.join(d, n)),
    findReplayDirs: async () => [folderDir],
    parseMatchFolder: async (f) => ({ dir: f, name: path.basename(f), rounds: [], stats: [], errors: [], summary: JSON.parse(fs.readFileSync(path.join(f, 'm.json'), 'utf8')) }),
    createWatcher: () => ({ on(ev, cb) { handlers[ev] = cb; }, async start() {}, stop() {} }),
  };
  for (const m of ms) {
    const f = path.join(folderDir, m.name); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, 'm.json'), JSON.stringify(m));
    const rec = path.join(f, 'a-R01.rec'); fs.writeFileSync(rec, 'x'); const old = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(rec, old, old);
  }
  const started = [];
  const svc = R6Svc.createR6Service({ dataDir: dir, getSettings: () => ({ suspicionSensitivity: 'normal', r6Name: 'x', r6AutoName: true, r6ReplayDir: '' }), setSettings() {}, onChange() {}, onMatchStart: (n) => started.push(n), lib });
  await svc.start();
  // ei-live: Match-3:n edellinen on Match-2 (a oli siinä vastustaja, sillä oma tiimi oli 1)
  const lv = svc.live();
  assert.strictEqual(lv.match.prevMatch.name, 'Match-2');
  assert.strictEqual(lv.match.players.find((p) => p.profileID === 'a').prev, 'against');
  assert.strictEqual(lv.match.players.find((p) => p.isOwn).prev, null);
  assert.strictEqual(svc.match('Match-3').prevMatch, null); // vain live-näkymä laskee merkin
  // uusi ottelu alkaa: ensimmäinen kierros uudessa kansiossa
  const live = { ...ms[2], name: 'Match-5', matchId: 'Match-5', timestamp: wallZ(R6T0 + 4 * R6HR), players: ms[2].players.filter((p) => p.profileID !== 'x') };
  const nf = path.join(folderDir, 'Match-5'); fs.mkdirSync(nf);
  handlers.round({ dir: nf, file: 'a-R01.rec', round: {}, match: { name: 'Match-5', summary: live, rounds: [], errors: [] } });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(started, ['Match-5']);
  handlers.round({ dir: nf, file: 'a-R02.rec', round: {}, match: { name: 'Match-5', summary: live, rounds: [], errors: [] } });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(started, ['Match-5']); // toinen kierros ei ole uusi ottelu
  const lv2 = svc.live();
  assert.strictEqual(lv2.active, true);
  assert.strictEqual(lv2.match.prevMatch.name, 'Match-3'); // live: uusin muu ottelu
  assert.strictEqual(lv2.match.players.find((p) => p.profileID === 'a').prev, 'against'); // M3: a vastustajana
  assert.strictEqual(lv2.match.players.find((p) => p.profileID === 'x'), undefined);
  const pl2 = svc.player('a');
  assert.strictEqual(pl2.matchList[0].name, 'Match-5');
  assert.ok(pl2.operators.length >= 1 && pl2.maps.length >= 1 && pl2.key === 'a');
  svc.stop();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(folderDir, { recursive: true, force: true });
});

// ---- RL: pelaajaindeksi, edellinen ottelu, profiili ----
function rlHist() {
  const { history } = buildHistory(); // M1: Mate kanssa (voitto), Foe vastaan; M2: Mate kanssa (tappio), Foe vastaan; M3: Other kanssa, Mate vastaan
  return history;
}
const RLOWN = { name: 'Akseli', id: '' };
test('RL pelaajaindeksi: kanssa / vastaan, V-H, keskiarvot ja avain PrimaryId (nimi vaihtuu)', () => {
  const idx = rl.buildRlPlayerIndex(rlHist(), RLOWN);
  assert.ok(!idx.has(ME) && !idx.has('n:akseli')); // oma pelaaja pois
  const mate = idx.get('Steam|1|0');
  assert.deepStrictEqual([mate.games, mate.with, mate.against], [3, { games: 2, wins: 1, losses: 1 }, { games: 1, wins: 1, losses: 0 }]);
  assert.deepStrictEqual([mate.goals, mate.score, mate.assists], [2, 500, 0]);
  const foe = idx.get('Steam|2|0');
  assert.deepStrictEqual([foe.games, foe.against.games, foe.against.wins, foe.against.losses, foe.with.games], [2, 2, 1, 1, 0]);
  assert.strictEqual(foe.best.score, 400);
  // sama PrimaryId eri nimellä -> yksi pelaaja, uusin nimi ensin
  const h2 = rlHist().concat([{ guid: 'M4', endedAt: '2099-01-01T00:00:00.000Z', winnerTeamNum: 0, teams: [], players: [{ name: 'Akseli', primaryId: ME, teamNum: 0, score: 1, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0 }, { name: 'FoeUusi', primaryId: 'Steam|2|0', teamNum: 1, score: 5, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0 }] }]);
  const f2 = rl.buildRlPlayerIndex(h2, RLOWN).get('Steam|2|0');
  assert.deepStrictEqual([f2.games, f2.name, f2.names], [3, 'FoeUusi', ['FoeUusi', 'Foe']]);
  // ilman omaa nimeä: pelaajat listataan, W/L ei lasketa
  const none = rl.buildRlPlayerIndex(rlHist(), { name: '', id: '' });
  assert.strictEqual(none.get('Steam|1|0').with.games, 0);
  assert.strictEqual(rl.rlKey({ name: 'Bot', primaryId: 'Unknown|0|0' }), 'n:bot');
  assert.strictEqual(rl.rlKey({ name: '', primaryId: '' }), '');
});
test('RL pelaajalista: haku, lajittelu ja sivutus; IPC-validointi', () => {
  const idx = rl.buildRlPlayerIndex(rlHist(), RLOWN);
  const names = (o) => rl.listRlPlayers(idx, o).players.map((e) => e.name);
  assert.deepStrictEqual(names({ sort: 'games' }).slice(0, 2), ['Mate', 'Foe']);
  assert.strictEqual(names({ sort: 'with' })[0], 'Mate');
  assert.strictEqual(names({ sort: 'against' })[0], 'Foe');
  assert.deepStrictEqual(names({ sort: 'name' }), ['Foe', 'Mate', 'Other']);
  assert.deepStrictEqual(names({ search: 'ot' }), ['Other']);
  const pg = rl.listRlPlayers(idx, { pageSize: 2, page: 2 });
  assert.deepStrictEqual([pg.total, pg.knownTotal, pg.pages, pg.players.length], [3, 3, 2, 1]);
  assert.deepStrictEqual(rl.validateRlPlayersArg({ search: ' Ab\u0001c ', sort: 'with', page: 2 }), { search: 'Abc', sort: 'with', page: 2, pageSize: 50 });
  for (const bad of [5, [], { sort: 'x' }, { search: 'x'.repeat(41) }, { page: 0 }, { pageSize: 101 }, { evil: 1 }]) assert.throws(() => rl.validateRlPlayersArg(bad), /./, JSON.stringify(bad));
  assert.strictEqual(rl.validateRlPlayerKey('Steam|1|0'), 'Steam|1|0');
  for (const bad of ['', 5, null, 'x'.repeat(121), 'a\nb']) assert.throws(() => rl.validateRlPlayerKey(bad), /./, String(bad));
});
test('RL pelaajaprofiili: ottelulista pelaajan näkökulmasta, keskiarvot, paras peli, tuntematon -> null', () => {
  const pr = rl.rlPlayerProfile(rlHist(), RLOWN, 'Steam|1|0');
  assert.deepStrictEqual(pr.matchList.map((m) => m.guid), ['M3', 'M2', 'M1']); // uusin ensin
  assert.deepStrictEqual(pr.matchList.map((m) => m.side), ['against', 'with', 'with']);
  assert.deepStrictEqual(pr.matchList.map((m) => m.result), ['loss', 'loss', 'win']); // Mate: M3 tiimi 0 hävisi (voittaja 1), M2 tiimi 0 hävisi, M1 voitti
  assert.deepStrictEqual(pr.matchList.map((m) => m.yourResult), ['win', 'loss', 'win']);
  assert.deepStrictEqual([pr.averages.goals, pr.averages.score, pr.games, pr.matchTotal], [0.67, 166.67, 3, 3]);
  assert.strictEqual(pr.best.score, 300);
  assert.strictEqual(pr.matchList[0].match.players.length, 3);
  assert.ok(pr.matchList[0].match.players.every((p) => p.key));
  assert.strictEqual(rl.rlPlayerProfile(rlHist(), RLOWN, 'ei-ole'), null);
});
test('RL edellinen ottelu: kuka oli mukana (kanssa/vastaan); käynnissä oleva ottelu ohitetaan; live-snapshot liittää merkin', () => {
  const hist = rlHist();
  const prev = rl.previousRlMatch(hist, RLOWN, null);
  assert.strictEqual(prev.guid, 'M3');
  assert.deepStrictEqual([prev.sides.get('Epic|o|0'), prev.sides.get('Steam|1|0'), prev.result, prev.sides.has(ME)], ['with', 'against', 'win', false]); // M3: oma tiimi 1; Other samassa tiimissä
  assert.strictEqual(rl.previousRlMatch(hist, RLOWN, 'M3').guid, 'M2'); // M3 on jo tallennettu mutta vielä näkyvissä
  assert.strictEqual(rl.previousRlMatch([], RLOWN, null), null);
  assert.strictEqual(rl.previousRlMatch(hist, { name: '', id: '' }, null), null);
  // snapshot
  const { t } = buildHistory();
  t.handle({ Event: 'MatchCreated', Data: { MatchGuid: 'L' } });
  t.handle({ Event: 'UpdateState', Data: stateOf('L', [pl('Akseli', ME, 0, 100, 1, 1, 0, 0), pl('Mate', 'Steam|1|0', 0, 50, 0, 0, 0, 0), pl('Foe', 'Steam|2|0', 1, 20, 0, 0, 0, 0), pl('Uusi', 'Steam|9|0', 1, 0, 0, 0, 0, 0)], [1, 0], { bHasWinner: false }) });
  const sn = t.snapshot().match;
  const by = (n) => sn.players.find((p) => p.name === n);
  // edellinen = M3: oma tiimi 1, Mate tiimissä 0 -> vastaan; Foe ei ollut M3:ssa; Uusi ei ollut
  assert.deepStrictEqual([by('Mate').prev, by('Foe').prev, by('Uusi').prev, by('Akseli').prev], ['against', null, null, null]);
  assert.strictEqual(sn.prevMatch.guid, 'M3'); assert.strictEqual(sn.prevMatch.result, 'win');
  assert.ok(sn.players.every((p) => p.key));
});
test('RL live: pelaajan hist omasta historiasta (pelit, keskiarvot, voitto-%, kanssa/vastaan); oma ja tuntematon -> null; encounter säilyy', () => {
  const { t } = buildHistory();
  const live = (guid) => {
    t.handle({ Event: 'MatchCreated', Data: { MatchGuid: guid } });
    t.handle({ Event: 'UpdateState', Data: stateOf(guid, [pl('Akseli', ME, 0, 100, 1, 1, 0, 0), pl('Mate', 'Steam|1|0', 0, 50, 0, 0, 0, 0), pl('Foe', 'Steam|2|0', 1, 20, 0, 0, 0, 0), pl('Uusi', 'Steam|9|0', 1, 0, 0, 0, 0, 0), pl('Other', 'Epic|o|0', 1, 0, 0, 0, 0, 0)], [1, 0], { bHasWinner: false }) });
    const sn = t.snapshot().match;
    return (n) => sn.players.find((p) => p.name === n);
  };
  const by = live('L');
  // Mate: M1 kanssa (voitto), M2 kanssa (tappio), M3 vastaan; pelaajan oma tiimi voitti vain M1 -> 1/3
  const m = by('Mate').hist;
  assert.deepStrictEqual([m.games, m.with, m.against], [3, { games: 2, wins: 1, losses: 1 }, { games: 1, wins: 1, losses: 0 }]);
  assert.deepStrictEqual([m.avg.score, m.avg.goals, m.avg.assists, m.avg.saves, m.avg.shots, m.avg.demos], [166.67, 0.67, 0, 1, 1.67, 0]);
  assert.strictEqual(m.winrate, 33.33);
  assert.ok(m.lastSeen > 0);
  const f = by('Foe').hist; // M1 vastaan (Foe hävisi), M2 vastaan (Foe voitti)
  assert.deepStrictEqual([f.games, f.against.games, f.with.games, f.winrate, f.avg.goals, f.avg.score], [2, 2, 0, 50, 2, 300]);
  assert.strictEqual(by('Uusi').hist, null);   // ei aiempia pelejä
  assert.strictEqual(by('Akseli').hist, null); // oma pelaaja
  assert.strictEqual(by('Mate').encounter.with.games, 2); // encounter ennallaan
  // välimuisti: sama historia + guid -> sama indeksi; uusi guid -> rakennetaan uudelleen
  const idx1 = t._hidx; t.snapshot(); assert.strictEqual(t._hidx, idx1);
  // nykyinen ottelu on jo historiassa (M3): ei laske itseään aiemmaksi
  const by3 = live('M3');
  const m3 = by3('Mate').hist;
  assert.deepStrictEqual([m3.games, m3.with.games, m3.against.games, m3.winrate], [2, 2, 0, 50]); // M1 voitto, M2 tappio
  assert.strictEqual(by3('Other').hist, null); // Other oli vain M3:ssa
  assert.strictEqual(by3('Foe').hist.games, 2);
  // ilman omaa nimeä: hist löytyy (pelit/keskiarvot), mutta kanssa/vastaan on tyhjä
  const noOwn = new rl.RlTracker({ getOwn: () => null, history: rlHist() });
  noOwn.handle({ Event: 'MatchCreated', Data: { MatchGuid: 'L2' } });
  noOwn.handle({ Event: 'UpdateState', Data: stateOf('L2', [pl('Mate', 'Steam|1|0', 0, 50, 0, 0, 0, 0)], [0, 0], { bHasWinner: false }) });
  const nh = noOwn.snapshot().match.players[0];
  assert.deepStrictEqual([nh.hist.games, nh.hist.with.games, nh.hist.against.games, nh.encounter], [3, 0, 0, null]);
  // profiili käyttää samaa voitto-%:ia
  assert.strictEqual(rl.rlPlayerProfile(rlHist(), RLOWN, 'Steam|1|0').winrate, 33.33);
});

// ---- OW: lobbyistunnot ----
const lobTs = (n) => 1700000000000 + n * 60 * 60 * 1000;
const lobSession = (n, ally, enemy, extra = {}) => Lob.normalizeSession({ ts: lobTs(n), mode: 'competitive', platform: 'pc', ally, enemy, ...extra });
test('OW lobby: istunnon siivous ja validointi', () => {
  const s = lobSession(1, ['Aaa#1111', 'aaa#1111', 'bad name', 'Bbb-2222'], ['Ccc#3333']);
  assert.deepStrictEqual(s.ally, ['Aaa#1111', 'Bbb#2222']); // duplikaatti ja virheellinen pois, "-" -> "#"
  assert.strictEqual(lobSession(1, ['x'], []), null);
  assert.strictEqual(Lob.normalizeSession({ ts: 'ei', ally: ['Aaa#1111'], enemy: [] }), null);
  const v = Lob.validateRecordArg({ mode: 'quickplay', platform: 'console', ally: ['Aaa#1111', 'roska'], enemy: [] });
  assert.deepStrictEqual(v, { mode: 'quickplay', platform: 'console', ally: ['Aaa#1111'], enemy: [] });
  for (const bad of [null, 5, [], { mode: 'x', platform: 'pc', ally: [], enemy: [] }, { mode: 'competitive', platform: 'x', ally: [], enemy: [] },
    { mode: 'competitive', platform: 'pc', ally: 'a', enemy: [] }, { mode: 'competitive', platform: 'pc', ally: [1], enemy: [] },
    { mode: 'competitive', platform: 'pc', ally: Array(6).fill('Aaa#1111'), enemy: [] }, { mode: 'competitive', platform: 'pc', ally: [], enemy: [] },
    { mode: 'competitive', platform: 'pc', ally: ['roska'], enemy: [] }, { mode: 'competitive', platform: 'pc', ally: ['Aaa#1111'], enemy: [], evil: 1 },
    { mode: 'competitive', platform: 'pc', ally: ['x'.repeat(41)], enemy: [] }]) assert.throws(() => Lob.validateRecordArg(bad), /./, JSON.stringify(bad));
  assert.strictEqual(Lob.validateTagArg('Aaa-1111'), 'Aaa#1111');
  for (const bad of ['', 'abc', 5, null, '../x#1234']) assert.throws(() => Lob.validateTagArg(bad), /./, String(bad));
});
test('OW lobby: edellisen lobbyn tunnistus (kanssa / vastaan, oma tagi pois) ja saman lobbyn yhdistäminen', () => {
  let list = [];
  const a = lobSession(1, ['Me#1000', 'Aaa#1111', 'Bbb#2222'], ['Ccc#3333', 'Ddd#4444']);
  let r = Lob.addSession(list, a); list = r.list;
  assert.strictEqual(r.prev, null);
  const b = lobSession(2, ['Me#1000', 'Ccc#3333'], ['Aaa#1111', 'Eee#5555']);
  r = Lob.addSession(list, b); list = r.list;
  assert.strictEqual(r.prev.ts, a.ts); assert.strictEqual(list.length, 2);
  const m = Lob.prevSides(r.prev, 'me#1000');
  assert.deepStrictEqual([m.get('aaa-1111'), m.get('ccc-3333'), m.get('ddd-4444'), m.get('eee-5555'), m.has('me-1000')], ['ally', 'enemy', 'enemy', undefined, false]);
  assert.deepStrictEqual(Lob.withoutOwn(r.prev, 'Me#1000').ally, ['Aaa#1111', 'Bbb#2222']);
  // sama kokoonpano 5 min sisällä = sama lobby (ei uutta istuntoa); sen jälkeen uusi
  const b2 = { ...b, ts: b.ts + 2 * 60 * 1000 };
  r = Lob.addSession(list, b2); list = r.list;
  assert.deepStrictEqual([list.length, r.replaced, r.prev.ts, list[1].ts], [2, true, a.ts, b2.ts]);
  r = Lob.addSession(list, { ...b, ts: b.ts + 10 * 60 * 1000 }); list = r.list;
  assert.deepStrictEqual([list.length, r.replaced, r.prev.ts], [3, false, b2.ts]);
  // kohtaamiset
  const e = Lob.encountersOf(list, 'aaa#1111');
  assert.deepStrictEqual([e.total, e.with, e.against, e.items.map((x) => x.side)], [3, 1, 2, ['enemy', 'enemy', 'ally']]); // uusin ensin
  assert.strictEqual(Lob.encountersOf(list, 'Ei#9999').total, 0);
  assert.strictEqual(Lob.encountersOf(list, 'roska').total, 0);
});
test('OW lobby: tallennus levylle, 500 istunnon raja, uudelleenlataus ja viallinen tiedosto', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-lob-'));
  const file = path.join(d, 'ow-lobbies.json');
  const store = Lob.createLobbyStore(file);
  assert.strictEqual(store.record({ mode: 'competitive', platform: 'pc', ally: ['Aaa#1111'], enemy: ['Bbb#2222'] }, lobTs(0)).prev, null);
  for (let i = 1; i <= 504; i++) store.record({ mode: 'quickplay', platform: 'pc', ally: [`P${i}x#1111`], enemy: ['Bbb#2222'] }, lobTs(i));
  const all = store.all();
  assert.strictEqual(all.length, Lob.CAP);
  assert.strictEqual(all[0].ally[0], 'P5x#1111'); // vanhimmat pudotettu
  assert.strictEqual(all[all.length - 1].ally[0], 'P504x#1111');
  assert.strictEqual(store.encounters('Aaa#1111').total, 0); // pudonnut
  assert.strictEqual(store.encounters('Bbb#2222').total, 500);
  assert.strictEqual(store.encounters('Bbb#2222').items.length, 50); // listaus rajattu
  const again = Lob.createLobbyStore(file);
  assert.strictEqual(again.all().length, 500);
  assert.deepStrictEqual(again.all()[499], all[499]);
  // pienempi raja uudelleenlatauksessa
  assert.strictEqual(Lob.createLobbyStore(file, { cap: 10 }).all().length, 10);
  fs.writeFileSync(file, '{rikki'); assert.strictEqual(Lob.createLobbyStore(file).all().length, 0);
  fs.writeFileSync(file, JSON.stringify([{ ts: 5, ally: ['Aaa#1111'], enemy: [] }, { roska: 1 }, null, 'x']));
  assert.strictEqual(Lob.createLobbyStore(file).all().length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- Pelien tunnistus (game-detect) ----
const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"', '"chrome.exe","1234","Console","1","200 000 K"',
  '"RainbowSix_Vulkan.exe","4321","Console","1","3 000 000 K"', '"Overwatch.exe","5555","Console","1","1 000 K"', '"weird,name.exe","7","Console","1","1 K"', '',
].join('\r\n');
test('game-detect: tasklist-CSV:n jäsennys ja pelien tunnistus', () => {
  const names = GD.parseTasklist(TASKLIST);
  assert.ok(names.has('rainbowsix_vulkan.exe') && names.has('overwatch.exe') && names.has('weird,name.exe') && !names.has('rocketleague.exe'));
  assert.deepStrictEqual(GD.stateFromNames(names), { r6: true, ow: true, rl: false });
  assert.deepStrictEqual(GD.stateFromNames(GD.parseTasklist('"RainbowSix.exe","1","Console","1","1 K"\n"ROCKETLEAGUE.EXE","2","Console","1","1 K"')), { r6: true, ow: false, rl: true });
  assert.deepStrictEqual(GD.stateFromNames(GD.parseTasklist('')), { r6: false, ow: false, rl: false });
  assert.deepStrictEqual(GD.stateFromNames(GD.parseTasklist('INFO: No tasks are running which match the specified criteria.')), { r6: false, ow: false, rl: false });
});
test('game-detect: tilakone (peli käynnissä -> ottelu alkoi -> päättyi; peli sulkeutuu)', () => {
  const t = GD.createGameTracker(() => {});
  assert.strictEqual(t.phase('rl'), 'off');
  assert.strictEqual(t.setRunning('rl', true), true); assert.strictEqual(t.phase('rl'), 'running');
  assert.strictEqual(t.setRunning('rl', true), false); // ei muutosta
  assert.strictEqual(t.matchStarted('rl', 'G1'), true); assert.strictEqual(t.phase('rl'), 'match');
  assert.strictEqual(t.matchStarted('rl', 'G1'), false); // MatchCreated + MatchInitialized = yksi alku
  assert.strictEqual(t.matchEnded('rl'), true); assert.strictEqual(t.phase('rl'), 'running');
  assert.strictEqual(t.matchEnded('rl'), false);
  assert.strictEqual(t.matchStarted('rl', 'G2'), true);
  assert.strictEqual(t.setRunning('rl', false), true); // peli sulkeutuu kesken ottelun -> ottelu päättyy
  assert.deepStrictEqual([t.phase('rl'), t.snapshot().match.rl], ['off', false]);
  // R6: jokainen uusi kansio on uusi ottelu, vaikka edellinen ei ehtinyt päättyä
  assert.strictEqual(t.matchStarted('r6', 'Match-A'), true); assert.strictEqual(t.phase('r6'), 'match'); // ottelun alku kertoo, että peli on käynnissä
  assert.strictEqual(t.matchStarted('r6', 'Match-B'), true);
  assert.deepStrictEqual(Object.keys(t.snapshot()), ['r6', 'ow', 'rl', 'match']);
  assert.strictEqual(t.snapshot().ow, false);
  // muutokset ilmoitetaan
  const seen = [];
  const t2 = GD.createGameTracker((s) => seen.push(`${s.r6}/${s.match.r6}`));
  t2.setRunning('r6', true); t2.matchStarted('r6', 'A'); t2.matchEnded('r6'); t2.setRunning('r6', false);
  assert.deepStrictEqual(seen, ['true/false', 'true/true', 'true/false', 'false/false']);
});
test('game-detect: tunnistin kysyy prosesseja, injektio ohittaa kyselyn, virhe säilyttää edellisen tilan', async () => {
  let out = TASKLIST, calls = 0, fail = false;
  const d = GD.createDetector({ run: async () => { calls++; if (fail) throw new Error('tasklist puuttuu'); return out; }, onState: () => {} });
  await d.poll();
  assert.deepStrictEqual(d.get(), { r6: true, ow: true, rl: false });
  fail = true; await d.poll();
  assert.deepStrictEqual(d.get(), { r6: true, ow: true, rl: false }); assert.match(d.error(), /tasklist/);
  fail = false; out = '"RocketLeague.exe","1","Console","1","1 K"'; await d.poll();
  assert.deepStrictEqual(d.get(), { r6: false, ow: false, rl: true });
  const n = calls;
  d.inject({ r6: true, rl: false }); await d.poll();
  assert.strictEqual(calls, n); // injektion jälkeen oikeaa kyselyä ei tehdä
  assert.deepStrictEqual(d.get(), { r6: true, ow: false, rl: false });
  d.release(); await d.poll(); assert.strictEqual(calls, n + 1);
});
test('Asetukset: autoLive (oletus päällä, vain boolean IPC:ssä)', () => {
  assert.strictEqual(createSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'st-al-'))).get().autoLive, true);
  assert.strictEqual(validate({ autoLive: false }), null);
  assert.ok(validate({ autoLive: 'kyllä' })); assert.ok(validate({ autoLive: 0 }));
  assert.strictEqual(sanitize({ autoLive: 'x' }).autoLive, undefined);
  assert.strictEqual(sanitize({ autoLive: false }).autoLive, false);
});

// ---- Overwolf GEP: normalisointi, rosteri -> lobby, rikastus, tunnukset, uudelleenkäynnistyssuoja -------------------------------------------
const EventEmitter = require('events');
const GEP = require('../src/main/gep');
const OWL = require('../src/main/overwolf');
const SIM = require('./gep-sim');

function gepRig(opts = {}) {
  const g = GEP.createGep(opts);
  const seen = [];
  g.on('matchStart', (e) => seen.push(`start:${e.game}:${e.key}`));
  g.on('matchEnd', (e) => seen.push(`end:${e.game}:${e.key}`));
  const feed = { info: (gm, m) => g.feed(gm, 'info', m), event: (gm, m) => g.feedEvent(gm, m) };
  return { g, seen, feed, play: (seq) => SIM.play(feed, seq) };
}
const GEP_KNOWN = [{ id: 'me-0000', name: 'N-me-0000' }, { id: 'a', name: 'N-a' }, { id: 'x', name: 'N-x' }];

test('GEP: R6 roster normalisoituu (JSON-merkkijonot, tiimi, operaattori, tunnisteet) ja ottelun alku ilmoitetaan kerran', () => {
  const { g, seen, play } = gepRig();
  play(SIM.r6Start(SIM.r6Players(GEP_KNOWN)));
  const s = g.snapshot().r6;
  assert.strictEqual(s.roster.length, 10);
  assert.deepStrictEqual([s.live, s.active, s.phase, s.map, s.mode, s.matchId, s.round], [true, true, 'operator_select', 'KAFE DOSTOYEVSKY', 'RANKED · BOMB', '18F5D014-3FB9-0510-9083-DF555E39AD2B', 1]);
  assert.deepStrictEqual(s.score, { blue: 0, orange: 0 });
  const me = s.roster[0];
  assert.deepStrictEqual([me.name, me.playerId, me.isLocal, me.team, me.operator, me.slot], ['N-me-0000', 'me-0000', true, 'blue', 'Jackal', 'roster_0']);
  assert.strictEqual(s.roster.filter((p) => p.team === 'blue').length, 5); assert.strictEqual(s.roster.filter((p) => p.team === 'orange').length, 5);
  assert.strictEqual(s.roster[9].isAnonymous, true); assert.strictEqual(s.roster[9].suffix, 355);
  assert.strictEqual(typeof me.kills, 'number');
  play([SIM.event(SIM.R6_ID, 'match_info', 'match_start', '')]); // kaksoistapahtuma ei ole uusi alku
  assert.deepStrictEqual(seen, ['start:r6:r6-1']);
});
test('GEP: R6 osapäivitykset (health -20, kills, score-muoto), paikan tyhjennys null:lla ja vanha info-muoto', () => {
  const { g, play, feed } = gepRig();
  play(SIM.r6Start(SIM.r6Players(GEP_KNOWN)));
  assert.strictEqual(g.snapshot().r6.roster[0].health, 100); // 120 - 20 (GEP lisää kaatotilan 20 pistettä)
  play(SIM.r6Progress(SIM.r6Players(GEP_KNOWN)));
  const s = g.snapshot().r6;
  assert.deepStrictEqual(s.score, { blue: 1, orange: 0 }); assert.strictEqual(s.round, 2);
  assert.deepStrictEqual([s.roster[0].kills, s.roster[0].deaths, s.roster[0].health, s.roster[0].operator], [6, 2, 50, 'Jackal']); // roster-päivitys säilytti operaattorin
  assert.strictEqual(s.killFeed.length, 1); assert.strictEqual(s.killFeed[0].headshot, true);
  // pelaajakohtainen osapäivitys tunnisteella
  feed.info(SIM.R6_ID, { feature: 'roster', category: 'player', key: 'deaths', value: '{"player_id":"a","deaths":7}' });
  assert.strictEqual(g.snapshot().r6.roster.find((p) => p.playerId === 'a').deaths, 7);
  // pelaaja poistuu: roster_XX = null (uusi ow-electron-muoto ja vanha { info: { players: { roster_3: null } } })
  feed.info(SIM.R6_ID, { feature: 'roster', category: 'players', key: 'roster_3', value: null });
  assert.strictEqual(g.snapshot().r6.roster.length, 9);
  feed.info(SIM.R6_ID, { feature: 'roster', info: { players: { roster_4: null } } });
  assert.strictEqual(g.snapshot().r6.roster.length, 8);
  // vanha muoto asettaa myös arvon
  feed.info(SIM.R6_ID, { feature: 'match', info: { match: { score: '{"blue":"3","orange":"2"}' } } });
  assert.deepStrictEqual(g.snapshot().r6.score, { blue: 3, orange: 2 });
});
test('GEP: R6 ottelun loppu, uusi rosteri aloittaa tuoreen ottelun (vanhat paikat pois, uusi avain) ja lobby-vaihe nollaa', () => {
  const { g, seen, play, feed } = gepRig();
  play(SIM.r6Start(SIM.r6Players(GEP_KNOWN)));
  play(SIM.r6End());
  let s = g.snapshot().r6;
  assert.deepStrictEqual([s.live, s.active, s.ended, s.outcome], [false, false, true, 'victory']);
  feed.info(SIM.R6_ID, { feature: 'roster', category: 'players', key: 'roster_0', value: SIM.r6PlayerJson({ id: 'z', name: 'Uusi', local: true, team: 'Blue' }, 0) });
  s = g.snapshot().r6;
  assert.deepStrictEqual([s.live, s.roster.length, s.key, s.score.blue], [true, 1, 'r6-2', null]);
  play([SIM.event(SIM.R6_ID, 'match_info', 'match_start', '')]);
  feed.info(SIM.R6_ID, { feature: 'game_info', category: 'game_info', key: 'phase', value: 'lobby' }); // lobbyyn palaaminen päättää ja nollaa
  s = g.snapshot().r6;
  assert.deepStrictEqual([s.live, s.active, s.roster.length], [false, false, 0]);
  assert.deepStrictEqual(seen, ['start:r6:r6-1', 'end:r6:r6-1', 'start:r6:r6-2', 'end:r6:r6-2']);
});
test('GEP: roskaviestit, tuntemattomat avaimet ja väärät tyypit eivät heitä poikkeusta eikä muuta tilaa', () => {
  const { g, feed } = gepRig();
  const before = JSON.stringify(g.snapshot());
  for (const m of [null, undefined, 5, 'x', [], {}, { key: 5 }, { key: 'roster_1', value: '{rikki' }, { key: 'roster_1', value: 42 }, { key: 'roster_x', value: '{}' }, { feature: 'foo', category: 'bar', key: 'baz', value: { a: 1 } }, { info: 'x' }, { info: { a: 5 } }]) {
    feed.info(SIM.R6_ID, m); feed.info(SIM.OW_ID, m); feed.event(SIM.R6_ID, m); feed.event(SIM.OW_ID, m);
  }
  assert.strictEqual(g.feed(12345, 'info', { key: 'x', value: 1 }), false); // tuntematon peli
  assert.strictEqual(g.feed('r6', 'info', { key: 'health', value: 'abc' }), true);
  assert.strictEqual(JSON.stringify(g.snapshot()).replace(/"updatedAt":\d+/g, ''), before.replace(/"updatedAt":\d+/g, ''));
  assert.deepStrictEqual(GEP.parseValue('{"a":1}'), { a: 1 }); assert.strictEqual(GEP.parseValue('null'), null); assert.strictEqual(GEP.parseValue('{rikki'), '{rikki'); assert.strictEqual(GEP.parseValue(' 12 '), ' 12 ');
  assert.strictEqual(GEP.toNum('12'), 12); assert.strictEqual(GEP.toNum(''), null); assert.strictEqual(GEP.toNum(true), null); assert.strictEqual(GEP.toNum('abc'), null);
});
test('GEP: OW2 roster (hero, rooli, tagit, K/D/A, vahinko) ja pelitiedot normalisoituvat', () => {
  const { g, seen, play } = gepRig();
  play(SIM.owStart());
  const s = g.snapshot().ow;
  assert.deepStrictEqual([s.live, s.active, s.map, s.mode, s.gameType, s.ownTag, s.matchId, s.roster.length], [true, true, 'New Junk City', 'Assault', 'UNRANKED', 'SmokeOwn#9999', '602871308', 8]);
  const me = s.roster[0];
  assert.deepStrictEqual([me.name, me.battletag, me.isLocal, me.hero, me.role, me.team, me.healed], ['SMOKEOWN', 'SmokeOwn#9999', true, 'Ana', 'support', 0, 9000.25]);
  assert.strictEqual(s.roster[4].hero, 'Soldier: 76'); assert.strictEqual(s.roster[3].hero, 'Lúcio');
  assert.strictEqual(s.roster[7].battletag, ''); assert.strictEqual(s.roster[7].isTeammate, false);
  play(SIM.owProgress());
  assert.deepStrictEqual([g.snapshot().ow.roster[0].kills, g.snapshot().ow.roster[0].damage, g.snapshot().ow.killFeed[0].attackerHero], [15, 3100, 'Genji']);
  play(SIM.owEnd());
  assert.deepStrictEqual([g.snapshot().ow.live, g.snapshot().ow.outcome], [false, 'victory']);
  assert.deepStrictEqual(seen, ['start:ow:ow-1', 'end:ow:ow-1']);
});
test('GEP: roster -> lobby: tiimikaverit Oma tiimi, muut Viholliset, oma pois, tagittomat lasketaan, pienet kirjaimet ja tiimipohjainen varajako', () => {
  const { g, play } = gepRig();
  play(SIM.owStart());
  const lb = g.snapshot().ow.lobby;
  assert.deepStrictEqual(lb.ally, ['Synth#1111', 'Synth#2222', 'Synth#3333', 'TeKrop#2217']);
  assert.deepStrictEqual(lb.enemy, ['Priv#4444', 'Zzqxkv#99999']);
  assert.deepStrictEqual([lb.own, lb.skipped, lb.players], ['SmokeOwn#9999', 1, 8]);
  // GEP antaa tagit pienillä kirjaimilla; is_teammate puuttuu -> jako tiimin numerosta
  const P = (battletag, team, isLocal) => ({ battletag, team, isLocal: !!isLocal, isTeammate: null, slot: 'roster_0' });
  const lb2 = GEP.owLobbyFromRoster([P('charlogne#2351', 0, true), P('foo#1234', 0), P('bar#5678', 1), P('bar#5678', 1)], '');
  assert.deepStrictEqual([lb2.ally, lb2.enemy, lb2.own], [['foo#1234'], ['bar#5678'], 'charlogne#2351']);
  // oma tunnistetaan myös battle_tag-tiedosta, vaikka is_local puuttuisi
  const lb3 = GEP.owLobbyFromRoster([P('Me#1111', 0), P('Foo#2222', 0)], 'me#1111');
  assert.deepStrictEqual([lb3.ally, lb3.own], [['Foo#2222'], 'Me#1111']);
  assert.deepStrictEqual(GEP.owLobbyFromRoster(null, ''), { ally: [], enemy: [], own: '', skipped: 0, players: 0 });
});
test('GEP: getInfo-tilannekuva (ohjelma avattu kesken ottelun) täyttää tilan eri muodoilla', () => {
  const a = gepRig(), b = gepRig();
  a.g.seedFromInfo('r6', { roster: { players: { roster_0: SIM.r6PlayerJson({ id: 'q', name: 'Q', local: true, team: 'Blue' }, 0) } }, match_info: { match_info: { map_id: 'BANK' } } });
  assert.deepStrictEqual([a.g.snapshot().r6.roster.length, a.g.snapshot().r6.map], [1, 'BANK']);
  b.g.seedFromInfo('r6', { res: { players: { roster_0: SIM.r6PlayerJson({ id: 'q', name: 'Q', local: true, team: 'Blue' }, 0) } } });
  assert.strictEqual(b.g.snapshot().r6.roster.length, 1);
  assert.doesNotThrow(() => b.g.seedFromInfo('ow', 'roska'));
});
test('GEP: kääre on no-op ilman app.overwolf-rajapintaa (tavallinen Electron / savutesti)', () => {
  const g = GEP.createGep({ app: {}, env: {} });
  assert.strictEqual(g.attach(), false);
  assert.strictEqual(g.status().state, 'inactive'); assert.match(g.status().reason, /ow-electron/);
  assert.strictEqual(GEP.createGep({}).attach(), false);
  assert.deepStrictEqual(Object.keys(g.snapshot()), ['status', 'r6', 'ow']);
  assert.strictEqual(g.isLive('r6'), false); assert.strictEqual(g.isActive('ow'), false);
});
test('GEP: kääre ow-electronilla: tunnusten odotus, paketti valmis, pelin tunnistus (vain R6/OW), tapahtumat, poistuminen, virheet', async () => {
  const calls = [];
  const gepApi = new EventEmitter();
  gepApi.setRequiredFeatures = async (id, f) => { calls.push(['features', id, f]); };
  gepApi.getInfo = async (id) => { calls.push(['getInfo', id]); return { roster: { players: { roster_0: SIM.r6PlayerJson({ id: 'q', name: 'Q', local: true, team: 'Blue' }, 0) } } }; };
  const packages = new EventEmitter();
  packages.gep = gepApi;
  const app = { overwolf: { packages, disableAnonymousAnalytics: () => calls.push(['analytics-off']) } };
  const timers = [];
  const g = GEP.createGep({ app, env: {}, setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout() {} });
  assert.strictEqual(g.attach(), true);
  assert.deepStrictEqual(calls, [['analytics-off']]);
  assert.strictEqual(g.status().state, 'waiting-credentials'); assert.match(g.status().reason, /tunnuksia/i);
  packages.emit('ready', {}, 'overlay', '1.0.0'); // muu paketti: ei vaikutusta
  assert.strictEqual(g.status().state, 'waiting-credentials');
  packages.emit('ready', {}, 'gep', '9.9.9');
  assert.deepStrictEqual([g.status().state, g.status().version], ['ready', '9.9.9']);
  // tuntematon peli: ei enable()-kutsua
  let enabled = 0;
  gepApi.emit('game-detected', { enable: () => { enabled++; } }, 21566, 'Apex Legends');
  assert.strictEqual(enabled, 0);
  gepApi.emit('game-detected', { enable: () => { enabled++; } }, SIM.R6_ID, 'Rainbow Six Siege');
  assert.strictEqual(enabled, 1); assert.strictEqual(g.status().state, 'game-running');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'analytics-off'), [['features', SIM.R6_ID, null], ['getInfo', SIM.R6_ID]]);
  assert.strictEqual(g.snapshot().r6.roster.length, 1); // getInfo-tilannekuva
  gepApi.emit('new-info-update', {}, SIM.R6_ID, { gameId: SIM.R6_ID, feature: 'match', category: 'match', key: 'score', value: '{"blue":"2","orange":"1"}' });
  gepApi.emit('new-game-event', {}, SIM.R6_ID, { gameId: SIM.R6_ID, feature: 'match_info', key: 'match_start', value: '' });
  assert.deepStrictEqual([g.snapshot().r6.score, g.snapshot().r6.active], [{ blue: 2, orange: 1 }, true]);
  assert.doesNotThrow(() => gepApi.emit('error', {}, SIM.R6_ID, 'jotain meni pieleen'));
  assert.match(g.status().lastError, /jotain meni pieleen/);
  gepApi.emit('elevated-privileges-required', {}, SIM.R6_ID, 'Rainbow Six Siege', 1234);
  assert.match(g.status().reason, /järjestelmänvalvoja/);
  gepApi.emit('game-exit', {}, SIM.R6_ID, 'Rainbow Six Siege', 1234);
  assert.deepStrictEqual([g.snapshot().r6.live, g.snapshot().r6.running, g.snapshot().r6.roster.length], [false, false, 0]);
  assert.strictEqual(timers.length, 0); // ilman tunnusta ei odotusajastinta
});
test('GEP: kääre: tunnus asetettu mutta paketti ei käynnisty -> virhe ajastimella; failed-to-initialize -> virhe', () => {
  const packages = new EventEmitter();
  const fire = [];
  const g = GEP.createGep({ app: { overwolf: { packages } }, env: { OW_DEV_KEY: 'x'.repeat(12) }, setTimeout: (fn) => { fire.push(fn); return { unref() {} }; }, clearTimeout() {} });
  g.attach();
  assert.match(g.status().reason, /Odotetaan Overwolfin GEP-pakettia/);
  assert.strictEqual(fire.length, 1); fire[0]();
  assert.strictEqual(g.status().state, 'error'); assert.match(g.status().lastError, /90 sekunnissa/);
  const p2 = new EventEmitter();
  const g2 = GEP.createGep({ app: { overwolf: { packages: p2 } }, env: {} });
  g2.attach(); p2.emit('failed-to-initialize', {}, 'gep');
  assert.strictEqual(g2.status().state, 'error');
  p2.gep = new EventEmitter(); p2.emit('ready', {}, 'gep', '1.0'); // virheen jälkeen valmis -> toipuu
  assert.strictEqual(g2.status().state, 'ready');
});

test('GEP: R6 rikastus player_id:llä: historia (kanssa/vastaan), Edellinen-merkki, tuntematon pelaaja ja oma tunnistus', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gepenr-'));
  const folderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gepenrsrc-'));
  const ms = fixtures();
  const lib = {
    ParseCache: class { get() {} set() {} },
    listMatchFolders: async (d) => fs.readdirSync(d).filter((n) => /^Match-/.test(n)).sort().map((n) => path.join(d, n)),
    findReplayDirs: async () => [folderDir],
    parseMatchFolder: async (f) => ({ dir: f, name: path.basename(f), rounds: [], stats: [], errors: [], summary: JSON.parse(fs.readFileSync(path.join(f, 'm.json'), 'utf8')) }),
    createWatcher: () => ({ on() {}, async start() {}, stop() {} }),
  };
  for (const m of ms.slice(0, 3)) { const f = path.join(folderDir, m.name); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, 'm.json'), JSON.stringify(m)); fs.writeFileSync(path.join(f, 'a-R01.rec'), 'x'); }
  let st = { suspicionSensitivity: 'normal', r6Name: '', r6AutoName: true, r6ReplayDir: '' };
  const svc = R6Svc.createR6Service({ dataDir: dir, getSettings: () => st, setSettings: (p) => { st = { ...st, ...p }; }, onChange() {}, lib });
  await svc.start();
  const rig = gepRig();
  rig.play(SIM.r6Start(SIM.r6Players([{ id: R6ME, name: 'N-me-0000' }, { id: 'a', name: 'N-a' }, { id: 'x', name: 'N-x' }])));
  const e = svc.enrichLive(rig.g.snapshot().r6.roster);
  const byId = (id) => e.players.find((p) => p.playerId === id);
  assert.strictEqual(e.players.length, 10);
  assert.strictEqual(byId(R6ME).isOwn, true); assert.strictEqual(byId(R6ME).hist, null); assert.strictEqual(byId(R6ME).prev, null);
  const a = byId('a');
  assert.deepStrictEqual([a.known, a.key, a.hist.matches], [true, 'a', 3]); // koko historia, koska GEP-ottelua ei vielä ole tallenteissa
  assert.ok(['with', 'against'].includes(a.prev)); // Match-3 oli edellinen ottelu
  assert.strictEqual(byId('x').prev, 'against'); // M3: x oli vastustaja
  const fresh = e.players.find((p) => p.name === 'GepUusi3');
  assert.deepStrictEqual([fresh.known, fresh.hist, fresh.prev, fresh.replay], [false, null, null, null]);
  assert.strictEqual(e.prevMatch.name, 'Match-3');
  // nimi-avain (ei player_id): yhdistyy nimellä
  const byName = svc.enrichLive([{ slot: 'roster_1', name: 'N-a', playerId: '', isLocal: false, team: 'orange' }]);
  assert.strictEqual(byName.players[0].key, 'u:n-a');
  assert.deepStrictEqual(svc.enrichLive(null).players, []);
  // Käynnissä oleva tallenne kuuluu GEP-otteluun, kun tiedostoja on kirjoitettu GEP-alun jälkeen: historia ilman sitä + replay-luvut (HS) mukaan
  const cur = svc.enrichLive(rig.g.snapshot().r6.roster, { since: Date.now() - 600000 });
  assert.strictEqual(cur.activeName, 'Match-3');
  const ca = cur.players.find((p) => p.playerId === 'a'), cx = cur.players.find((p) => p.playerId === 'x');
  assert.strictEqual(ca.hist.matches, 2);
  assert.deepStrictEqual([cx.replay.kills, cx.replay.headshots, cx.replay.hsPercent, cx.replay.rounds], [2, 1, 50, 2]);
  assert.strictEqual(cur.players.find((p) => p.playerId === R6ME).replay.kills, 8);
  assert.strictEqual(e.players.find((p) => p.playerId === 'x').replay, null); // vanha tallenne ei sekoitu uuteen otteluun
  svc.stop();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(folderDir, { recursive: true, force: true });
});

test('Overwolf-tunnukset: validointi (jompikumpi tapa, tiukat kentät) ja ympäristömuuttujat', () => {
  assert.deepStrictEqual(OWL.validateCredsArg({ mode: 'dev', devKey: ' abcdefgh12345678 ', devChannel: true }), { mode: 'dev', devKey: 'abcdefgh12345678' });
  assert.deepStrictEqual(OWL.validateCredsArg({ mode: 'console', email: 'a@b.fi', apiKey: 'k'.repeat(20) }), { mode: 'console', email: 'a@b.fi', apiKey: 'k'.repeat(20) });
  for (const bad of [null, [], 5, {}, { mode: 'x' }, { mode: 'dev' }, { mode: 'dev', devKey: 'lyhyt' }, { mode: 'dev', devKey: 'on välilyöntejä sisällä' }, { mode: 'dev', devKey: 'abcdefgh12345678', email: 'a@b.fi' },
    { mode: 'dev', devKey: 'abcdefgh12345678', evil: 1 }, { mode: 'dev', devKey: 'abcdefgh12345678', devChannel: 'yes' }, { mode: 'console', email: 'ei-sähköposti', apiKey: 'k'.repeat(20) },
    { mode: 'console', email: 'a@b.fi', apiKey: 'lyhyt' }, { mode: 'console', email: 'a@b.fi', apiKey: 'k'.repeat(20), devKey: 'abcdefgh12345678' }, { mode: 'dev', devKey: 'x'.repeat(2049) }]) {
    assert.throws(() => OWL.validateCredsArg(bad), /./, JSON.stringify(bad));
  }
  assert.deepStrictEqual(OWL.envFromCreds({ mode: 'dev', devKey: 'K' }), { OW_DEV_KEY: 'K' });
  assert.deepStrictEqual(OWL.envFromCreds({ mode: 'console', email: 'e', apiKey: 'k' }), { OW_CLI_EMAIL: 'e', OW_CLI_API_KEY: 'k' });
  assert.deepStrictEqual(OWL.envFromCreds(null), {});
  assert.strictEqual(OWL.hasEnvCreds({ OW_DEV_KEY: 'x' }), true); assert.strictEqual(OWL.hasEnvCreds({ OW_CLI_EMAIL: 'x' }), false); assert.strictEqual(OWL.hasEnvCreds({}), false);
  const env = { OW_CLI_EMAIL: 'old', OW_CLI_API_KEY: 'old', KEEP: '1' };
  OWL.applyEnv(env, OWL.planEnable({ argv: ['x', '.'], creds: { mode: 'dev', devKey: 'NEW' }, devChannel: false }));
  assert.deepStrictEqual(env, { OW_DEV_KEY: 'NEW', KEEP: '1' }); // vanhat Console-muuttujat pois (ne ohittaisivat OW_DEV_KEY:n)
});
test('Overwolf-tunnukset: salattu varasto (feikki safeStorage): tallennus, lataus, tyhjennys; ei selkotekstiä levyllä; kieltäytyy ilman salausta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-owcred-'));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'), decryptString: (b) => Buffer.from(b.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8') };
  const store = OWL.createCredStore({ dir, safeStorage: fake });
  assert.deepStrictEqual([store.available(), store.has(), store.load()], [true, false, null]);
  const secret = 'SALAINEN-AVAIN-1234567890';
  assert.strictEqual(store.save({ mode: 'dev', devKey: secret }), true);
  assert.strictEqual(path.basename(store.file), 'ow-credentials.bin');
  const raw = fs.readFileSync(store.file);
  assert.ok(!raw.toString('utf8').includes(secret) && !raw.toString('latin1').includes(secret));
  assert.deepStrictEqual(store.load(), { mode: 'dev', devKey: secret });
  assert.strictEqual(OWL.createCredStore({ dir, safeStorage: fake }).has(), true); // säilyy levyllä
  assert.throws(() => store.save({ mode: 'dev', devKey: 'lyhyt' }), /Virheelliset/);
  fs.writeFileSync(store.file, 'roskaa'); assert.strictEqual(store.load(), null); // rikkinäinen tiedosto ei kaada
  assert.strictEqual(store.clear(), true); assert.strictEqual(store.has(), false); assert.strictEqual(store.clear(), true);
  // ei salausta: ei tallenneta selkotekstinä
  for (const ss of [null, { isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => { throw new Error('x'); } }]) {
    const s2 = OWL.createCredStore({ dir, safeStorage: ss });
    assert.strictEqual(s2.available(), false);
    assert.throws(() => s2.save({ mode: 'dev', devKey: secret }), /Salausta ei ole saatavilla/);
    assert.strictEqual(s2.has(), false); assert.strictEqual(s2.load(), null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
test('Overwolf: käynnistyssuunnitelma ja uudelleenkäynnistyksen silmukkasuoja', () => {
  const creds = { mode: 'dev', devKey: 'abcdefgh12345678' };
  const argv = ['C:\\ow\\electron.exe', '.'];
  const base = { env: {}, argv, creds, devChannel: true, relaunched: false, smoke: false };
  // tunnus tallennettu mutta ei prosessissa -> uudelleenkäynnistys: env + dev-kanava-argumentti
  const p1 = OWL.planStartup(base);
  assert.deepStrictEqual([p1.action, p1.reason, p1.setEnv, p1.args], ['relaunch', 'env', { OW_DEV_KEY: 'abcdefgh12345678' }, ['.', OWL.CHANNEL_ARG]]);
  // uudelleenkäynnistetty prosessi: tunnus ja kanava mukana -> ei enää mitään
  const p2 = OWL.planStartup({ ...base, env: { OW_DEV_KEY: 'abcdefgh12345678' }, argv: [...argv, OWL.CHANNEL_ARG], relaunched: true });
  assert.deepStrictEqual([p2.action, p2.reason], ['none', 'ready']);
  // silmukkasuoja: edellinen prosessi uudelleenkäynnisti, mutta tunnus ei silti näy -> ei uutta yritystä
  const p3 = OWL.planStartup({ ...base, relaunched: true });
  assert.deepStrictEqual([p3.action, p3.reason], ['none', 'relaunch-guard']);
  // käyttäjän oma ympäristömuuttuja riittää; vain kanava puuttuu -> uudelleenkäynnistys ilman env-muutoksia
  const p4 = OWL.planStartup({ ...base, env: { OW_DEV_KEY: 'omaavain123' } });
  assert.deepStrictEqual([p4.action, p4.reason, p4.setEnv, p4.args], ['relaunch', 'channel', {}, ['.', OWL.CHANNEL_ARG]]);
  // kanava pois: vanha argumentti poistetaan
  const p5 = OWL.planStartup({ ...base, devChannel: false, env: { OW_DEV_KEY: 'k12345678' }, argv: [...argv, OWL.CHANNEL_ARG] });
  assert.deepStrictEqual([p5.action, p5.args], ['relaunch', ['.']]);
  assert.strictEqual(OWL.planStartup({ ...base, devChannel: false, env: { OW_DEV_KEY: 'k12345678' } }).action, 'none');
  // ei tunnusta / savutesti / tavallinen Electron -> ei koskaan uudelleenkäynnistystä
  assert.strictEqual(OWL.planStartup({ ...base, creds: null }).reason, 'no-creds');
  assert.strictEqual(OWL.planStartup({ ...base, smoke: true }).reason, 'smoke');
  assert.strictEqual(OWL.planStartup({ ...base, hasOverwolf: false }).reason, 'no-ow-electron');
  // Ota käyttöön -nappi: aina uudelleenkäynnistys, silmukkasuoja ei estä; muut argumentit säilyvät, vanha gep-kanava korvataan
  const en = OWL.planEnable({ argv: [...argv, '--foo', '--owepm-package-channel=gep:qa'], creds, devChannel: true });
  assert.deepStrictEqual([en.action, en.args, en.clearEnv], ['relaunch', ['.', '--foo', OWL.CHANNEL_ARG], ['OW_CLI_EMAIL', 'OW_CLI_API_KEY']]);
  assert.strictEqual(OWL.RELAUNCH_FLAG, 'STATSIKKA_OW_RELAUNCHED');
});
test('Asetukset: gepDevChannel (oletus päällä, vain boolean IPC:ssä)', () => {
  assert.strictEqual(createSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'st-gep-'))).get().gepDevChannel, true);
  assert.strictEqual(validate({ gepDevChannel: false }), null);
  assert.ok(validate({ gepDevChannel: 'kyllä' })); assert.ok(validate({ gepDevChannel: 0 }));
  assert.strictEqual(sanitize({ gepDevChannel: 'x' }).gepDevChannel, undefined);
  assert.strictEqual(sanitize({ gepDevChannel: false }).gepDevChannel, false);
});

// ---- Taustatila (tray), pelin käynnistyksen automaattinen avaus ja käynnistys Windowsin mukana ----------------------------------------------
const BG = require('../src/main/background');
test('Asetukset: runInBackground / openOnGameLaunch (oletus päällä) ja startWithWindows (oletus pois), vain boolean IPC:ssä', () => {
  const d = createSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'st-bg-'))).get();
  assert.strictEqual(d.runInBackground, true);
  assert.strictEqual(d.openOnGameLaunch, true);
  assert.strictEqual(d.startWithWindows, false);
  for (const k of ['runInBackground', 'openOnGameLaunch', 'startWithWindows']) {
    assert.strictEqual(validate({ [k]: true }), null); assert.strictEqual(validate({ [k]: false }), null);
    for (const bad of ['kyllä', 0, 1, null, 'true', {}, []]) assert.ok(validate({ [k]: bad }), `${k}=${JSON.stringify(bad)}`);
    assert.strictEqual(sanitize({ [k]: 'x' })[k], undefined);
    assert.strictEqual(sanitize({ [k]: false })[k], false);
    assert.strictEqual(sanitize({ [k]: true })[k], true);
  }
  assert.deepStrictEqual(sanitize({ runInBackground: 1, openOnGameLaunch: 'x', startWithWindows: null }), {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bg2-'));
  try {
    const s = createSettings(tmp);
    s.set({ runInBackground: false, startWithWindows: true });
    const again = createSettings(tmp).get();
    assert.strictEqual(again.runInBackground, false); assert.strictEqual(again.startWithWindows, true); assert.strictEqual(again.openOnGameLaunch, true); // pysyy levyllä
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Käynnistysreuna: prosessi ilmestyy -> yksi tapahtuma; pysyy käynnissä -> ei uusia; sulkeutuu ja ilmestyy uudelleen -> uusi tapahtuma', () => {
  const ev = [];
  const w = BG.createLaunchWatcher((g) => ev.push(g));
  const st = (o) => ({ r6: false, ow: false, rl: false, ...o });
  w.update(st({}));                       // lähtötilanne
  assert.deepStrictEqual(ev, []);
  w.update(st({ rl: true }));
  assert.deepStrictEqual(ev, ['rl']);
  for (let i = 0; i < 5; i++) w.update(st({ rl: true })); // 5 s välein: ei toistoa
  assert.deepStrictEqual(ev, ['rl']);
  w.update(st({ rl: true, r6: true }));   // toinen peli lisäksi
  assert.deepStrictEqual(ev, ['rl', 'r6']);
  w.update(st({ r6: true }));              // rl sulkeutuu: ei tapahtumaa
  assert.deepStrictEqual(ev, ['rl', 'r6']);
  w.update(st({ r6: true, rl: true }));    // rl uudelleen: uusi tapahtuma
  assert.deepStrictEqual(ev, ['rl', 'r6', 'rl']);
  w.update(st({ ow: true, r6: false, rl: false })); // useita muutoksia kerralla
  assert.deepStrictEqual(ev, ['rl', 'r6', 'rl', 'ow']);
  // Statsikan käynnistyessä jo käynnissä oleva peli on lähtötilanne (ei avausta)
  const ev2 = [];
  const w2 = BG.createLaunchWatcher((g) => ev2.push(g));
  w2.update(st({ ow: true })); w2.update(st({ ow: true }));
  assert.deepStrictEqual(ev2, []);
  w2.update(st({})); w2.update(st({ ow: true }));
  assert.deepStrictEqual(ev2, ['ow']);
  w2.update(null); w2.update(undefined); // viallinen syöte ei kaada (tulkitaan: ei pelejä)
});

test('Käynnistysreuna: oikea tunnistin (tasklist-syöte) -> tapahtumat vain reunoilla, kyselyvirhe ei luo tapahtumaa', async () => {
  const ev = [];
  const w = BG.createLaunchWatcher((g) => ev.push(g));
  let out = '"System","4","Services","0","100 K"\n';
  let fail = false;
  const det = GD.createDetector({ run: async () => { if (fail) throw new Error('tasklist kaatui'); return out; }, onState: (s) => w.update(s) });
  await det.poll();                                  // lähtötilanne
  out += '"RocketLeague.exe","123","Console","1","900 K"\n';
  await det.poll(); await det.poll(); await det.poll();
  assert.deepStrictEqual(ev, ['rl']);
  fail = true; await det.poll();                      // virhe: edellinen tila säilyy
  fail = false; await det.poll();
  assert.deepStrictEqual(ev, ['rl']);
  out = '"System","4","Services","0","100 K"\n'; await det.poll();
  out += '"RainbowSix_Vulkan.exe","9","Console","1","1 K"\n"RocketLeague.exe","124","Console","1","900 K"\n'; await det.poll();
  assert.deepStrictEqual(ev.slice().sort(), ['r6', 'rl', 'rl']);
  det.inject({ ow: true });                           // savutestin koukku kulkee samaa reittiä
  assert.strictEqual(ev.filter((g) => g === 'ow').length, 1);
});

test('Pelin käynnistyksen päätös: piilossa/pienennetty -> showInactive + siirtymä; näkyvissä -> vain siirtymä; asetus pois / ei ikkunaa -> ei mitään', () => {
  const d = BG.decideLaunch;
  assert.deepStrictEqual(d({ enabled: true, hasWindow: true, visible: false, minimized: false }), { action: 'show', wasHidden: true });
  assert.deepStrictEqual(d({ enabled: true, hasWindow: true, visible: true, minimized: true }), { action: 'show', wasHidden: true }); // pienennetty
  assert.deepStrictEqual(d({ enabled: true, hasWindow: true, visible: true, minimized: false }), { action: 'navigate', wasHidden: false });
  assert.deepStrictEqual(d({ enabled: false, hasWindow: true, visible: false, minimized: false }), { action: 'none', wasHidden: false });
  assert.deepStrictEqual(d({ enabled: false, hasWindow: true, visible: true, minimized: false }), { action: 'none', wasHidden: false });
  assert.deepStrictEqual(d({ enabled: true, hasWindow: false, visible: false, minimized: false }), { action: 'none', wasHidden: false });
});

test('Taustatila: --hidden-käynnistys, ikkunan sulkeminen, toinen käynnistys ja Ctrl+Q', () => {
  assert.strictEqual(BG.isHiddenStart(['.', '--hidden']), true);
  assert.strictEqual(BG.isHiddenStart(['.', '--smoke-test']), false);
  assert.strictEqual(BG.isHiddenStart(undefined), false);
  // --hidden vaikuttaa vain, kun tray on olemassa ja runInBackground on päällä
  assert.strictEqual(BG.shouldStartHidden({ argv: ['.', '--hidden'], runInBackground: true, trayOk: true }), true);
  assert.strictEqual(BG.shouldStartHidden({ argv: ['.', '--hidden'], runInBackground: false, trayOk: true }), false);
  assert.strictEqual(BG.shouldStartHidden({ argv: ['.', '--hidden'], runInBackground: true, trayOk: false }), false);
  assert.strictEqual(BG.shouldStartHidden({ argv: ['.'], runInBackground: true, trayOk: true }), false);
  // sulkeminen piilottaa vain kun ei olla lopettamassa
  assert.strictEqual(BG.shouldHideOnClose({ quitting: false, runInBackground: true, trayOk: true }), true);
  assert.strictEqual(BG.shouldHideOnClose({ quitting: true, runInBackground: true, trayOk: true }), false);
  assert.strictEqual(BG.shouldHideOnClose({ quitting: false, runInBackground: false, trayOk: true }), false);
  assert.strictEqual(BG.shouldHideOnClose({ quitting: false, runInBackground: true, trayOk: false }), false);
  // toinen käynnistys tuo ikkunan esiin, Windowsin automaattikäynnistys (--hidden) ei
  assert.strictEqual(BG.shouldRevealOnSecondInstance(['x.exe', '.']), true);
  assert.strictEqual(BG.shouldRevealOnSecondInstance(['x.exe', '.', '--hidden']), false);
  const key = (o) => ({ type: 'keyDown', key: 'q', control: true, shift: false, alt: false, meta: false, ...o });
  assert.strictEqual(BG.isQuitKey(key({})), true);
  assert.strictEqual(BG.isQuitKey(key({ key: 'Q' })), true);
  assert.strictEqual(BG.isQuitKey(key({ control: false })), false);
  assert.strictEqual(BG.isQuitKey(key({ shift: true })), false);
  assert.strictEqual(BG.isQuitKey(key({ type: 'keyUp' })), false);
  assert.strictEqual(BG.isQuitKey(key({ key: 'w' })), false);
  assert.strictEqual(BG.isQuitKey(null), false);
});

test('Tray-valikko: Avaa Statsikka, pelien pikavalinnat (OW2 / RL / R6), Lopeta; valinnat kutsuvat oikeita toimintoja', () => {
  const calls = [];
  const t = BG.buildTrayTemplate({ onOpen: () => calls.push('open'), onGame: (g) => calls.push(`game:${g}`), onQuit: () => calls.push('quit') });
  assert.deepStrictEqual(t.map((i) => i.type === 'separator' ? '-' : i.label), ['Avaa Statsikka', '-', 'Overwatch 2', 'Rocket League', 'Rainbow Six Siege', '-', 'Lopeta']);
  t.filter((i) => i.click).forEach((i) => i.click());
  assert.deepStrictEqual(calls, ['open', 'game:ow', 'game:rl', 'game:r6', 'quit']);
  assert.strictEqual(BG.TRAY_TOOLTIP, 'Statsikka');
});

test('Käynnistys Windowsin mukana: argumentit (tavallinen Electron / ow-electron, GEP-kanava, --hidden) ja todellinen tila', () => {
  const base = { enabled: true, execPath: 'C:\\x\\electron.exe', appPath: 'C:\\Users\\a b\\stats-tracker', devChannel: true, hasOverwolf: false };
  // tavallinen Electron: ei GEP-kanavaa vaikka asetus on päällä
  assert.deepStrictEqual(BG.buildLoginItem(base), { openAtLogin: true, path: 'C:\\x\\electron.exe', args: ['C:\\Users\\a b\\stats-tracker', '--hidden'] });
  // ow-electron: execPath on ow-electron-binääri, GEP-kanava mukaan (asetus päällä)
  const ow2 = BG.buildLoginItem({ ...base, execPath: 'C:\\x\\ow-electron.exe', hasOverwolf: true });
  assert.deepStrictEqual(ow2, { openAtLogin: true, path: 'C:\\x\\ow-electron.exe', args: ['C:\\Users\\a b\\stats-tracker', '--hidden', OWL.CHANNEL_ARG] });
  // ow-electron, kanava pois
  assert.deepStrictEqual(BG.buildLoginItem({ ...base, hasOverwolf: true, devChannel: false }).args, ['C:\\Users\\a b\\stats-tracker', '--hidden']);
  // poisto: sama polku ja argumentit, openAtLogin false
  assert.deepStrictEqual(BG.buildLoginItem({ ...base, enabled: false }), { openAtLogin: false, path: 'C:\\x\\electron.exe', args: ['C:\\Users\\a b\\stats-tracker', '--hidden'] });
  assert.ok(BG.isHiddenStart(ow2.args)); // --hidden on mukana ja tunnistetaan
  // todellinen tila: Tehtävienhallinnassa pois kytketty kohde ei käynnisty
  assert.strictEqual(BG.loginEnabled({ openAtLogin: true, executableWillLaunchAtLogin: true }), true);
  assert.strictEqual(BG.loginEnabled({ openAtLogin: true }), true);
  assert.strictEqual(BG.loginEnabled({ openAtLogin: true, executableWillLaunchAtLogin: false }), false);
  assert.strictEqual(BG.loginEnabled({ openAtLogin: false, executableWillLaunchAtLogin: true }), false);
  assert.strictEqual(BG.loginEnabled(null), false);
});

// ---- Päivitykset (updater.js): tilakone feikki-autoUpdaterilla --------------------------------------------------
const UPD = require('../src/main/updater');
function fakeAu(over = {}) {
  const au = new EventEmitter();
  au.calls = [];
  au.checkForUpdates = async () => { au.calls.push('check'); if (over.check) return over.check(au); return null; };
  au.quitAndInstall = () => {};
  return au;
}
function mkUpd(o = {}) {
  const au = o.au || fakeAu();
  const sent = [];
  const timers = [];
  const clock = { t: 1000 };
  const u = UPD.createUpdater({
    app: { isPackaged: o.packaged !== false, getVersion: () => '1.2.0' }, autoUpdater: au, smoke: !!o.smoke, send: (ch, p) => sent.push([ch, p]),
    beforeInstall: o.beforeInstall, now: () => ++clock.t,
    setTimeout: (fn, ms) => { const tm = { fn, ms, cleared: false, unref() { this.unrefd = true; } }; timers.push(tm); return tm; },
    clearTimeout: (tm) => { tm.cleared = true; },
  });
  return { u, au, sent, timers };
}

test('Päivitys: kehitysajo (ei paketoitu) -> tila dev, no-op: ei ajastimia eikä tarkistuksia', async () => {
  const { u, au, sent, timers } = mkUpd({ packaged: false });
  assert.strictEqual(u.enabled, false);
  u.start();
  assert.strictEqual(timers.length, 0);
  const s = await u.check();
  assert.strictEqual(s.state, 'dev');
  assert.strictEqual(s.current, '1.2.0');
  assert.strictEqual(s.text, 'Päivitykset ovat käytössä vain asennetussa versiossa.');
  assert.deepStrictEqual(au.calls, []);
  assert.deepStrictEqual(sent, []);
  assert.throws(() => u.install(), /asennetussa versiossa/);
});

test('Päivitys: savutesti (paketoitu + --smoke-test) -> tila disabled, no-op', async () => {
  const { u, au, timers } = mkUpd({ smoke: true });
  u.start();
  assert.strictEqual(timers.length, 0);
  assert.strictEqual((await u.check()).state, 'disabled');
  assert.deepStrictEqual(au.calls, []);
  assert.strictEqual(UPD.statusText(u.state()), UPD.DEV_TEXT);
});

test('Päivitys: asetukset (autoDownload, autoInstallOnAppQuit) ja ajastus 15 s + 6 h (unref), stop peruu', () => {
  const { u, au, timers } = mkUpd();
  u.start();
  assert.strictEqual(au.autoDownload, true);
  assert.strictEqual(au.autoInstallOnAppQuit, true);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 15000);
  assert.strictEqual(timers[0].unrefd, true);
  assert.strictEqual(UPD.CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  u.start(); // toinen start ei tuplaa ajastinta
  assert.strictEqual(timers.length, 1);
  u.stop();
  assert.strictEqual(timers[0].cleared, true);
});

test('Päivitys: ajastettu tarkistus ajaa checkForUpdates ja ajastaa seuraavan 6 h päähän', async () => {
  const { u, au, timers } = mkUpd();
  u.start();
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(au.calls, ['check']);
  assert.strictEqual(timers.length, 2);
  assert.strictEqual(timers[1].ms, UPD.CHECK_INTERVAL_MS);
  assert.strictEqual(timers[1].unrefd, true);
  u.stop();
});

test('Päivitys: tilakone checking -> available -> download-progress -> downloaded; tapahtumat renderöijälle', async () => {
  const { u, au, sent } = mkUpd();
  u.start();
  assert.strictEqual(u.state().state, 'idle');
  const p = u.check();
  au.emit('checking-for-update');
  assert.strictEqual(u.state().state, 'checking');
  assert.strictEqual(u.state().text, 'Tarkistetaan…');
  au.emit('update-available', { version: '1.3.0' });
  assert.strictEqual(u.state().state, 'available');
  assert.strictEqual(u.state().latest, '1.3.0');
  au.emit('download-progress', { percent: 42.4 });
  let s = u.state();
  assert.strictEqual(s.state, 'downloading');
  assert.strictEqual(s.percent, 42);
  assert.strictEqual(s.text, 'Ladataan versiota 1.3.0 (42 %)');
  au.emit('update-downloaded', { version: '1.3.0' });
  await p;
  s = u.state();
  assert.strictEqual(s.state, 'downloaded');
  assert.strictEqual(s.percent, 100);
  assert.strictEqual(s.latest, '1.3.0');
  assert.strictEqual(s.current, '1.2.0');
  assert.strictEqual(s.error, null);
  assert.ok(s.checkedAt);
  assert.strictEqual(s.text, 'Versio 1.3.0 ladattu');
  assert.ok(sent.every(([ch]) => ch === 'updater:state'));
  assert.deepStrictEqual(sent.map(([, x]) => x.state), ['checking', 'available', 'downloading', 'downloaded']);
  // ladattua päivitystä ei korvata uudella tarkistuksella
  const calls = au.calls.length;
  await u.check();
  assert.strictEqual(au.calls.length, calls);
  assert.strictEqual(u.state().state, 'downloaded');
});

test('Päivitys: ei uutta versiota -> none; ei päällekkäisiä tarkistuksia', async () => {
  const au = fakeAu({ check: (a) => { a.emit('checking-for-update'); return new Promise((r) => setImmediate(() => { a.emit('update-not-available', { version: '1.2.0' }); r(null); })); } });
  const { u } = mkUpd({ au });
  u.start();
  const p1 = u.check();
  const p2 = u.check(); // kesken: ohitetaan
  assert.strictEqual(au.calls.length, 1);
  await Promise.all([p1, p2]);
  const s = u.state();
  assert.strictEqual(s.state, 'none');
  assert.strictEqual(s.text, 'Uusin versio käytössä');
  assert.ok(s.checkedAt);
});

test('Päivitys: virhe-tapahtuma -> tila error (ensimmäinen rivi, pituus rajattu); uusi tarkistus sallittu', async () => {
  const au = fakeAu({ check: (a) => { const e = new Error('HttpError: 404\nheaders: {...pitkä...}'); a.emit('error', e); throw e; } });
  const { u, sent } = mkUpd({ au });
  u.start();
  const s = await u.check();
  assert.strictEqual(s.state, 'error');
  assert.strictEqual(s.error, 'HttpError: 404');
  assert.strictEqual(s.text, 'Virhe: HttpError: 404');
  assert.strictEqual(sent.filter(([, x]) => x.state === 'error').length, 1); // error-tapahtuma + hylkäys eivät kirjaudu kahdesti
  assert.strictEqual(UPD.errorMessage(new Error('x'.repeat(500))).length, 201);
  await u.check();
  assert.strictEqual(au.calls.length, 2);
});

test('Päivitys: checkForUpdates hylkää ilman error-tapahtumaa -> tila error', async () => {
  const { u } = mkUpd({ au: fakeAu({ check: () => { throw new Error('verkko poikki'); } }) });
  u.start();
  const s = await u.check();
  assert.strictEqual(s.state, 'error');
  assert.strictEqual(s.error, 'verkko poikki');
});

test('Päivitys: asennus vaatii ladatun päivityksen; kutsuu beforeInstall ja quitAndInstall(true, true)', () => {
  const order = [];
  const au = fakeAu();
  au.quitAndInstall = (a, b) => order.push(['quitAndInstall', a, b]);
  const { u } = mkUpd({ au, beforeInstall: () => order.push('before') });
  u.start();
  assert.throws(() => u.install(), /ei ole ladattu/);
  au.emit('update-downloaded', { version: '1.3.0' });
  assert.strictEqual(u.install(), true);
  assert.deepStrictEqual(order, ['before', ['quitAndInstall', true, true]]);
});

test('Päivitys: tilatekstit suomeksi', () => {
  const T = UPD.statusText;
  assert.strictEqual(T({ state: 'dev' }), 'Päivitykset ovat käytössä vain asennetussa versiossa.');
  assert.strictEqual(T({ state: 'checking' }), 'Tarkistetaan…');
  assert.strictEqual(T({ state: 'none' }), 'Uusin versio käytössä');
  assert.strictEqual(T({ state: 'downloading', latest: '2.0.0', percent: 7.6 }), 'Ladataan versiota 2.0.0 (8 %)');
  assert.strictEqual(T({ state: 'downloaded', latest: '2.0.0' }), 'Versio 2.0.0 ladattu');
  assert.strictEqual(T({ state: 'error', error: 'huono' }), 'Virhe: huono');
  assert.strictEqual(T({ state: 'idle' }), 'Päivityksiä ei ole vielä tarkistettu.');
});

// Arenyze (R6-tilastot): omassa tiedostossaan, jotta tämä pysyy luettavana.
require('./selftest-arenyze')({ test, assert, fs, os, path, ApiError, createSettings, sanitize, validate, S });

Promise.all(pending).then(() => {
  console.log(`\n${passed} läpi, ${failed} epäonnistui`);
  process.exit(failed ? 1 : 0);
});
