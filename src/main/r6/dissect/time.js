'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/time.go (round clock + roundEnd win detection).

const { V, T } = require('./tables');

const pad2 = (n) => String(n).padStart(2, '0');

/** Formats a clock value in seconds as "m:ss". */
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** Parses "m:ss" (or plain seconds, Y7 style) to seconds; returns NaN on bad input. */
function parseClock(str) {
  const parts = String(str).split(':');
  if (parts.length === 1) return parseFloat(parts[0]);
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  return m * 60 + s;
}

function readTime(r) {
  const t = r.uint32();
  r.time = t;
  r.timeRaw = formatClock(t);
}

function readY7Time(r) {
  const str = r.string();
  const parts = str.split(':');
  if (parts.length === 1) {
    const sec = parseFloat(parts[0]);
    if (Number.isNaN(sec)) throw new Error(`bad Y7 time "${str}"`);
    r.time = sec;
    r.timeRaw = parts[0];
    return;
  }
  const minutes = parseInt(parts[0], 10);
  const seconds = parseInt(parts[1], 10);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) throw new Error(`bad Y7 time "${str}"`);
  r.time = minutes * 60 + seconds;
  r.timeRaw = str;
}

function roundEnd(r) {
  const h = r.header;
  let planter = -1;
  const deaths = { 0: 0, 1: 0 };
  const sizes = { 0: 0, 1: 0 };
  const roles = {};
  for (const p of h.players) {
    sizes[p.teamIndex] = (sizes[p.teamIndex] || 0) + 1;
    roles[p.teamIndex] = h.teams[p.teamIndex].role;
  }
  if (h.codeVersion >= V.Y9S4) {
    const team0Won = h.teams[0].startingScore < h.teams[0].score;
    h.teams[0].won = team0Won;
    h.teams[1].won = !team0Won;
  }
  const teamOf = (name) => {
    const i = r.playerIndexByUsername(name);
    return i < 0 ? -1 : h.players[i].teamIndex;
  };
  for (const u of r.matchFeedback) {
    if (u.type === T.Kill) {
      const t = teamOf(u.target);
      if (t >= 0) deaths[t] = (deaths[t] || 0) + 1;
    } else if (u.type === T.Death) {
      const t = teamOf(u.username);
      if (t >= 0) deaths[t] = (deaths[t] || 0) + 1;
    } else if (u.type === T.DefuserPlantComplete) {
      planter = r.playerIndexByUsername(u.username);
    } else if (u.type === T.DefuserDisableComplete) {
      const t = teamOf(u.username);
      if (t >= 0) {
        h.teams[t].won = true;
        h.teams[t].winCondition = 'DisabledDefuser';
        return;
      }
    }
  }
  if (planter > -1) {
    const t = h.players[planter].teamIndex;
    h.teams[t].won = true;
    h.teams[t].winCondition = 'DefusedBomb';
    return;
  }
  // Y9S4+: header tells who won (StartingScore); win condition not derived upstream
  if (h.codeVersion >= V.Y9S4) return;
  if (deaths[0] === sizes[0]) {
    h.teams[1].won = true;
    h.teams[1].winCondition = 'KilledOpponents';
    return;
  }
  if (deaths[1] === sizes[1]) {
    h.teams[0].won = true;
    h.teams[0].winCondition = 'KilledOpponents';
    return;
  }
  const i = roles[1] === 'Defense' ? 1 : 0;
  h.teams[i].won = true;
  h.teams[i].winCondition = 'Time';
}

module.exports = { formatClock, parseClock, readTime, readY7Time, roundEnd };
