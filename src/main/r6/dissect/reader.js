'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/reader.go, dissect/utils.go, dissect/error.go.
//
// Differences from upstream: single-threaded scan (same byte-state-machine semantics, but
// no worker block boundaries), listener errors are collected in `errors` instead of
// aborting the whole read, and unknown operators/maps never panic.

const { V } = require('./tables');
const { decompressFrames, decompressWhole } = require('./zstd');
const { readHeaderMagic, readHeader } = require('./header');
const { readPlayer, readAtkOpSwap, deriveTeamRoles } = require('./player');
const { readMatchFeedback } = require('./feedback');
const { readScoreboardEntity, readScoreboardKills, readScoreboardDeaths, readScoreboardScore, readScoreboardAssists } = require('./scoreboard');
const { readDefuserTimer, readDefuserPawn, finishDefuser, PAWN_LINK, newRun } = require('./defuse');
const { readSpawn } = require('./site');
const { readTime, readY7Time, roundEnd } = require('./time');

class DissectError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DissectError';
    this.code = code || 'DISSECT';
  }
}

const EOF = () => new DissectError('EOF', 'EOF');

const MAGIC_DISS = [0x64, 0x69, 0x73, 0x73];
const MAGIC_ZSTD = [0x28, 0xb5, 0x2f, 0xfd];

const PAT = {
  player: [0x22, 0x07, 0x94, 0x9b, 0xdc],
  atkOpSwap: [0x22, 0xa9, 0x26, 0x0b, 0xe4],
  spawn: [0xaf, 0x98, 0x99, 0xca],
  time: [0x1f, 0x07, 0xef, 0xc9],
  y7Time: [0x1e, 0xf1, 0x11, 0xab],
  feedback: [0x59, 0x34, 0xe5, 0x8b, 0x04],
  defuser: [0x22, 0xa9, 0xc8, 0x58, 0xd9],
  score: [0xec, 0xda, 0x4f, 0x80],
  assists: [0x4d, 0x73, 0x7f, 0x9e],
  // Y11S3 scoreboard: entity link + kills/deaths fields (see scoreboard.js)
  sbEntity: [0xeb, 0x21, 0x9b, 0x38],
  sbKills: [0x1c, 0xd2, 0xb1, 0x9d],
  sbDeaths: [0xcd, 0x9c, 0x5d, 0x72],
  // Y11S3 defuser: pawn -> player slot link (see defuse.js)
  pawnLink: PAWN_LINK,
};

class Reader {
  /**
   * @param {Buffer} buf raw contents of a .rec file
   * @param {{header?: object, only?: string[]}} [opts] test hook: with `header`, `buf` is taken as the already
   *   decompressed data and `only` restricts which listeners (keys of PAT) are registered
   */
  constructor(buf, opts = {}) {
    this.b = buf;
    this.offset = 0;
    this.queries = [];
    this.listeners = [];
    this.time = 0; // seconds (round clock)
    this.timeRaw = '';
    this.lastDefuserPlayerIndex = 0;
    this.planted = false;
    this.defuserPawnToSlot = new Map(); // defuser pawn (hex) -> player slot (hex), Y11S3 layout
    this.defuserSlotUsers = new Map(); // player slot (hex) -> username
    this.defuserRun = newRun();
    this.lastDefuserTimer = -1;
    this.playersRead = 0;
    this.rolesDerived = false;
    this.header = null;
    this.matchFeedback = [];
    this.scoreboard = { players: [] };
    this.sbLinks = new Map(); // scoreboard entity id (u32) -> username (Y11S3 layout)
    this.sbUsers = new Map(); // username -> {snap, cur} scoreboard values (Y11S3 layout)
    this.playerObjects = new Map(); // player object handle (hex) -> username (operator swaps, Y11S3)
    this.errors = [];
    this.sbLog = opts.scoreLog ? [] : null; // opt-in diagnostics, see scoreboard.js
    if (opts.header) {
      this.header = opts.header;
      this.registerListeners(opts.only);
    } else {
      this.init();
    }
  }

  init() {
    const buf = this.b;
    if (buf.length < 4) throw new DissectError('not a dissect file (too short)', 'INVALID_FILE');
    const isDiss = MAGIC_DISS.every((x, i) => buf[i] === x);
    const isZstd = MAGIC_ZSTD.every((x, i) => buf[i] === x);
    if (isDiss) {
      // chunked compression (>= Y8S4): plain header, then zstd frames
      readHeaderMagic(this);
      this.header = readHeader(this);
      this.b = decompressFrames(buf, this.offset, this.errors);
      this.offset = 0;
    } else if (isZstd) {
      this.b = decompressWhole(buf, this.errors);
      this.offset = 0;
      readHeaderMagic(this);
      this.header = readHeader(this);
    } else {
      throw new DissectError('dissect: not a dissect file', 'INVALID_FILE');
    }
    this.registerListeners();
  }

