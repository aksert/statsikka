'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/defuse.go.
//
// Two layouts:
//
//  - legacy (before the entity layout): the packet after the timer carries the id of the acting player
//    (upstream behaviour, kept as is).
//  - entity layout (seen on Y11S3 replays; the format description comes from the fork
//    prestonwillis10/r6-dissect, MIT, dissect/defuse.go, and was re-verified on Y11S3 replays; the
//    implementation below is independent): the timer is a property of the acting player's *pawn*
//    and is preceded by a reference to it:
//
//      23 <pawn (4)> 00000000 E58C06E9 04 <state u32>      (only when the state changes)
//      23 <pawn (4)> 00000000 E9A37FEB 04 <remaining f32, 1 -> 0>
//      22 A9C858D9 <len> <timer string>
//
//    state is 0 when a plant starts, 1 when a disable starts and 2 when the action ends. A pawn is
//    linked to the player's slot entity by `1B <slot (4)> 00000000 27C08DCA <pawn (4)> 00000000`, and the
//    first such link of each slot (null pawn) is followed within ~100 bytes by the player block
//    (22 07 94 9B DC <username>), which gives slot -> username. No ids are written after the timer, so
//    the legacy code attributed every plant/disable to the first roster player.

const { T } = require('./tables');

const PAWN_LINK = [0x27, 0xc0, 0x8d, 0xca];
const PLAYER_BLOCK = Buffer.from([0x22, 0x07, 0x94, 0x9b, 0xdc]);
const PROP_STATE = Buffer.from([0xe5, 0x8c, 0x06, 0xe9]);
const PROP_REMAINING = Buffer.from([0xe9, 0xa3, 0x7f, 0xeb]);
const TIMER_PATTERN_LEN = 5;
const PACKET_LOOKBACK = 64;
const NAME_LOOKAHEAD = 160;
const ST_PLANT = 0;
const ST_DISABLE = 1;
const ST_IDLE = 2;

const hex4 = (b, o) => b.toString('hex', o, o + 4);
const isZero4 = (b, o) => b[o] === 0 && b[o + 1] === 0 && b[o + 2] === 0 && b[o + 3] === 0;

function newRun() {
  return { active: false, plant: true, playerIndex: -1, started: false, value: -1, timeRaw: '', time: 0 };
}

/** `1B <slot> 00000000 27C08DCA <pawn> 00000000`: links a pawn to a player slot (entity layout). */
function readDefuserPawn(r) {
  const b = r.b;
  const start = r.offset - PAWN_LINK.length;
  if (start < 9 || r.offset + 8 > b.length) return;
  if (b[start - 9] !== 0x1b || !isZero4(b, start - 4) || !isZero4(b, r.offset + 4)) return;
  const slot = hex4(b, start - 8);
  const pawn = hex4(b, r.offset);
  if (pawn === '00000000') {
    // first link of the slot: the player block follows
    const j = b.subarray(r.offset + 8, Math.min(b.length, r.offset + 8 + NAME_LOOKAHEAD)).indexOf(PLAYER_BLOCK);
    if (j < 0) return;
    const at = r.offset + 8 + j + PLAYER_BLOCK.length;
    const size = b[at];
    if (size === 0 || at + 1 + size > b.length) return;
    r.defuserSlotUsers.set(slot, b.toString('utf8', at + 1, at + 1 + size));
    return;
  }
  r.defuserPawnToSlot.set(pawn, slot);
}

/** Pawn referenced right before the timer at `patStart`, plus the state field if this packet carries it. */
function packetPawn(b, patStart) {
  const limit = Math.max(0, patStart - PACKET_LOOKBACK);
  for (let p = patStart - 13; p >= limit; p--) {
    if (b[p] !== 0x23 || !isZero4(b, p + 5)) continue;
    const isRemaining = b.compare(PROP_REMAINING, 0, 4, p + 9, p + 13) === 0;
    const isState = !isRemaining && b.compare(PROP_STATE, 0, 4, p + 9, p + 13) === 0;
    if (!isRemaining && !isState) continue;
    let state = -1;
    const q = b.subarray(p, patStart).indexOf(PROP_STATE);
    if (q >= 0 && p + q + 9 <= patStart && b[p + q + 4] === 0x04) state = b.readUInt32LE(p + q + 5);
    return { pawn: hex4(b, p + 1), state };
  }
  return null;
}

function deadSet(r) {
  const dead = new Set();
  for (const u of r.matchFeedback) {
    if (u.type === T.Kill) dead.add(u.target);
    else if (u.type === T.Death) dead.add(u.username);
  }
  return dead;
}

/** When the pawn cannot be resolved: a single living player on the acting side must be the actor. */
function soleAlivePlayer(r, plant) {
  const role = plant ? 'Attack' : 'Defense';
  const dead = deadSet(r);
  let found = -1;
  const ps = r.header.players;
  for (let i = 0; i < ps.length; i++) {
    const t = r.header.teams[ps[i].teamIndex];
    if (!t || t.role !== role || dead.has(ps[i].username) || !ps[i].username) continue;
    if (found >= 0) return -1;
    found = i;
  }
  return found;
}

function pushDefuser(r, type, username) {
  r.matchFeedback.push({
    type, username, target: '', headshot: null, time: r.timeRaw, timeInSeconds: r.time, message: '', operator: 0,
  });
}

