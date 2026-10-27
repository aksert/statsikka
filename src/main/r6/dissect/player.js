'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/player.go and Header.deriveTeamRoles from dissect/header.go.

const { V, T, RECRUIT, operatorRole } = require('./tables');
const { newPlayer } = require('./header');

const SEEK_UNKNOWN = [0x40, 0xf2, 0x15, 0x04];
const SEEK_UIID = [0x38, 0xdf, 0xee, 0x88];
const SPAWN_INDICATOR = [0xaf, 0x98, 0x99, 0xca];
const PROFILE_ID_INDICATOR = [0x8a, 0x50, 0x9b, 0xd0];
const ATK_SWAP_INDICATOR = [0x22, 0xa9, 0x26, 0x0b, 0xe4];

function readPlayer(r) {
  r.playersRead++;
  try {
    readPlayerBody(r);
  } finally {
    if (r.playersRead === 10) deriveTeamRoles(r);
  }
}

function readPlayerBody(r) {
  const h = r.header;
  const cv = h.codeVersion;
  const idIndicator = cv <= V.Y7S2 ? [0xe6, 0xf9, 0x7d, 0x86] : [0x33, 0xd8, 0x3d, 0x4f, 0x23];
  const username = r.string();
  if (cv >= V.Y7S4) {
    r.seek(SEEK_UNKNOWN);
    r.skip(8);
    const swap = r.bytes(1);
    // Sometimes 40 F2 15 04 is sent twice; not linked to role swap.
    if (swap[0] === 0x9d) return;
  } else {
    r.seek(ATK_SWAP_INDICATOR);
  }
  const op = r.uint64(); // op before atk role swaps
  if (op === 0) return; // empty player slot
  const validPlayer = r.bytes(1);
  if (validPlayer[0] !== 0x22) return; // strange invalid player
  r.seek(idIndicator);
  const id = Buffer.from(r.bytes(4));
  r.seek(SPAWN_INDICATOR);
  const spawn = r.string();
  if (spawn === '') {
    r.skip(10);
    const valid = r.bytes(1);
    if (valid[0] !== 0x1b) return;
  }
  const teamIndex = r.playersRead > 5 ? 1 : 0;
  let uiID = '0';
  if (cv >= V.Y9S3) {
    r.seek(SEEK_UIID);
    r.skip(13);
    uiID = r.uint64Str();
  }
  let profileID = '';
  let unknownId = '0';
  if (h.recordingProfileID.length > 0) {
    r.seek(PROFILE_ID_INDICATOR);
    profileID = r.string();
    r.skip(5); // 22eed445c8
    unknownId = r.uint64Str();
  }
  const p = newPlayer();
  p.id = unknownId;
  p.profileID = profileID;
  p.username = username;
  p.teamIndex = teamIndex;
  p.operator = op;
  p.spawn = spawn;
  p.dissectID = id;
  p.uiID = uiID;
  if (p.operator !== RECRUIT && operatorRole(p.operator) === 'Defense') p.spawn = h.site; // cannot detect defense spawn here
  let found = false;
  for (let i = 0; i < h.players.length; i++) {
    const e = h.players[i];
    if (
      e.username === p.username ||
      (cv < V.Y8S2 && e.id === p.id && p.id !== '0') ||
      (cv >= V.Y8S2 && e.dissectID !== null && e.dissectID.equals(p.dissectID)) ||
      (cv <= V.Y7S2 && p.username.startsWith(e.username))
    ) {
      e.profileID = p.profileID;
      e.username = p.username;
      e.operator = p.operator;
      e.spawn = p.spawn;
      e.dissectID = p.dissectID;
      e.uiID = p.uiID;
      found = true;
      break;
    }
  }
  if (!found && username.length > 0) h.players.push(p);
}

function pushSwap(r, username, op) {
  r.matchFeedback.push({
    type: T.OperatorSwap, username, target: '', headshot: null, time: r.timeRaw, timeInSeconds: r.time,
    message: '', operator: op,
  });
}

/** Sets a new operator on player `i`, remembering the round-start operator, and records the swap. */
function applySwap(r, i, op) {
  const p = r.header.players[i];
  if (op === 0 || op === p.operator) return false;
  if (!p.startOperator) p.startOperator = p.operator;
  p.operator = op;
  pushSwap(r, p.username, op);
  return true;
}

// Y11S3: an operator change is a property of the player object:
//   23 <player object (8)> F93911F2 08 <u64> 22 A9260BE4 08 <operator (8)>
// (the player blocks at round start use the same operator field without this prefix).
const SWAP_PREFIX_LEN = 1 + 8 + 4 + 1 + 8;
const SWAP_FIELD = [0xf9, 0x39, 0x11, 0xf2, 0x08];

/** Hex id of the player object an operator field starting at `patStart` belongs to, or null. */
function swapPlayerObject(r, patStart) {
  const b = r.b;
  const s = patStart - SWAP_PREFIX_LEN;
  if (s < 0 || b[s] !== 0x23) return null;
  for (let i = 0; i < SWAP_FIELD.length; i++) if (b[s + 9 + i] !== SWAP_FIELD[i]) return null;
  return b.toString('hex', s + 1, s + 9);
}

function readAtkOpSwap(r) {
  const patStart = r.offset - ATK_SWAP_INDICATOR.length;
  const obj = swapPlayerObject(r, patStart);
  const op = r.uint64();
  const h = r.header;
  if (obj !== null) {
    const name = r.playerObjects.get(obj);
    if (name === undefined) return;
    const i = r.playerIndexByUsername(name);
    if (i > -1) applySwap(r, i, op);
    return;
  }
  if (h.codeVersion < V.Y9S3) {
    // before Y9S3 caster view overhaul
    r.skip(5);
    const id = r.bytes(4);
    const i = r.playerIndexByID(id);
    if (i > -1) {
      if (!h.players[i].startOperator) h.players[i].startOperator = h.players[i].operator;
      h.players[i].operator = op;
      pushSwap(r, h.players[i].username, op);
    }
    return;
  }
  // Y9S3 caster view overhaul (before the Y11S3 layout above; that layout has no uiID match here)
  if (r.sbLinks.size > 0) return;
  r.skip(402);
  const id = r.uint64Str(); // shows up in player data and in op swaps
  for (let i = 0; i < h.players.length; i++) {
    const p = h.players[i];
    if (p.uiID === id) {
      if (!p.startOperator) p.startOperator = p.operator;
      p.operator = op;
      pushSwap(r, p.username, op);
      break;
    }
  }
}

/**
 * Removes players without operator and derives which team attacks/defends.
 * Unknown operator ids (new operators) are skipped when picking the reference player
 * instead of panicking.
 */
function deriveTeamRoles(r) {
  r.rolesDerived = true;
  const h = r.header;
  const players = [];
  r.scoreboard.players = [];
  for (const p of h.players) {
    if (p.operator !== 0) {
      players.push(p);
      r.scoreboard.players.push({ id: p.dissectID, score: 0, assists: 0, assistsFromRound: 0 });
    }
  }
  h.players = players;
  for (const p of players) {
    if (p.operator === RECRUIT) continue;
    const role = operatorRole(p.operator);
    if (role === 'Unknown') continue;
    const opp = p.teamIndex ^ 1;
    if (role === 'Attack') {
      h.teams[p.teamIndex].role = 'Attack';
      h.teams[opp].role = 'Defense';
    } else {
      h.teams[p.teamIndex].role = 'Defense';
      h.teams[opp].role = 'Attack';
    }
    break;
  }
}

module.exports = { readPlayer, readAtkOpSwap, deriveTeamRoles };
