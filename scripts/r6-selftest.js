'use strict';
// Self-test for the R6 replay reader: pure helpers, fixtures and a synthetic .rec file.
// Run: node scripts/r6-selftest.js   (no game files needed)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { summarizeMatch, hsPercent, kd, kpr, aggregatePlayers } = require('../src/main/r6/summary');
const { formatClock, parseClock } = require('../src/main/r6/dissect/time');
const { operatorRole, operatorName, mapName, matchTypeName, gameModeName, T } = require('../src/main/r6/dissect/tables');
const { Reader } = require('../src/main/r6/dissect/reader');
const { newPlayer } = require('../src/main/r6/dissect/header');
const { roundToJSON } = require('../src/main/r6/dissect/stats');
const { frameEnd, decompressFrames } = require('../src/main/r6/dissect/zstd');
const { deriveTeamRoles } = require('../src/main/r6/dissect/player');
const { parseBuffer } = require('../src/main/r6/dissect');
const { parseLibraryFolders } = require('../src/main/r6/locate');
const { parseRound, parseMatchFolder } = require('../src/main/r6');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

const fixture = require('../test/r6/round-fixture.json');
const expected = require('../test/r6/expected-summary.json');

// ---- synthetic replay builder (chunked format: plain header + zstd frames) ----
const hstr = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length]), Buffer.alloc(7), b]);
};
const lstr = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s, 'utf8')]);
function buildRec({ kills = [], clock = 125 } = {}) {
  const props = [
    ['version', 'Y11S3_Test'], ['code', '9966156'], ['datetime', '2026-01-02-03-04-05'], ['matchtype', '2'],
    ['worldid', '999999999999'], ['recordingplayerid', '1'], ['recordingprofileid', 'pA'], ['gamemodeid', '327933806'],
    ['roundspermatch', '6'], ['roundspermatchovertime', '3'], ['roundnumber', '0'], ['overtimeroundnumber', '0'],
    ['teamname0', 'YOUR TEAM'], ['teamname1', 'ENEMY TEAM'], ['id', 'synthetic-match'], ['teamscore0', '1'], ['teamscore1', '0'],
  ];
  const header = Buffer.concat([
    Buffer.from('dissect'), Buffer.alloc(7), Buffer.from([1, 2, 3]), Buffer.alloc(7),
    ...props.flatMap(([k, v]) => [hstr(k), hstr(v)]),
  ]);
  const time = Buffer.concat([Buffer.from([0x1f, 0x07, 0xef, 0xc9, 0x04]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(clock); return b; })()]);
  const parts = [Buffer.alloc(16, 0xaa)];
  for (const k of kills) {
    parts.push(time);
    parts.push(Buffer.from([0x59, 0x34, 0xe5, 0x8b, 0x04]), Buffer.alloc(38), Buffer.from([0]),
      Buffer.from([0x22, 0xd9, 0x13, 0x3c, 0xba]), lstr(k.by), Buffer.alloc(15), lstr(k.target), Buffer.alloc(56), Buffer.from([k.hs ? 1 : 0]), Buffer.alloc(8, 0xbb));
  }
  parts.push(Buffer.alloc(32, 0xcc));
  const raw = Buffer.concat(parts);
  // two frames + trailing garbage like real files
  const half = Math.floor(raw.length / 2);
  return Buffer.concat([header, zlib.zstdCompressSync(raw.subarray(0, half)), zlib.zstdCompressSync(raw.subarray(half)), Buffer.from('tail-garbage')]);
}