  /** Registers the pattern listeners (all of them, or only the PAT keys in `only`). */
  registerListeners(only) {
    const cv = this.header.codeVersion;
    const on = (key, fn) => {
      if (!only || only.includes(key)) this.listen(PAT[key], fn);
    };
    on('player', readPlayer);
    on('atkOpSwap', readAtkOpSwap);
    on('spawn', readSpawn);
    if (cv >= V.Y8S1) on('time', readTime);
    else on('y7Time', readY7Time);
    on('feedback', readMatchFeedback);
    on('defuser', readDefuserTimer);
    on('pawnLink', readDefuserPawn);
    on('score', readScoreboardScore);
    on('assists', readScoreboardAssists);
    on('sbEntity', readScoreboardEntity);
    on('sbKills', readScoreboardKills);
    on('sbDeaths', readScoreboardDeaths);
  }

  listen(pattern, fn) {
    this.queries.push(pattern);
    this.listeners.push(fn);
  }

  /**
   * Scans the decompressed data for all registered patterns (upstream semantics: a partial
   * match that fails is reset to 0 and the failing byte is NOT re-tested as a start byte),
   * then calls listeners in file order.
   */
  read() {
    const b = this.b;
    const nq = this.queries.length;
    const qs = this.queries;
    const idx = new Int32Array(nq);
    const first = new Int32Array(nq);
    for (let j = 0; j < nq; j++) first[j] = qs[j][0];
    // byte -> pattern indexes starting with that byte
    const startTable = new Array(256);
    for (let j = 0; j < nq; j++) (startTable[first[j]] || (startTable[first[j]] = [])).push(j);
    const isStart = new Uint8Array(256);
    for (let j = 0; j < nq; j++) isStart[first[j]] = 1;
    const active = [];
    const matchPos = [];
    const matchQ = [];
    const end = b.length - 1; // upstream scans [start, len-1)
    for (let i = this.offset; i < end; i++) {
      if (active.length === 0) {
        while (i < end && isStart[b[i]] === 0) i++; // fast path: nothing in progress
        if (i >= end) break;
      }
      const c = b[i];
      // idle patterns whose first byte is c start matching on this byte
      const st = startTable[c];
      let start = null;
      if (st !== undefined) {
        for (let s = 0; s < st.length; s++) if (idx[st[s]] === 0) (start || (start = [])).push(st[s]);
      }
      for (let k = active.length - 1; k >= 0; k--) {
        const j = active[k];
        const q = qs[j];
        if (c === q[idx[j]]) {
          idx[j]++;
          if (idx[j] === q.length) {
            idx[j] = 0;
            matchPos.push(i);
            matchQ.push(j);
            active.splice(k, 1);
          }
        } else {
          idx[j] = 0;
          active.splice(k, 1);
        }
      }
      if (start !== null) {
        for (let s = 0; s < start.length; s++) {
          idx[start[s]] = 1;
          active.push(start[s]);
        }
      }
    }
    // order by position, stable (matches were generated in position order already)
    for (let m = 0; m < matchPos.length; m++) {
      const fn = this.listeners[matchQ[m]];
      this.offset = matchPos[m] + 1;
      try {
        fn(this);
      } catch (e) {
        this.errors.push(`${fn.name} @${matchPos[m]}: ${e.message}`);
      }
    }
    try {
      if (!this.rolesDerived) deriveTeamRoles(this);
      finishDefuser(this);
      roundEnd(this);
    } catch (e) {
      this.errors.push(`roundEnd: ${e.message}`);
    }
    this.b = null;
  }

  // ---- low level reading (reader.go) ----

  skip(n) {
    this.offset += n;
    if (this.offset >= this.b.length) throw EOF();
  }

  bytes(n) {
    this.skip(n);
    return this.b.subarray(this.offset - n, this.offset);
  }

  int() {
    this.skip(1);
    return this.b[this.offset - 1];
  }

  string() {
    const size = this.int();
    return this.bytes(size).toString('utf8');
  }

  uint32() {
    this.skip(1);
    this.skip(4);
    return this.b.readUInt32LE(this.offset - 4);
  }

  /** uint64 as Number (exact below 2^53, which covers operator/map/hero ids). */
  uint64() {
    this.skip(1);
    this.skip(8);
    const o = this.offset - 8;
    return this.b.readUInt32LE(o) + this.b.readUInt32LE(o + 4) * 4294967296;
  }

  /** uint64 as decimal string (exact). */
  uint64Str() {
    this.skip(1);
    this.skip(8);
    return this.b.readBigUInt64LE(this.offset - 8).toString();
  }

  /** Skips until pattern is found (upstream quirk kept: no restart of partial matches). */
  seek(pattern) {
    const b = this.b;
    const len = b.length;
    const pl = pattern.length;
    let i = 0;
    let off = this.offset;
    for (;;) {
      off += 1;
      if (off >= len) {
        this.offset = off;
        throw EOF();
      }
      if (b[off - 1] !== pattern[i]) {
        i = 0;
        continue;
      }
      i++;
      if (i === pl) {
        this.offset = off;
        return;
      }
    }
  }

  playerIndexByID(id) {
    const ps = this.header.players;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].dissectID && ps[i].dissectID.equals(id)) return i;
    }
    return -1;
  }

  playerIndexByUsername(username) {
    const ps = this.header.players;
    for (let i = 0; i < ps.length; i++) if (ps[i].username === username) return i;
    return -1;
  }
}

module.exports = { Reader, DissectError, EOF, PAT };
