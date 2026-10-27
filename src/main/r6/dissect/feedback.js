'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/feedback.go.

const { V, T } = require('./tables');

const ACTIVITY2 = [0x00, 0x00, 0x00, 0x22, 0xe3, 0x09, 0x00, 0x79];
const KILL_INDICATOR = [0x22, 0xd9, 0x13, 0x3c, 0xba];

function push(r, u) {
  r.matchFeedback.push(Object.assign({
    type: T.Other, username: '', target: '', headshot: null, time: r.timeRaw, timeInSeconds: r.time,
    message: '', operator: 0,
  }, u));
}

function readMatchFeedback(r) {
  const cv = r.header.codeVersion;
  if (cv >= V.Y9S1Update3) {
    r.skip(38);
  } else if (cv >= V.Y9S1) {
    r.skip(9);
    if (r.int() !== 4) throw new Error('match feedback failed valid check');
    r.skip(24);
  } else {
    r.skip(1);
    r.seek(ACTIVITY2);
  }
  const size = r.int();
  if (size === 0) {
    // kill or an unknown indicator at start of match
    const killTrace = r.bytes(5);
    for (let i = 0; i < 5; i++) if (killTrace[i] !== KILL_INDICATOR[i]) return;
    const username = r.string();
    const empty = username.length === 0;
    r.skip(15); // unknown (kill type?)
    const target = r.string();
    if (empty && target.length > 0) {
      push(r, { type: T.Death, username: target });
      return;
    } else if (empty) {
      return;
    }
    r.skip(56);
    const headshot = r.int() === 1;
    // ignore duplicates
    for (const val of r.matchFeedback) {
      if (val.type === T.Kill && val.username === username && val.target === target) return;
    }
    push(r, { type: T.Kill, username, target, headshot });
    return;
  }
  // Y9S1 may have removed or modified other match feedback options
  if (cv >= V.Y9S1) return;
  const msg = r.bytes(size).toString('utf8');
  let t = T.Other;
  if (msg.includes('bombs') || msg.includes('objective')) t = T.LocateObjective;
  if (msg.includes('BattlEye')) t = T.Battleye;
  if (msg.includes('left')) t = T.PlayerLeave;
  let username = msg.split(' ')[0];
  let message = msg;
  if (t === T.Other) username = '';
  else message = '';
  push(r, { type: t, username, message });
}

module.exports = { readMatchFeedback };