// ---- synthetic Y11S3 stream pieces (scoreboard entities + operator swaps) ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const SB_FIELD = { kills: [0x1c, 0xd2, 0xb1, 0x9d], deaths: [0xcd, 0x9c, 0x5d, 0x72], assists: [0x4d, 0x73, 0x7f, 0x9e], other: [0x31, 0xa3, 0xd4, 0xd2], score: [0xec, 0xda, 0x4f, 0x80] };
const sbField = (name, v) => Buffer.concat([Buffer.from(SB_FIELD[name]), Buffer.from([4]), u32(v), Buffer.from([0x22])]);
const PLAYER_PAT = Buffer.from([0x22, 0x07, 0x94, 0x9b, 0xdc]);
/** `<player object (8)> EB219B38 <entity (4)> 00000000 ... <player block start> <username>` */
const sbLink = (obj, ent, name) => Buffer.concat([obj, Buffer.from([0xeb, 0x21, 0x9b, 0x38]), ent, Buffer.alloc(4), Buffer.alloc(40, 0xaa), PLAYER_PAT, lstr(name), Buffer.alloc(8, 0xbb)]);
const sbSnapshot = (ent, v) => Buffer.concat([ent, Buffer.alloc(4), sbField('kills', v.k), sbField('deaths', v.d), sbField('assists', v.a), sbField('other', 0), sbField('score', v.s), Buffer.alloc(6, 0xdd)]);
const sbUpdate = (ent, name, v) => Buffer.concat([ent, Buffer.alloc(4), Buffer.from(SB_FIELD[name]), Buffer.from([4]), u32(v), Buffer.alloc(6, 0xdd)]);
const clockPat = (sec) => Buffer.concat([Buffer.from([0x1f, 0x07, 0xef, 0xc9, 0x04]), u32(sec)]);
const swapRec = (obj, op) => Buffer.concat([Buffer.from([0x23]), obj, Buffer.from([0xf9, 0x39, 0x11, 0xf2, 0x08]), u64(0x1234), Buffer.from([0x22, 0xa9, 0x26, 0x0b, 0xe4, 0x08]), u64(op), Buffer.alloc(8, 0xdd)]);

function synthHeader(players) {
  return {
    gameVersion: 'Y11S3_Test', codeVersion: 9966156, timestamp: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), matchType: 2, map: 355496559878,
    site: '', recordingPlayerID: '1', recordingProfileID: 'pA', additionalTags: '', gameMode: 327933806, roundsPerMatch: 6,
    roundsPerMatchOvertime: 3, roundNumber: 1, overtimeRoundNumber: 0, gmSettings: [], playlistCategory: 0, matchID: 'synthetic-y11',
    teams: [
      { name: 'A', startingScore: 0, score: 1, won: false, winCondition: '', role: 'Attack' },
      { name: 'B', startingScore: 0, score: 0, won: false, winCondition: '', role: 'Defense' },
    ],
    players: players.map(([username, teamIndex, operator, id]) => Object.assign(newPlayer(), { username, teamIndex, operator, dissectID: Buffer.from([id, 0, 0, 0]) })),
  };
}
const ASH = 92270642656;
const THERMITE = 92270642760;
const CAPITAO = 92270644215;
const JAGER = 92270642604;

