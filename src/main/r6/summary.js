'use strict';
// Match aggregation + summary helpers for the Statsikka R6 replay reader.
// Built on the JS port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan); stats semantics follow dissect/match.go + dissect/stats.go.

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Headshot percentage 0..100 (one decimal); 0 when there are no kills. */
function hsPercent(headshots, kills) {
  return kills > 0 ? round1((headshots / kills) * 100) : 0;
}

/** K/D ratio (two decimals); with zero deaths the ratio is the kill count. */
function kd(kills, deaths) {
  return deaths > 0 ? round2(kills / deaths) : kills;
}

/** Kills per round (two decimals). */
function kpr(kills, rounds) {
  return rounds > 0 ? round2(kills / rounds) : 0;
}

/**
 * Per-player aggregation over parsed rounds (round JSON from parseRound).
 * Keyed by username like upstream; profileID is attached when known.
 * Returns an array in first-seen order with upstream field names
 * (username, rounds, kills, deaths, assists, headshots, headshotPercentage) plus extras.
 *
 * Scoreboard values (Y11S3): the scoreboard is match-cumulative, so `score` sums the per-round shares
 * (stat.roundScore). A round file ends before the last scoreboard updates of the round are written
 * (e.g. the win bonus); the next round's round-start snapshot holds the true final values, so when the
 * next round of the same match is present its snapshot corrects this round's score and assists.
 */
function aggregatePlayers(rounds) {
  const out = [];
  const idx = new Map();
  for (let ri = 0; ri < rounds.length; ri++) {
    const rd = rounds[ri];
    const byName = new Map();
    for (const p of rd.players || []) byName.set(p.username, p);
    const nx = rounds[ri + 1];
    let nextStats = null;
    if (nx && nx.matchID === rd.matchID) {
      nextStats = new Map();
      for (const s of nx.stats || []) nextStats.set(s.username, s);
    }
    for (const s of rd.stats || []) {
      let i = idx.get(s.username);
      const pl = byName.get(s.username);
      if (i === undefined) {
        i = out.length;
        idx.set(s.username, i);
        out.push({
          username: s.username, profileID: (pl && pl.profileID) || '', teamIndex: s.teamIndex !== undefined ? s.teamIndex : (pl ? pl.teamIndex : -1),
          rounds: 0, kills: 0, deaths: 0, assists: 0, headshots: 0, headshotPercentage: 0, score: 0, operators: new Map(),
        });
      }
      const a = out[i];
      if (!a.profileID && pl && pl.profileID) a.profileID = pl.profileID;
      a.rounds += 1;
      a.kills += s.kills;
      if (s.died) a.deaths += 1;
      let assists = s.assists;
      let score = s.roundScore !== undefined ? s.roundScore : s.score || 0;
      const ns = nextStats && s.scoreStart !== undefined ? nextStats.get(s.username) : undefined;
      if (ns && ns.scoreStart !== undefined) {
        assists = Math.max(assists, ns.assistsStart - s.assistsStart);
        score = Math.max(score, ns.scoreStart - s.scoreStart);
      }
      a.assists += assists;
      a.headshots += s.headshots;
      a.score += score;
      a.headshotPercentage = a.kills === 0 ? 0 : (a.headshots / a.kills) * 100;
      if (pl) {
        const key = pl.operator.id;
        const o = a.operators.get(key) || { name: pl.operator.name, id: pl.operator.id, role: pl.operator.role || 'Unknown', rounds: 0 };
        o.rounds += 1;
        a.operators.set(key, o);
      }
    }
  }
  return out;
}

/** Operator swap events of a round (prep phase operator changes): [{username, operator, time, timeInSeconds}]. */
function operatorSwapsOf(rd) {
  const out = [];
  for (const m of rd.matchFeedback || []) {
    if (m.type && m.type.id === 7) out.push({ username: m.username, operator: m.operator, time: m.time, timeInSeconds: m.timeInSeconds });
  }
  return out;
}

/** Team index of a player in the first round that lists them; -1 if absent. */
function ownTeamIndexOf(rounds, recordingProfileID, recordingPlayerID) {
  for (const rd of rounds) {
    for (const p of rd.players || []) {
      if ((recordingProfileID && p.profileID === recordingProfileID) || (!recordingProfileID && recordingPlayerID && p.id === recordingPlayerID)) {
        return p.teamIndex;
      }
    }
  }
  return -1;
}

/**
 * Compact summary of a match built from the round list of parseMatchFolder.
 * @param {{rounds: object[]}|object[]} matchOrRounds
 */
function summarizeMatch(matchOrRounds) {
  const rounds = Array.isArray(matchOrRounds) ? matchOrRounds : matchOrRounds.rounds || [];
  if (!rounds.length) return null;
  const sorted = rounds.slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const scores = [last.teams[0].score, last.teams[1].score];
  // Wins counted from per-round `won` flags as a fallback when scores tie.
  const winnerTeamIndex = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : -1;
  const ownTeamIndex = ownTeamIndexOf(sorted, first.recordingProfileID, first.recordingPlayerID);
  const players = aggregatePlayers(sorted).map((a) => ({
    profileID: a.profileID,
    username: a.username,
    teamIndex: a.teamIndex,
    operators: Array.from(a.operators.values()).sort((x, y) => y.rounds - x.rounds),
    kills: a.kills,
    deaths: a.deaths,
    assists: a.assists,
    headshots: a.headshots,
    hsPercent: hsPercent(a.headshots, a.kills),
    kd: kd(a.kills, a.deaths),
    roundsPlayed: a.rounds,
    kpr: kpr(a.kills, a.rounds),
    score: a.score,
  }));
  let result = 'unknown';
  if (ownTeamIndex >= 0 && winnerTeamIndex >= 0) result = ownTeamIndex === winnerTeamIndex ? 'win' : 'loss';
  else if (ownTeamIndex >= 0 && scores[0] === scores[1]) result = 'draw';
  return {
    matchId: first.matchID,
    timestamp: first.timestamp,
    lastRoundTimestamp: last.timestamp,
    map: first.map,
    matchType: first.matchType,
    gamemode: first.gamemode,
    gameVersion: first.gameVersion,
    roundsPerMatch: first.roundsPerMatch,
    roundsParsed: sorted.length,
    recordingProfileID: first.recordingProfileID || '',
    teams: [0, 1].map((i) => ({ index: i, name: last.teams[i].name, score: scores[i], won: winnerTeamIndex === i })),
    winnerTeamIndex,
    ownTeamIndex,
    result,
    players,
    operatorSwapCount: sorted.reduce((n, rd) => n + operatorSwapsOf(rd).length, 0),
    rounds: sorted.map((rd) => ({
      roundNumber: rd.roundNumber,
      operatorSwaps: operatorSwapsOf(rd),
      site: rd.site || '',
      score: [rd.teams[0].score, rd.teams[1].score],
      winnerTeamIndex: rd.teams[0].won && !rd.teams[1].won ? 0 : rd.teams[1].won && !rd.teams[0].won ? 1 : -1,
      winCondition: (rd.teams.find((t) => t.won) || {}).winCondition || '',
      teamRoles: [rd.teams[0].role || '', rd.teams[1].role || ''],
    })),
  };
}

module.exports = { operatorSwapsOf, round1, round2, hsPercent, kd, kpr, aggregatePlayers, ownTeamIndexOf, summarizeMatch };
