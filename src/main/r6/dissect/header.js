'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/header.go.

const { V } = require('./tables');

class HeaderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HeaderError';
    this.code = 'HEADER';
  }
}

/** Skips the "dissect" magic and the unknown versioning scheme up to the second run of 7 zero bytes. */
function readHeaderMagic(r) {
  const b = r.bytes(7);
  if (b.toString('latin1') !== 'dissect') throw new HeaderError('dissect: not a dissect file');
  let n = 0;
  let t = 0;
  while (t !== 2) {
    const c = r.int();
    if (c === 0x00) {
      if (n !== 6) n++;
      else {
        n = 0;
        t++;
      }
    } else if (n > 0) {
      n = 0;
    }
  }
}

function readHeaderString(r) {
  const len = r.int();
  const sep = r.bytes(7);
  for (let i = 0; i < 7; i++) if (sep[i] !== 0) throw new HeaderError('dissect: invalid string separator');
  return r.bytes(len).toString('utf8');
}

function newPlayer() {
  return {
    id: '0', profileID: '', username: '', teamIndex: 0, operator: 0, startOperator: 0, heroName: 0, alliance: 0,
    roleImage: 0, roleName: '', rolePortrait: 0, spawn: '', dissectID: null, uiID: '0',
  };
}

function intOf(v, key, warnings, required) {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  if (required) throw new HeaderError(`header: invalid ${key}: "${v}"`);
  warnings.push(`header: invalid or missing ${key}`);
  return 0;
}

function parseTimestamp(s) {
  // Go layout "2006-01-02-15-04-05" (no zone -> UTC)
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) throw new HeaderError(`header: invalid datetime "${s}"`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function readHeader(r) {
  const props = new Map();
  const gmSettings = [];
  const players = [];
  const warnings = r.errors;
  let currentPlayer = newPlayer();
  let playerData = false;
  let last = false;
  while (!last) {
    const k = readHeaderString(r);
    const v = readHeaderString(r);
    if (k === 'playerid') {
      if (playerData) players.push(currentPlayer);
      playerData = true;
      currentPlayer = newPlayer();
    }
    if ((k === 'playlistcategory' || k === 'id') && playerData) {
      players.push(currentPlayer);
      playerData = false;
    }
    if (!playerData) {
      if (k !== 'gmsetting') props.set(k, v);
      else gmSettings.push(intOf(v, 'gmsetting', warnings, false));
    } else {
      switch (k) {
        case 'playerid':
          currentPlayer.id = /^\d+$/.test(v) ? v : '0';
          break;
        case 'playername':
          currentPlayer.username = v;
          break;
        case 'team':
          currentPlayer.teamIndex = intOf(v, 'team', warnings, false);
          break;
        case 'heroname':
          currentPlayer.heroName = intOf(v, 'heroname', warnings, false);
          break;
        case 'alliance':
          currentPlayer.alliance = intOf(v, 'alliance', warnings, false);
          break;
        case 'roleimage':
          currentPlayer.roleImage = intOf(v, 'roleimage', warnings, false);
          break;
        case 'rolename':
          currentPlayer.roleName = v;
          break;
        case 'roleportrait':
          currentPlayer.rolePortrait = intOf(v, 'roleportrait', warnings, false);
          break;
        default:
          props.set(k, v);
      }
    }
    last = props.has('teamscore1');
  }
  const p = (k) => props.get(k);
  const codeVersion = intOf(p('code'), 'code', warnings, true);
  const h = {
    gameVersion: p('version') || '',
    codeVersion,
    timestamp: parseTimestamp(p('datetime')),
    matchType: intOf(p('matchtype'), 'matchtype', warnings, false),
    map: intOf(p('worldid'), 'worldid', warnings, false),
    site: '',
    recordingPlayerID: /^\d+$/.test(p('recordingplayerid') || '') ? p('recordingplayerid') : '0',
    recordingProfileID: p('recordingprofileid') || '',
    additionalTags: p('additionaltags') || '',
    gameMode: intOf(p('gamemodeid'), 'gamemodeid', warnings, false),
    roundsPerMatch: intOf(p('roundspermatch'), 'roundspermatch', warnings, false),
    roundsPerMatchOvertime: intOf(p('roundspermatchovertime'), 'roundspermatchovertime', warnings, false),
    roundNumber: intOf(p('roundnumber'), 'roundnumber', warnings, false),
    overtimeRoundNumber: intOf(p('overtimeroundnumber'), 'overtimeroundnumber', warnings, false),
    teams: [
      { name: p('teamname0') || '', startingScore: 0, score: 0, won: false, winCondition: '', role: '' },
      { name: p('teamname1') || '', startingScore: 0, score: 0, won: false, winCondition: '', role: '' },
    ],
    players,
    gmSettings,
    playlistCategory: 0,
    matchID: p('id') || '',
  };
  if ((p('playlistcategory') || '').length > 0) {
    h.playlistCategory = /^-?\d+$/.test(p('playlistcategory')) ? Number(p('playlistcategory')) : 0;
  }
  h.teams[0].score = intOf(p('teamscore0'), 'teamscore0', warnings, false);
  h.teams[1].score = intOf(p('teamscore1'), 'teamscore1', warnings, false);
  if (codeVersion >= V.Y9S4) {
    h.teams[0].startingScore = intOf(p('startingteamscore0'), 'startingteamscore0', warnings, false);
    h.teams[1].startingScore = intOf(p('startingteamscore1'), 'startingteamscore1', warnings, false);
  }
  return h;
}

module.exports = { HeaderError, readHeaderMagic, readHeaderString, readHeader, newPlayer };
