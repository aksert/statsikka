'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/stats.go, dissect/match.go (Data / PlayerStats), JSON shapes from header.go.

const { entityStats } = require('./scoreboard');
const { T, operatorName, operatorRole, mapName, matchTypeName, gameModeName, matchUpdateTypeName } = require('./tables');

function headshotPercentage(headshots, kills) {
  if (kills === 0) return 0;
  return (headshots / kills) * 100;
}

/** Per-player round stats (Reader.PlayerStats upstream). `r` is a finished Reader. */
function playerStats(r) {
  const h = r.header;
  const stats = [];
  const index = new Map();
  const winningTeamIndex = h.teams[1].won ? 1 : 0;
  h.players.forEach((p, i) => {
    const sp = r.scoreboard.players[i] || { score: 0, assistsFromRound: 0 };
    // Y11S3 layout: values come from the per-username scoreboard entities, see scoreboard.js
    const es = entityStats(r, p.username);
    const st = {
      username: p.username, teamIndex: p.teamIndex, operator: p.operator, score: es ? es.score : sp.score, kills: 0,
      died: false, assists: es ? es.assists : sp.assistsFromRound, headshots: 0, headshotPercentage: 0, oneVx: 0,
      sb: es,
    };
    stats.push(st);
    index.set(p.username, i);
  });
  let lastDeath = -1;
  for (const a of r.matchFeedback) {
    const i = index.get(a.username);
    if (a.type === T.Kill) {
      if (i !== undefined) {
        stats[i].kills += 1;
        if (a.headshot) stats[i].headshots += 1;
        stats[i].headshotPercentage = headshotPercentage(stats[i].headshots, stats[i].kills);
      }
      const ti = index.get(a.target);
      if (ti !== undefined) {
        stats[ti].died = true;
        lastDeath = ti;
      }
    } else if (a.type === T.Death && i !== undefined) {
      stats[i].died = true;
      lastDeath = i;
    }
  }
  // 1vX
  const winnersLeftAlive = [];
  let lastDeathWasWinner = false;
  h.players.forEach((p, i) => {
    if (p.teamIndex !== winningTeamIndex) return;
    if (!stats[i].died) winnersLeftAlive.push(i);
    if (i === lastDeath) lastDeathWasWinner = true;
  });
  let lastWinnerStanding = -1;
  if (winnersLeftAlive.length === 1) lastWinnerStanding = winnersLeftAlive[0];
  else if (winnersLeftAlive.length === 0 && lastDeathWasWinner) lastWinnerStanding = lastDeath;
  if (lastWinnerStanding > -1) {
    const username = stats[lastWinnerStanding].username;
    let teamLeft = h.players.filter((p) => p.teamIndex === winningTeamIndex).length;
    let oneVx = 0;
    const teamOfName = (n) => (index.has(n) ? stats[index.get(n)].teamIndex : -1);
    for (const a of r.matchFeedback) {
      if (a.type === T.Kill && teamOfName(a.target) === winningTeamIndex) teamLeft--;
      else if (a.type === T.Death && teamOfName(a.username) === winningTeamIndex) teamLeft--;
      else if (a.type === T.PlayerLeave && teamOfName(a.username) === winningTeamIndex) teamLeft--;
      if (a.username !== username) continue;
      if (a.type === T.Kill && teamLeft < 2) oneVx++;
    }
    for (const s of stats) if (s.teamIndex !== winningTeamIndex && !s.died) oneVx++;
    stats[lastWinnerStanding].oneVx = oneVx;
  }
  return stats;
}

/** Aggregates round stats lists into per-match player stats (MatchReader.PlayerStats upstream). */
function matchPlayerStats(roundStatsList) {
  const stats = [];
  const index = new Map();
  for (const roundStats of roundStatsList) {
    for (const p of roundStats) {
      let i = index.get(p.username);
      if (i === undefined) {
        i = stats.length;
        index.set(p.username, i);
        stats.push({
          username: p.username, teamIndex: p.teamIndex, rounds: 0, kills: 0, deaths: 0, assists: 0,
          headshots: 0, headshotPercentage: 0,
        });
      }
      const s = stats[i];
      s.rounds += 1;
      s.kills += p.kills;
      if (p.died) s.deaths += 1;
      s.assists += p.assists;
      s.headshots += p.headshots;
      s.headshotPercentage = headshotPercentage(s.headshots, s.kills);
    }
  }
  return stats;
}

