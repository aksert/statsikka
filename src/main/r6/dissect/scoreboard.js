'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/scoreboard.go.
//
// Y11S3 scoreboard format. The format description (entity ids instead of a player id after each
// value, round-start snapshot, field order) comes from the fork Animuxs/r6-stats-app (MIT,
// Copyright (c) 2022 Benjamin Ryan; dissect/scoreboard.go) and was re-verified against the
// decompressed Y11S3 replays; the implementation below is independent:
//
//   <player object (8)> EB219B38 <scoreboard entity (4)> 00000000 ... <player block (22 07 94 9B DC ...)>
//   update  : <entity (4)> 00000000 <field (4)> 04 <u32> ...
//   snapshot: <entity (4)> 00000000 <kills> 04 <v> 22 <deaths> 04 <v> 22 <assists> 04 <v> 22 <?> 04 <v> 22 <score> 04 <v> ...
//
// The snapshot is written once per entity at round start and holds the values accumulated over the
// match so far (kills, deaths, assists, score are match-cumulative). Round values are final - snapshot.
//
// Replays older than Y11S3 have no entity links; the original upstream layout
// (<field> 04 <u32> + fixed skip + 4-byte player id) is used for them.

const FIELD_KILLS = [0x1c, 0xd2, 0xb1, 0x9d];
const FIELD_DEATHS = [0xcd, 0x9c, 0x5d, 0x72];
const PLAYER_INDICATOR = Buffer.from([0x22, 0x07, 0x94, 0x9b, 0xdc]);
const FIELD_SIZE = 10; // field (4) + 0x04 (1) + value (4) + 0x22 (1)

function sbPlayer(r, idx) {
  const arr = r.scoreboard.players;
  while (arr.length <= idx) arr.push({ id: null, score: 0, assists: 0, assistsFromRound: 0 });
  return arr[idx];
}

/** Per-username scoreboard record of the Y11S3 layout: `snap` = round-start values, `cur` = last seen. */
function sbUser(r, username) {
  let u = r.sbUsers.get(username);
  if (!u) {
    u = { snap: {}, cur: {} };
    r.sbUsers.set(username, u);
  }
  return u;
}

/**
 * `<player object> EB219B38 <scoreboard entity>`: links the scoreboard entity (and the player object
 * used by operator swaps) to the player block that follows within a few hundred bytes.
 */
function readScoreboardEntity(r) {
  const b = r.b;
  const patStart = r.offset - 4;
  if (patStart < 8 || r.offset + 8 > b.length) return;
  const end = Math.min(b.length, r.offset + 256);
  const j = b.subarray(r.offset, end).indexOf(PLAYER_INDICATOR);
  if (j < 0) return;
  const at = r.offset + j + PLAYER_INDICATOR.length;
  const size = b[at];
  if (at + 1 + size > b.length) return;
  const username = b.toString('utf8', at + 1, at + 1 + size);
  r.sbLinks.set(b.readUInt32LE(r.offset), username);
  r.playerObjects.set(b.toString('hex', patStart - 8, patStart), username);
}

/**
 * Handles a scoreboard field whose 4-byte pattern ended at r.offset (so it starts at offset-4).
 * Returns false when the replay uses the legacy layout (no entity links seen).
 */
function readEntityField(r, name) {
  if (r.sbLinks.size === 0) return false;
  const b = r.b;
  const start = r.offset - 4;
  if (b[r.offset] !== 0x04 || r.offset + 5 > b.length) return true;
  // walk back through the snapshot's fields to `<entity> 00000000`
  let entity = -1;
  let steps = 0;
  for (let k = start; k >= 8; k -= FIELD_SIZE, steps++) {
    if (b.readUInt32LE(k - 4) === 0) {
      entity = b.readUInt32LE(k - 8);
      break;
    }
    if (k < FIELD_SIZE || b[k - 1] !== 0x22 || b[k - 6] !== 0x04) break;
  }
  const username = r.sbLinks.get(entity);
  if (entity < 0 || username === undefined) return true;
  let snapshot = steps > 0;
  if (!snapshot && name === 'kills') {
    // the snapshot's first field looks like an update, but is followed by the deaths field
    const nx = start + FIELD_SIZE;
    snapshot = nx + 4 <= b.length && b[nx - 1] === 0x22 && FIELD_DEATHS.every((x, i) => b[nx + i] === x);
  }
  const value = b.readUInt32LE(r.offset + 1);
  const u = sbUser(r, username);
  // opt-in diagnostics (scripts/r6-validate.js): score updates in file order, with the feed position they occurred at
  if (r.sbLog && name === 'score' && !snapshot) r.sbLog.push({ username, prev: u.cur.score, value, fb: r.matchFeedback.length });
  if (snapshot) u.snap[name] = value;
  u.cur[name] = value;
  return true;
}

const readScoreboardKills = (r) => {
  readEntityField(r, 'kills');
  // legacy layout: kills only fed an unused field upstream
};
const readScoreboardDeaths = (r) => {
  readEntityField(r, 'deaths');
};

function readScoreboardAssists(r) {
  if (readEntityField(r, 'assists')) return;
  const assists = r.uint32();
  if (assists === 0) return;
  r.skip(30);
  const id = r.bytes(4);
  const idx = r.playerIndexByID(id);
  if (idx !== -1) {
    const p = sbPlayer(r, idx);
    p.assists = assists;
    p.assistsFromRound++;
  }
}

function readScoreboardScore(r) {
  if (readEntityField(r, 'score')) return;
  const score = r.uint32();
  if (score === 0) return;
  r.skip(13);
  const id = r.bytes(4);
  const idx = r.playerIndexByID(id);
  if (idx !== -1) sbPlayer(r, idx).score = score;
}

/**
 * Scoreboard values of one player for the finished round, or null when the replay has none (legacy
 * layout is read from r.scoreboard.players by the caller).
 * score/scoreStart/kills/deaths are match-cumulative; assists is the round's own count.
 */
function entityStats(r, username) {
  const u = r.sbUsers.get(username);
  if (!u) return null;
  const s = u.snap;
  const c = u.cur;
  const d = (k) => Math.max(0, (c[k] || 0) - (s[k] || 0));
  return {
    score: c.score || 0,
    scoreStart: s.score || 0,
    assists: d('assists'),
    assistsStart: s.assists || 0,
    sbKills: d('kills'),
    sbDeaths: d('deaths'),
  };
}

module.exports = {
  sbPlayer, readScoreboardEntity, readScoreboardKills, readScoreboardDeaths, readScoreboardAssists, readScoreboardScore,
  entityStats, FIELD_KILLS, FIELD_DEATHS,
};