function emitStart(r, run) {
  if (run.started || run.playerIndex < 0) return;
  run.started = true;
  pushDefuser(r, run.plant ? T.DefuserPlantStart : T.DefuserDisableStart, r.header.players[run.playerIndex].username);
}

function beginRun(r, playerIndex, state) {
  let plant = !r.planted;
  if (state === ST_PLANT) plant = true;
  else if (state === ST_DISABLE) plant = false;
  if (playerIndex < 0) playerIndex = soleAlivePlayer(r, plant);
  const run = { active: true, plant, playerIndex, started: false, value: -1, timeRaw: r.timeRaw, time: r.time };
  r.defuserRun = run;
  emitStart(r, run);
}

function completeRun(r) {
  const run = r.defuserRun;
  run.active = false;
  let type = T.DefuserPlantComplete;
  if (run.plant) r.planted = true;
  else {
    type = T.DefuserDisableComplete;
    r.planted = false;
  }
  const username = run.playerIndex >= 0 ? r.header.players[run.playerIndex].username : '';
  pushDefuser(r, type, username);
  r.defuserDecoded = (r.defuserDecoded || 0) + (username ? 1 : 0);
}

function readDefuserTimerEntity(r, patStart, timer) {
  if (timer.length === 0) return; // empty timers are sent when pawns spawn
  const value = parseFloat(timer);
  if (Number.isNaN(value)) return;
  const prev = r.lastDefuserTimer;
  r.lastDefuserTimer = value;
  const info = packetPawn(r.b, patStart);
  const state = info ? info.state : -1;
  let playerIndex = -1;
  if (info) {
    const slot = r.defuserPawnToSlot.get(info.pawn);
    const name = slot === undefined ? undefined : r.defuserSlotUsers.get(slot);
    if (name !== undefined) playerIndex = r.playerIndexByUsername(name);
  }
  let run = r.defuserRun;
  // every attempt restarts the countdown (value rises); the first packet of an attempt carries its state
  const fresh = (run.active && value > prev) || (!run.active && (value > prev || state === ST_PLANT || state === ST_DISABLE));
  if (fresh) {
    if (run.active) run.active = false; // earlier attempt was cancelled
    beginRun(r, playerIndex, state);
    run = r.defuserRun;
  }
  if (!run.active) return; // trailing packets of an attempt that already ended
  if (run.playerIndex < 0 && playerIndex >= 0) {
    run.playerIndex = playerIndex;
    emitStart(r, run);
  }
  run.value = value;
  run.timeRaw = r.timeRaw;
  run.time = r.time;
  if (timer.startsWith('0.00')) completeRun(r);
  else if (state === ST_IDLE) run.active = false;
}

/**
 * Called once after the scan. The recording ends when a disable (or the detonation) ends the round, so the
 * last countdown packet can stop a tick short of 0.00 (e.g. 0.017). A disable countdown still running at the end
 * of the data with at most END_COMPLETE_MAX seconds left is completed at the time of its last packet, but only
 * when the actor's team won the round (score): once the bomb is planted only a disable or the detonation ends
 * the round, so the defenders' win can only be the disable. Plants are never inferred: a plant that is still
 * counting down when the round ends (elimination win) was not completed.
 */
const END_COMPLETE_MAX = 0.1;
function finishDefuser(r) {
  const run = r.defuserRun;
  if (!run || !run.active || run.plant || run.playerIndex < 0 || !(run.value >= 0 && run.value <= END_COMPLETE_MAX)) return;
  const p = r.header.players[run.playerIndex];
  const t = r.header.teams[p.teamIndex];
  if (!t || !(t.score > t.startingScore)) return;
  r.timeRaw = run.timeRaw;
  r.time = run.time;
  completeRun(r);
  r.matchFeedback[r.matchFeedback.length - 1].inferred = true;
}

function readDefuserTimerLegacy(r, timer) {
  r.skip(34);
  const id = r.bytes(4);
  const i = r.playerIndexByID(id);
  let a = r.planted ? T.DefuserDisableStart : T.DefuserPlantStart;
  const players = r.header.players;
  if (i > -1) {
    r.matchFeedback.push({
      type: a, username: players[i].username, target: '', headshot: null, time: r.timeRaw,
      timeInSeconds: r.time, message: '', operator: 0,
    });
    r.lastDefuserPlayerIndex = i;
  }
  // 0.00 can be present even if defuser was not disabled (upstream TODO)
  if (!timer.startsWith('0.00')) return;
  a = T.DefuserDisableComplete;
  if (!r.planted) {
    a = T.DefuserPlantComplete;
    r.planted = true;
  }
  const lp = players[r.lastDefuserPlayerIndex];
  r.matchFeedback.push({
    type: a, username: lp ? lp.username : '', target: '', headshot: null, time: r.timeRaw,
    timeInSeconds: r.time, message: '', operator: 0,
  });
}

function readDefuserTimer(r) {
  const patStart = r.offset - TIMER_PATTERN_LEN;
  const timer = r.string();
  // entity layout: slot -> username links have been seen (every such replay writes them at round start)
  if (r.defuserSlotUsers.size > 0) return readDefuserTimerEntity(r, patStart, timer);
  return readDefuserTimerLegacy(r, timer);
}

module.exports = { readDefuserTimer, readDefuserPawn, finishDefuser, PAWN_LINK, newRun };