(async () => {
  await test('clock formatting/parsing', () => {
    assert.strictEqual(formatClock(0), '0:00');
    assert.strictEqual(formatClock(125), '2:05');
    assert.strictEqual(formatClock(59.9), '0:59');
    assert.strictEqual(parseClock('2:05'), 125);
    assert.strictEqual(parseClock('45'), 45);
    assert.ok(Number.isNaN(parseClock('x')));
  });

  await test('hs%, kd, kpr', () => {
    assert.strictEqual(hsPercent(2, 3), 66.7);
    assert.strictEqual(hsPercent(0, 0), 0);
    assert.strictEqual(kd(3, 1), 3);
    assert.strictEqual(kd(5, 0), 5);
    assert.strictEqual(kd(3, 4), 0.75);
    assert.strictEqual(kpr(3, 2), 1.5);
    assert.strictEqual(kpr(3, 0), 0);
  });

  await test('aggregation + summary match expected fixture', () => {
    const s = summarizeMatch(fixture.rounds);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), expected);
    const agg = aggregatePlayers(fixture.rounds);
    assert.strictEqual(agg.find((p) => p.username === 'A').kills, 3);
    assert.strictEqual(agg.find((p) => p.username === 'D').deaths, 2);
  });

  await test('winner and result derive from final scores', () => {
    const rounds = JSON.parse(JSON.stringify(fixture.rounds));
    rounds[1].teams[0].score = 2;
    rounds[1].teams[0].won = true;
    rounds[1].teams[1].won = false;
    rounds[1].teams[1].score = 0;
    const s = summarizeMatch(rounds);
    assert.strictEqual(s.winnerTeamIndex, 0);
    assert.strictEqual(s.ownTeamIndex, 0);
    assert.strictEqual(s.result, 'win');
    assert.strictEqual(summarizeMatch([]), null);
  });

  await test('unknown operator/map ids never throw', () => {
    assert.strictEqual(operatorRole(999999999999), 'Unknown');
    assert.strictEqual(operatorName(999999999999), 'Operaattori 999999999999');
    assert.strictEqual(operatorName(92270642656), 'Ash');
    assert.strictEqual(operatorRole(92270642656), 'Attack');
    assert.strictEqual(mapName(123), 'Kartta 123');
    assert.strictEqual(mapName(355496559878), 'Bank');
  });

  await test('Y11 operator, map and match type tables', () => {
    assert.strictEqual(operatorName(444310693746), 'Solid Snake');
    assert.strictEqual(operatorRole(444310693746), 'Attack');
    assert.strictEqual(operatorName(456757346397), 'Noor');
    assert.strictEqual(operatorRole(456757346397), 'Defense');
    assert.strictEqual(mapName(398899676157), 'FortressY10');
    assert.strictEqual(mapName(436375283234), 'CoastlineY10');
    assert.strictEqual(mapName(434715462383), 'OregonY10');
    assert.strictEqual(mapName(441825219764), 'OutbackY11');
    assert.strictEqual(mapName(441408792952), 'KanalY11');
    assert.strictEqual(mapName(419965653950), 'Kartta 419965653950'); // still unidentified
    assert.strictEqual(matchTypeName(13), 'TeamDeathmatch');
    assert.strictEqual(gameModeName(32905809967), 'TeamDeathmatch');
  });

  await test('team roles skip unknown operators and infer from known ones', () => {
    const mk = (op, team) => ({ operator: op, teamIndex: team, dissectID: Buffer.from([team, 0, 0, 0]) });
    const r = {
      header: { players: [mk(999999999999, 0), mk(92270642656, 1), mk(0, 1)], teams: [{ role: '' }, { role: '' }] },
      scoreboard: { players: [] },
    };
    deriveTeamRoles(r);
    assert.strictEqual(r.header.teams[1].role, 'Attack');
    assert.strictEqual(r.header.teams[0].role, 'Defense');
    assert.strictEqual(r.header.players.length, 2); // player without operator removed
  });

  await test('zstd frame walker + multi-frame decompression with garbage', () => {
    const a = Buffer.from('hello '.repeat(500));
    const b = Buffer.from('world '.repeat(500));
    const fa = zlib.zstdCompressSync(a);
    const fb = zlib.zstdCompressSync(b);
    assert.strictEqual(frameEnd(fa, 0), fa.length);
    const buf = Buffer.concat([Buffer.from('xx'), fa, Buffer.from('junk'), fb, Buffer.from('trailing')]);
    const warn = [];
    assert.deepStrictEqual(decompressFrames(buf, 0, warn), Buffer.concat([a, b]));
    // truncated last frame is skipped with a warning
    const warn2 = [];
    const out = decompressFrames(Buffer.concat([fa, fb.subarray(0, fb.length - 3)]), 0, warn2);
    assert.deepStrictEqual(out, a);
    assert.ok(warn2.length >= 1);
  });

  await test('synthetic .rec: header, time and kill feed parse', async () => {
    const buf = buildRec({ kills: [{ by: 'Alice', target: 'Bob', hs: true }, { by: 'Alice', target: 'Carl', hs: false }, { by: 'Alice', target: 'Bob', hs: true }] });
    const r = parseBuffer(buf);
    assert.strictEqual(r.codeVersion, 9966156);
    assert.strictEqual(r.timestamp, '2026-01-02T03:04:05Z');
    assert.deepStrictEqual(r.map, { name: 'Kartta 999999999999', id: 999999999999 });
    assert.strictEqual(r.matchID, 'synthetic-match');
    assert.deepStrictEqual(r.teams.map((t) => t.score), [1, 0]);
    const kills = r.matchFeedback.filter((m) => m.type.name === 'Kill');
    assert.strictEqual(kills.length, 2); // duplicate Alice->Bob dropped like upstream
    assert.deepStrictEqual(kills[0], { type: { name: 'Kill', id: 0 }, username: 'Alice', target: 'Bob', headshot: true, time: '2:05', timeInSeconds: 125 });
    assert.strictEqual(kills[1].headshot, false);
    // file API
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6st-'));
    const md = path.join(dir, 'Match-2026-01-02_03-04-05-1');
    fs.mkdirSync(md);
    fs.writeFileSync(path.join(md, 'Match-2026-01-02_03-04-05-1-R01.rec'), buf);
    fs.writeFileSync(path.join(md, 'Match-2026-01-02_03-04-05-1-R02.rec'), Buffer.from('garbage that is not a replay'));
    const pr = await parseRound(path.join(md, 'Match-2026-01-02_03-04-05-1-R01.rec'), { cache: null });
    assert.strictEqual(pr.roundIndex, 1);
    const m = await parseMatchFolder(md, { cache: null });
    assert.strictEqual(m.rounds.length, 1);
    assert.strictEqual(m.errors.length, 1); // bad round reported, match still returned
    assert.strictEqual(m.errors[0].file, 'Match-2026-01-02_03-04-05-1-R02.rec');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('Y11S3 scoreboard entities: snapshot, updates, round deltas', () => {
    const OA = Buffer.from([0x11, 0x14, 0x37, 0xf0, 0, 0, 0, 0]);
    const OB = Buffer.from([0x12, 0x14, 0x37, 0xf0, 0, 0, 0, 0]);
    const EA = Buffer.from([0x21, 0x14, 0x37, 0xf0]);
    const EB = Buffer.from([0x22, 0x14, 0x37, 0xf0]);
    const EX = Buffer.from([0x23, 0x25, 0x37, 0xf0]); // entity without a player block
    const data = Buffer.concat([
      Buffer.alloc(16, 0xaa),
      sbLink(OA, EA, 'Alice'), sbSnapshot(EA, { k: 1, d: 0, a: 2, s: 300 }),
      sbLink(OB, EB, 'Bob'), sbSnapshot(EB, { k: 0, d: 1, a: 0, s: 100 }),
      sbUpdate(EA, 'kills', 2), sbUpdate(EA, 'assists', 3), sbUpdate(EA, 'score', 450), sbUpdate(EB, 'deaths', 2),
      sbUpdate(EX, 'score', 999), sbUpdate(EA, 'score', 460), Buffer.alloc(32, 0xcc),
    ]);
    const r = new Reader(data, { header: synthHeader([['Alice', 0, ASH, 1], ['Bob', 1, JAGER, 2]]), only: ['sbEntity', 'sbKills', 'sbDeaths', 'score', 'assists'] });
    r.rolesDerived = true;
    r.read();
    const j = roundToJSON(r);
    const a = j.stats.find((s) => s.username === 'Alice');
    const b = j.stats.find((s) => s.username === 'Bob');
    assert.strictEqual(a.assists, 1, 'assists = final - round-start snapshot');
    assert.strictEqual(a.assistsStart, 2);
    assert.strictEqual(a.score, 460, 'score is the last scoreboard value (match-cumulative)');
    assert.strictEqual(a.scoreStart, 300);
    assert.strictEqual(a.roundScore, 160);
    assert.strictEqual(a.sbKills, 1);
    assert.strictEqual(a.sbDeaths, 0);
    assert.strictEqual(b.assists, 0);
    assert.strictEqual(b.score, 100);
    assert.strictEqual(b.roundScore, 0);
    assert.strictEqual(b.sbDeaths, 1);
    assert.deepStrictEqual([...r.sbLinks.values()].sort(), ['Alice', 'Bob']);
  });

  await test('legacy (pre-Y11S3) scoreboard layout still works without entity links', () => {
    const legacyAssist = (n, id) => Buffer.concat([Buffer.from(SB_FIELD.assists), Buffer.from([4]), u32(n), Buffer.alloc(30, 0), Buffer.from([id, 0, 0, 0]), Buffer.alloc(8, 0xdd)]);
    const legacyScore = (n, id) => Buffer.concat([Buffer.from(SB_FIELD.score), Buffer.from([4]), u32(n), Buffer.alloc(13, 0), Buffer.from([id, 0, 0, 0]), Buffer.alloc(8, 0xdd)]);
    const data = Buffer.concat([Buffer.alloc(16, 0xaa), legacyAssist(1, 1), legacyAssist(2, 1), legacyScore(250, 2), Buffer.alloc(32, 0xcc)]);
    const r = new Reader(data, { header: synthHeader([['Alice', 0, ASH, 1], ['Bob', 1, JAGER, 2]]), only: ['sbEntity', 'sbKills', 'sbDeaths', 'score', 'assists'] });
    r.rolesDerived = true;
    r.read();
    const j = roundToJSON(r);
    assert.strictEqual(j.stats[0].assists, 2); // assistsFromRound counts increments
    assert.strictEqual(j.stats[1].score, 250);
    assert.strictEqual(j.stats[0].roundScore, undefined); // legacy rounds carry no Y11S3 extras
  });

  await test('Y11S3 operator swaps: prep-phase changes keep the round-start operator', () => {
    const OA = Buffer.from([0x11, 0x14, 0x37, 0xf0, 0, 0, 0, 0]);
    const OB = Buffer.from([0x12, 0x14, 0x37, 0xf0, 0, 0, 0, 0]);
    const OX = Buffer.from([0x77, 0x14, 0x37, 0xf0, 0, 0, 0, 0]); // object of nobody
    const EA = Buffer.from([0x21, 0x14, 0x37, 0xf0]);
    const EB = Buffer.from([0x22, 0x14, 0x37, 0xf0]);
    const data = Buffer.concat([
      Buffer.alloc(16, 0xaa), clockPat(45),
      sbLink(OA, EA, 'Alice'), sbLink(OB, EB, 'Bob'),
      clockPat(40), swapRec(OA, THERMITE),
      clockPat(30), swapRec(OA, THERMITE), // same operator again: no event
      swapRec(OX, CAPITAO), // unknown object: ignored
      swapRec(OA, 0), // empty operator: ignored
      clockPat(12), swapRec(OA, CAPITAO),
      Buffer.alloc(32, 0xcc),
    ]);
    const r = new Reader(data, { header: synthHeader([['Alice', 0, ASH, 1], ['Bob', 1, JAGER, 2]]), only: ['sbEntity', 'time', 'atkOpSwap'] });
    r.rolesDerived = true;
    r.read();
    const j = roundToJSON(r);
    const swaps = j.matchFeedback.filter((m) => m.type.name === 'OperatorSwap');
    assert.deepStrictEqual(swaps.map((m) => [m.username, m.operator.name, m.time]), [['Alice', 'Thermite', '0:40'], ['Alice', 'Capitao', '0:12']]);
    const alice = j.players.find((p) => p.username === 'Alice');
    assert.strictEqual(alice.operator.name, 'Capitao', 'final operator');
    assert.strictEqual(alice.operator.role, 'Attack');
    assert.deepStrictEqual(alice.startOperator, { name: 'Ash', id: ASH }, 'round-start operator');
    const bob = j.players.find((p) => p.username === 'Bob');
    assert.strictEqual(bob.operator.name, 'Jager');
    assert.strictEqual(bob.startOperator, undefined);
    assert.strictEqual(j.stats.find((s) => s.username === 'Alice').operator, 'Capitao');
  });

  await test('summary: swaps listed, scoreboard corrected from next round snapshot', () => {
    const mkRound = (n, ts, stats, swaps) => ({
      matchID: 'm1', roundNumber: n, timestamp: ts, map: { name: 'Bank', id: 1 }, matchType: { name: 'Ranked', id: 2 }, gamemode: { name: 'Bomb', id: 3 },
      gameVersion: 'Y11S3', roundsPerMatch: 6, recordingProfileID: 'pA', recordingPlayerID: '1', site: 'x',
      teams: [{ name: 'T0', score: n + 1, won: true, role: 'Attack' }, { name: 'T1', score: 0, won: false, role: 'Defense' }],
      players: [{ profileID: 'pA', username: 'A', teamIndex: 0, operator: { name: 'Capitao', id: CAPITAO, role: 'Attack' }, startOperator: { name: 'Ash', id: ASH } }],
      matchFeedback: swaps ? [{ type: { name: 'OperatorSwap', id: 7 }, username: 'A', time: '0:20', timeInSeconds: 20, operator: { name: 'Capitao', id: CAPITAO } }] : [],
      stats,
    });
    const st = (o) => Object.assign({ username: 'A', kills: 0, died: false, headshots: 0, teamIndex: 0 }, o);
    // round 1 ends before its last scoreboard updates (+100 score, +1 assist); round 2's snapshot has them
    const rounds = [
      mkRound(0, '2026-01-01T10:00:00Z', [st({ score: 200, scoreStart: 0, roundScore: 200, assists: 0, assistsStart: 0 })], true),
      mkRound(1, '2026-01-01T10:05:00Z', [st({ score: 400, scoreStart: 300, roundScore: 100, assists: 1, assistsStart: 1 })], false),
    ];
    const before = JSON.stringify(rounds);
    const s = summarizeMatch(rounds);
    assert.strictEqual(JSON.stringify(rounds), before, 'input is not mutated');
    assert.strictEqual(s.operatorSwapCount, 1);
    assert.deepStrictEqual(s.rounds[0].operatorSwaps, [{ username: 'A', operator: { name: 'Capitao', id: CAPITAO }, time: '0:20', timeInSeconds: 20 }]);
    assert.deepStrictEqual(s.rounds[1].operatorSwaps, []);
    const p = s.players[0];
    assert.strictEqual(p.score, 300 + 100); // 300 from the snapshot of round 2, 100 of the last round
    assert.strictEqual(p.assists, 1 + 1);
    assert.strictEqual(p.operators[0].id, CAPITAO);
  });

  // ---- Y11S3 defuser layout: timer is a property of the acting player's pawn (see dissect/defuse.js) ----
  const f32 = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return b; };
  const PAWN_LINK_PAT = Buffer.from([0x27, 0xc0, 0x8d, 0xca]);
  /** `1B <slot> 00000000 27C08DCA <pawn> 00000000 [... player block]`; a null pawn is the slot's first link, followed by the player block */
  const pawnLink = (slot, pawn, name) => Buffer.concat([
    Buffer.from([0x1b]), slot, Buffer.alloc(4), PAWN_LINK_PAT, pawn, Buffer.alloc(4),
    name ? Buffer.concat([Buffer.alloc(30, 0xaa), PLAYER_PAT, lstr(name)]) : Buffer.alloc(0), Buffer.alloc(8, 0xbb),
  ]);
  /** `[23 <pawn> 00000000 E58C06E9 04 <state> 22 | 23 <pawn> 00000000] E9A37FEB 04 <remaining> 22 A9C858D9 <len> <text>` */
  const dTimer = (pawn, state, remaining, text) => Buffer.concat([
    Buffer.from([0x23]), pawn, Buffer.alloc(4),
    ...(state === null ? [] : [Buffer.from([0xe5, 0x8c, 0x06, 0xe9, 0x04]), u32(state), Buffer.from([0x22])]),
    Buffer.from([0xe9, 0xa3, 0x7f, 0xeb, 0x04]), f32(remaining), Buffer.from([0x22, 0xa9, 0xc8, 0x58, 0xd9]), lstr(text), Buffer.alloc(12, 0xdd),
  ]);
  const quad = (a, b) => Buffer.from([a, b, 0x1c, 0xf0]);
  const SLOT_A = quad(0x45, 0xd7);
  const SLOT_B = quad(0x46, 0xd7);
  const PAWN_A = quad(0x41, 0xf2);
  const PAWN_B = quad(0x42, 0xf2);
  const PAWN_X = quad(0x77, 0xf2); // never linked to a slot
  const dLinks = () => Buffer.concat([
    pawnLink(SLOT_A, Buffer.alloc(4), 'Alice'), pawnLink(SLOT_B, Buffer.alloc(4), 'Bob'),
    pawnLink(SLOT_A, PAWN_A), pawnLink(SLOT_B, PAWN_B),
  ]);
  const dHeader = (opts = {}) => {
    const h = synthHeader([['Alice', 0, ASH, 1], ['Alice2', 0, THERMITE, 2], ['Bob', 1, JAGER, 3], ['Bob2', 1, JAGER, 4]]);
    if (opts.teamsWon) { h.teams[0].score = opts.teamsWon[0] ? 1 : 0; h.teams[1].score = opts.teamsWon[1] ? 1 : 0; }
    return h;
  };
  const dRead = (parts, opts = {}) => {
    const r = new Reader(Buffer.concat([Buffer.alloc(16, 0xaa), ...parts, Buffer.alloc(32, 0xcc)]), { header: dHeader(opts), only: ['time', 'pawnLink', 'defuser'] });
    r.rolesDerived = true;
    for (const e of opts.feed || []) r.matchFeedback.push({ type: e.type, username: e.username || '', target: e.target || '', headshot: null, time: '', timeInSeconds: 0, message: '', operator: 0 });
    r.read();
    return r;
  };
  const TYPE_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
  const dNames = (r) => r.matchFeedback.filter((e) => e.type >= T.DefuserPlantStart && e.type <= T.DefuserDisableComplete).map((e) => `${TYPE_NAME[e.type]}:${e.username}@${e.time}`);

  await test('Y11S3 defuser: plant is attributed through pawn -> slot -> player, trailing 0.000 is not a disable', () => {
    const r = dRead([
      dLinks(), clockPat(110),
      dTimer(PAWN_A, 0, 1, '6.970'), dTimer(PAWN_A, null, 0.9, '6.200'), dTimer(PAWN_A, null, 0.1, '0.700'),
      clockPat(104), dTimer(PAWN_A, null, 0, '0.007'), dTimer(PAWN_A, 2, 0, '0.000'), dTimer(PAWN_A, null, 0, '0.000'),
    ]);
    assert.deepStrictEqual(dNames(r), ['DefuserPlantStart:Alice@1:50', 'DefuserPlantComplete:Alice@1:44']);
    assert.strictEqual(r.planted, true);
    assert.strictEqual(r.header.teams[0].won, true);
    assert.strictEqual(r.header.teams[0].winCondition, 'DefusedBomb');
  });

  await test('Y11S3 defuser: cancelled attempts, restarts and a disable by the other team', () => {
    const r = dRead([
      dLinks(),
      clockPat(120), dTimer(PAWN_A, 0, 1, '6.970'), dTimer(PAWN_A, 2, 0.5, '3.400'), // cancelled
      clockPat(110), dTimer(PAWN_A, 0, 1, '6.970'), dTimer(PAWN_A, null, 0, '0.006'),
      clockPat(40), dTimer(PAWN_B, 1, 1, '6.930'), dTimer(PAWN_B, 2, 0.8, '5.400'), // defender gives up
      clockPat(30), dTimer(PAWN_B, 1, 1, '6.930'), dTimer(PAWN_B, null, 0, '0.004'), dTimer(PAWN_B, 2, 0, '0.000'),
    ], { teamsWon: [false, true] });
    assert.deepStrictEqual(dNames(r), [
      'DefuserPlantStart:Alice@2:00', 'DefuserPlantStart:Alice@1:50', 'DefuserPlantComplete:Alice@1:50',
      'DefuserDisableStart:Bob@0:40', 'DefuserDisableStart:Bob@0:30', 'DefuserDisableComplete:Bob@0:30',
    ]);
    assert.strictEqual(r.planted, false);
    assert.strictEqual(r.header.teams[1].winCondition, 'DisabledDefuser');
  });

  await test('Y11S3 defuser: unresolved pawn falls back to the only living player of the acting side', () => {
    const parts = [dLinks(), clockPat(100), dTimer(PAWN_X, 0, 1, '6.970'), dTimer(PAWN_X, null, 0, '0.003')];
    assert.deepStrictEqual(dNames(dRead(parts)), ['DefuserPlantComplete:@1:40'], 'two attackers alive: nobody is guessed');
    const r = dRead(parts, { feed: [{ type: T.Death, username: 'Alice2' }] });
    assert.deepStrictEqual(dNames(r), ['DefuserPlantStart:Alice@1:40', 'DefuserPlantComplete:Alice@1:40']);
    // a pawn that resolves to a slot without a known player is not guessed either
    const r2 = dRead([pawnLink(SLOT_A, Buffer.alloc(4), 'Alice'), pawnLink(SLOT_B, PAWN_B), clockPat(100), dTimer(PAWN_B, 0, 1, '6.970'), dTimer(PAWN_B, null, 0, '0.003')]);
    assert.deepStrictEqual(dNames(r2), ['DefuserPlantComplete:@1:40']);
  });

  await test('Y11S3 defuser: a disable cut off by the end of the recording completes only when the defenders won', () => {
    const run = (last, won, who = PAWN_B, st = 1) => dRead([dLinks(), clockPat(60), dTimer(who, st, 1, '6.930'), dTimer(who, null, last / 7, last.toFixed(3))], { teamsWon: won });
    assert.deepStrictEqual(dNames(run(0.017, [false, true])), ['DefuserDisableStart:Bob@1:00', 'DefuserDisableComplete:Bob@1:00']);
    assert.deepStrictEqual(dNames(run(0.017, [true, false])), ['DefuserDisableStart:Bob@1:00'], 'defenders lost: not completed');
    assert.deepStrictEqual(dNames(run(0.5, [false, true])), ['DefuserDisableStart:Bob@1:00'], 'too much left: cut-off recording');
    assert.deepStrictEqual(dNames(run(0.017, [true, false], PAWN_A, 0)), ['DefuserPlantStart:Alice@1:00'], 'a plant is never inferred (elimination can end the round mid-plant)');
  });

  await test('legacy defuser layout (player id after the timer) is unchanged', () => {
    const legacy = (text, id) => Buffer.concat([Buffer.from([0x22, 0xa9, 0xc8, 0x58, 0xd9]), lstr(text), Buffer.alloc(34, 0xdd), Buffer.from([id, 0, 0, 0]), Buffer.alloc(8, 0xee)]);
    const r = dRead([clockPat(100), legacy('6.970', 2), legacy('0.005', 9)]);
    assert.deepStrictEqual(dNames(r), ['DefuserPlantStart:Alice2@1:40', 'DefuserPlantComplete:Alice2@1:40']);
  });

  await test('invalid input is rejected, not crashed', () => {
    assert.throws(() => parseBuffer(Buffer.from('nope nope nope')), /not a dissect file/);
    assert.throws(() => parseBuffer(Buffer.alloc(2)), /too short|not a dissect/);
  });

  await test('steam libraryfolders.vdf parsing', () => {
    const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}';
    assert.deepStrictEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})();