// ---- JSON (upstream shape) ----

const namedId = (name, id) => ({ name, id });

function teamRoleOfPlayer(h, p) {
  return h.teams[p.teamIndex] ? h.teams[p.teamIndex].role : '';
}

function playerJSON(h, p) {
  const roleOf = operatorRole(p.operator);
  const o = {};
  if (p.id !== '0') o.id = p.id;
  if (p.profileID) o.profileID = p.profileID;
  o.username = p.username;
  o.teamIndex = p.teamIndex;
  o.operator = namedId(operatorName(p.operator), p.operator);
  o.operator.role = roleOf !== 'Unknown' ? roleOf : (teamRoleOfPlayer(h, p) || 'Unknown');
  if (p.startOperator && p.startOperator !== p.operator) o.startOperator = namedId(operatorName(p.startOperator), p.startOperator);
  if (p.heroName) o.heroName = p.heroName;
  o.alliance = p.alliance;
  if (p.roleImage) o.roleImage = p.roleImage;
  if (p.roleName) o.roleName = p.roleName;
  if (p.rolePortrait) o.rolePortrait = p.rolePortrait;
  if (p.spawn) o.spawn = p.spawn;
  return o;
}

function feedbackJSON(u) {
  const o = { type: namedId(matchUpdateTypeName(u.type), u.type) };
  if (u.username) o.username = u.username;
  if (u.target) o.target = u.target;
  if (u.headshot !== null && u.headshot !== undefined) o.headshot = u.headshot;
  o.time = u.time;
  o.timeInSeconds = u.timeInSeconds;
  if (u.message) o.message = u.message;
  if (u.operator) o.operator = namedId(operatorName(u.operator), u.operator);
  return o;
}

function statsJSON(s) {
  const o = {
    username: s.username, score: s.score, kills: s.kills, died: s.died, assists: s.assists,
    headshots: s.headshots, headshotPercentage: s.headshotPercentage,
  };
  if (s.oneVx) o['1vX'] = s.oneVx;
  // non-upstream extras (upstream marks these json:"-")
  o.teamIndex = s.teamIndex;
  o.operator = operatorName(s.operator);
  if (s.sb) {
    // Y11S3 scoreboard: `score` is match-cumulative (as shown on the scoreboard), `roundScore` the round's share.
    o.roundScore = Math.max(0, s.sb.score - s.sb.scoreStart);
    o.scoreStart = s.sb.scoreStart;
    o.assistsStart = s.sb.assistsStart;
    o.sbKills = s.sb.sbKills;
    o.sbDeaths = s.sb.sbDeaths;
  }
  return o;
}

/** Full round JSON (header + matchFeedback + stats), same field names as `r6-dissect -o`. */
function roundToJSON(r) {
  const h = r.header;
  const o = {
    gameVersion: h.gameVersion,
    codeVersion: h.codeVersion,
    timestamp: h.timestamp.toISOString().replace('.000Z', 'Z'),
    matchType: namedId(matchTypeName(h.matchType), h.matchType),
    map: namedId(mapName(h.map), h.map),
  };
  if (h.site) o.site = h.site;
  o.recordingPlayerID = h.recordingPlayerID;
  if (h.recordingProfileID) o.recordingProfileID = h.recordingProfileID;
  o.additionalTags = h.additionalTags;
  o.gamemode = namedId(gameModeName(h.gameMode), h.gameMode);
  o.roundsPerMatch = h.roundsPerMatch;
  o.roundsPerMatchOvertime = h.roundsPerMatchOvertime;
  o.roundNumber = h.roundNumber;
  o.overtimeRoundNumber = h.overtimeRoundNumber;
  o.teams = h.teams.map((t) => {
    const x = { name: t.name, startingScore: t.startingScore, score: t.score, won: t.won };
    if (t.winCondition) x.winCondition = t.winCondition;
    if (t.role) x.role = t.role;
    return x;
  });
  o.players = h.players.map((p) => playerJSON(h, p));
  o.gmSettings = h.gmSettings;
  if (h.playlistCategory) o.playlistCategory = h.playlistCategory;
  o.matchID = h.matchID;
  o.matchFeedback = r.matchFeedback.map(feedbackJSON);
  o.stats = playerStats(r).map(statsJSON);
  return o;
}

module.exports = { headshotPercentage, playerStats, matchPlayerStats, roundToJSON };
