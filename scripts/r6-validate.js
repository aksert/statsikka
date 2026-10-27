'use strict';
// Sanity checks of the Y11S3 scoreboard / operator swap / table support over real replays (read-only).
// Usage: node scripts/r6-validate.js [--dir <MatchReplay>] [--matches N]
// Prints a report and exits 1 when a hard invariant is violated.
//   hard:  swaps only in the prep phase (clock <= 45 s, non-arcade), swapped attackers swap to attack operators,
//          assists never exceed the team's kills by more than the known edge case, no unknown operator/map ids
//          except those listed in KNOWN_UNKNOWN_MAPS
//   soft:  scoreboard kills vs kill feed kills, scoreboard continuity between rounds (reported as rates)
//   defuser: plant/disable completions must name an actor on the right side (full per-event checks incl. alive state,
//          outcome consistency and the +100 score bonus: scripts/r6-defuser-check.js)

const fs = require('fs');
const path = require('path');
const { parseMatchFolder, listMatchFolders, findReplayDirs, summarizeMatch } = require('../src/main/r6');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const KNOWN_UNKNOWN_MAPS = new Set([419965653950]);
const PREP_CLOCK_MAX = 45;

async function main() {
  let dir = opt('dir', null);
  if (!dir) dir = (await findReplayDirs())[0];
  if (!dir) throw new Error('MatchReplay directory not found; pass --dir');
  let folders = await listMatchFolders(dir);
  if (opt('matches', null)) folders = folders.slice(-Number(opt('matches', 0)));
  const hard = [];
  const c = {
    matches: 0, rounds: 0, players: 0, playersWithAssists: 0, assistsOverTeamKills: 0, sbKillRows: 0, sbKillMismatchRows: 0, sbKillRounds: 0,
    sbKillMismatchRounds: 0, sbTeamRows: 0, sbTeamMismatch: 0, scoreDecrease: 0, scoreStartBackwards: 0, swapPlayersAll: 0, snapRows: 0, snapGap: 0, swaps: 0, swapsPrep: 0, swapRounds: 0,
    swapPlayers: 0, swapPlayersChanged: 0, dfComplete: 0, dfNamed: 0, dfRoleOk: 0, swapNonAttack: 0, arcadeRounds: 0, errors: 0, parseMs: 0, summaryAssists: 0, summaryScoreZero: 0, summaryPlayers: 0,
  };
  const unknownOps = new Set();
  const unknownMaps = new Map();
  for (const folder of folders) {
    const t0 = process.hrtime.bigint();
    const m = await parseMatchFolder(folder, { cache: null });
    c.parseMs += Number(process.hrtime.bigint() - t0) / 1e6;
    c.matches++;
    c.errors += m.errors.length;
    const rounds = m.rounds;
    rounds.forEach((rd, ri) => {
      c.rounds++;
      c.errors += (rd.errors || []).length;
      const arcade = rd.matchType.id === 13;
      if (arcade) c.arcadeRounds++;
      if (rd.map.name.startsWith('Kartta')) unknownMaps.set(rd.map.id, [...(unknownMaps.get(rd.map.id) || []), rd.site || '-']);
      const teamKills = [0, 0];
      const teamSb = [0, 0];
      for (const f of rd.matchFeedback) {
        if (f.type.id !== 0) continue;
        const p = rd.players.find((x) => x.username === f.username);
        if (p) teamKills[p.teamIndex]++;
      }
      let mm = 0;
      for (const p of rd.players) {
        if (p.operator.name.startsWith('Operaattori')) unknownOps.add(p.operator.id);
        if (p.startOperator) {
          c.swapPlayers++;
          if (p.startOperator.id !== p.operator.id) c.swapPlayersChanged++;
        }
      }
      for (const s of rd.stats) {
        c.players++;
        if (s.assists > 0) c.playersWithAssists++;
        if (s.assists > teamKills[s.teamIndex]) c.assistsOverTeamKills++;
        if (s.score < s.scoreStart) c.scoreDecrease++;
        if (!arcade && s.sbKills !== undefined) {
          c.sbKillRows++;
          teamSb[s.teamIndex] += s.sbKills;
          if (s.sbKills !== s.kills) {
            c.sbKillMismatchRows++;
            mm++;
          }
        }
        const prev = ri > 0 ? rounds[ri - 1].stats.find((x) => x.username === s.username) : null;
        if (prev && prev.score !== undefined && s.scoreStart !== undefined) {
          c.snapRows++;
          if (s.scoreStart < prev.scoreStart) c.scoreStartBackwards++; // real score penalties (team kills) can lower the score
          if (s.scoreStart !== prev.score) c.snapGap++;
        }
      }
      if (!arcade) {
        c.sbKillRounds++;
        if (mm) c.sbKillMismatchRounds++;
        for (let t = 0; t < 2; t++) {
          c.sbTeamRows++;
          if (teamSb[t] !== teamKills[t]) c.sbTeamMismatch++;
        }
      }
      for (const f of rd.matchFeedback) {
        const plant = f.type.name === 'DefuserPlantComplete';
        if (!plant && f.type.name !== 'DefuserDisableComplete') continue;
        c.dfComplete++;
        const p = f.username ? rd.players.find((x) => x.username === f.username) : null;
        if (!p) continue;
        c.dfNamed++;
        if (rd.teams[p.teamIndex].role === (plant ? 'Attack' : 'Defense')) c.dfRoleOk++;
      }
      const swaps = rd.matchFeedback.filter((f) => f.type.id === 7);
      c.swapPlayersAll += new Set(swaps.map((x) => x.username)).size;
      if (swaps.length) c.swapRounds++;
      for (const sw of swaps) {
        c.swaps++;
        if (arcade || sw.timeInSeconds <= PREP_CLOCK_MAX) c.swapsPrep++;
        else hard.push(`${rd.file}: swap outside prep phase at ${sw.time}`);
        const p = rd.players.find((x) => x.username === sw.username);
        if (!arcade && p && rd.teams[p.teamIndex].role === 'Attack' && sw.operator.name && !/^Operaattori/.test(sw.operator.name)) {
          const role = require('../src/main/r6/dissect/tables').operatorRole(sw.operator.id);
          if (role !== 'Attack') c.swapNonAttack++;
        }
      }
    });
    const sum = summarizeMatch(rounds);
    if (sum) {
      for (const p of sum.players) {
        c.summaryPlayers++;
        c.summaryAssists += p.assists;
        if (p.score === 0) c.summaryScoreZero++;
      }
    }
  }
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  console.log(`matches=${c.matches} rounds=${c.rounds} (arcade ${c.arcadeRounds}) player-rounds=${c.players} parse errors=${c.errors} avg ${(c.parseMs / Math.max(1, c.rounds)).toFixed(0)} ms/round (incl. folder overhead)`);
  console.log(`assists: ${c.playersWithAssists}/${c.players} player-rounds have assists (${pct(c.playersWithAssists, c.players)}); assists > team kills in ${c.assistsOverTeamKills} cases`);
  console.log(`score: decreases within a round ${c.scoreDecrease}, between rounds ${c.scoreStartBackwards} (team-kill penalties); summary players with score 0: ${c.summaryScoreZero}/${c.summaryPlayers}; summed match assists ${c.summaryAssists}`);
  console.log(`scoreboard continuity (round-start snapshot == previous round's last seen value): gaps ${c.snapGap}/${c.snapRows} (${pct(c.snapGap, c.snapRows)}); summary corrects them from the next snapshot`);
  console.log(`scoreboard kills vs kill feed (non-arcade): player rows ${c.sbKillMismatchRows}/${c.sbKillRows} differ (${pct(c.sbKillMismatchRows, c.sbKillRows)}), rounds ${c.sbKillMismatchRounds}/${c.sbKillRounds} (${pct(c.sbKillMismatchRounds, c.sbKillRounds)}), team totals ${c.sbTeamMismatch}/${c.sbTeamRows} differ (${pct(c.sbTeamMismatch, c.sbTeamRows)})`);
  console.log(`swaps: ${c.swaps} events in ${c.swapRounds} rounds, ${c.swapsPrep} in prep phase; ${c.swapPlayersChanged}/${c.swapPlayersAll} players with swap events ended on another operator than at round start (the rest swapped back); attacker swaps to non-attack operators: ${c.swapNonAttack}`);
  console.log(`defuser completions: ${c.dfComplete}, with an actor ${c.dfNamed} (${pct(c.dfNamed, c.dfComplete)}), actor on the right side ${c.dfRoleOk}/${c.dfNamed}`);
  console.log(`unknown operators: ${[...unknownOps].join(', ') || '-'}`);
  for (const [id, sites] of unknownMaps) {
    const uniq = [...new Set(sites)];
    console.log(`unknown map ${id} (${sites.length} rounds): ${uniq.join(' | ')}`);
    if (!KNOWN_UNKNOWN_MAPS.has(id)) hard.push(`unexpected unknown map ${id}`);
  }
  if (unknownOps.size) hard.push(`unknown operators: ${[...unknownOps].join(', ')}`);
  if (c.assistsOverTeamKills > 2) hard.push('too many rounds with assists > team kills');
  if (c.swapNonAttack) hard.push('attackers swapped to non-attack operators');
  if (c.dfNamed < c.dfComplete) hard.push('plant/disable without an identified actor');
  if (c.dfRoleOk < c.dfNamed) hard.push('plant/disable actor on the wrong side');
  for (const h of hard) console.log(`FAIL ${h}`);
  console.log(hard.length ? 'validation FAILED' : 'validation ok');
  process.exitCode = hard.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
