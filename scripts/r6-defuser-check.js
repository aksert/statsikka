'use strict';
// Checks the plant/disable (defuser) decoding of src/main/r6/dissect/defuse.js over real replays (read-only).
// Usage: node scripts/r6-defuser-check.js [--dir <MatchReplay>] [--matches N] [--verbose]
// Per replay round it reports the number of plant/disable completions, how many got an acting player, and checks
//   hard (exit 1 when violated):
//     - the actor of a plant is on the attacking team, the actor of a disable on the defending team
//     - the actor is alive at that point of the kill feed
//     - a Start event (DefuserPlantStart / DefuserDisableStart) exists for every attributed completion, by the same player
//     - round outcome: a disable implies the defenders won (score); a plant without a disable implies the attackers won
//       (once the bomb is down only a disable or the detonation ends the round)
//   soft (reported): the actor's first scoreboard update after the completion is the +100 objective bonus (independent
//     signal from the scoreboard entities; unavailable when the recording ends right at the completion)

const fs = require('fs');
const path = require('path');
const { Reader } = require('../src/main/r6/dissect/reader');
const { T } = require('../src/main/r6/dissect/tables');
const { listMatchFolders, findReplayDirs } = require('../src/main/r6');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const verbose = args.includes('--verbose');
const BONUS = 100;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

/** Checks one finished reader; returns counters and violation messages. */
function checkRound(r, label) {
  const h = r.header;
  const out = { plant: 0, disable: 0, named: 0, inferred: 0, roleOk: 0, aliveOk: 0, startOk: 0, outcomeOk: 0, outcomeBad: 0, bonusOk: 0, bonusBad: 0, bonusNone: 0, starts: 0, startsOk: 0, bad: [] };
  const teamOf = new Map(h.players.map((p) => [p.username, p.teamIndex]));
  const roleOfTeam = (t) => (h.teams[t] || {}).role || '';
  const gain = h.teams.map((t) => t.score - t.startingScore);
  const winner = gain[0] > 0 && gain[1] <= 0 ? 0 : gain[1] > 0 && gain[0] <= 0 ? 1 : -1;
  const attackers = h.teams.findIndex((t) => t.role === 'Attack');
  const dead = new Set();
  const started = { plant: new Set(), disable: new Set() };
  let plants = 0;
  let disables = 0;
  r.matchFeedback.forEach((e, k) => {
    if (e.type === T.Kill) dead.add(e.target);
    else if (e.type === T.Death) dead.add(e.username);
    else if (e.type === T.DefuserPlantStart || e.type === T.DefuserDisableStart) {
      const plant = e.type === T.DefuserPlantStart;
      out.starts++;
      const t = teamOf.get(e.username);
      if (t !== undefined && roleOfTeam(t) === (plant ? 'Attack' : 'Defense') && !dead.has(e.username)) out.startsOk++;
      else out.bad.push(`${label}: ${plant ? 'plant' : 'disable'} start by ${e.username} with wrong role or dead`);
      (plant ? started.plant : started.disable).add(e.username);
    } else if (e.type === T.DefuserPlantComplete || e.type === T.DefuserDisableComplete) {
      const plant = e.type === T.DefuserPlantComplete;
      if (plant) { out.plant++; plants++; } else { out.disable++; disables++; }
      if (!e.username) { out.bad.push(`${label}: ${plant ? 'plant' : 'disable'} at ${e.time} has no actor`); return; }
      out.named++;
      const t = teamOf.get(e.username);
      if (t !== undefined && roleOfTeam(t) === (plant ? 'Attack' : 'Defense')) out.roleOk++;
      else out.bad.push(`${label}: ${plant ? 'plant' : 'disable'} actor ${e.username} on the wrong team`);
      if (!dead.has(e.username)) out.aliveOk++;
      else out.bad.push(`${label}: ${plant ? 'plant' : 'disable'} actor ${e.username} was already dead`);
      if ((plant ? started.plant : started.disable).has(e.username)) out.startOk++;
      else out.bad.push(`${label}: ${plant ? 'plant' : 'disable'} actor ${e.username} has no start event`);
      if (!plant) {
        if (winner === t) out.outcomeOk++;
        else { out.outcomeBad++; out.bad.push(`${label}: disable by ${e.username} but the defenders did not win`); }
      }
      if (r.sbLog) {
        const next = r.sbLog.find((x) => x.username === e.username && x.fb > k);
        if (!next) out.bonusNone++;
        else if (next.value - (next.prev || 0) === BONUS) out.bonusOk++;
        else { out.bonusBad++; if (verbose) console.log(`  ${label}: ${e.username} first score step after the ${plant ? 'plant' : 'disable'} is ${next.value - (next.prev || 0)}`); }
      }
    }
  });
  if (plants > 0 && disables === 0) {
    if (winner === attackers) out.outcomeOk++;
    else { out.outcomeBad++; out.bad.push(`${label}: plant without disable but the attackers did not win`); }
  }
  return out;
}

async function main() {
  let dir = opt('dir', null);
  if (!dir) dir = (await findReplayDirs())[0];
  if (!dir) throw new Error('MatchReplay directory not found; pass --dir');
  let folders = await listMatchFolders(dir);
  if (opt('matches', null)) folders = folders.slice(-Number(opt('matches', 0)));
  const tot = { rounds: 0, failed: 0, plant: 0, disable: 0, named: 0, roleOk: 0, aliveOk: 0, startOk: 0, outcomeOk: 0, outcomeBad: 0, bonusOk: 0, bonusBad: 0, bonusNone: 0, starts: 0, startsOk: 0, plantRounds: 0 };
  const bad = [];
  for (const folder of folders) {
    for (const f of fs.readdirSync(folder).filter((n) => /\.rec$/i.test(n)).sort()) {
      const label = `${path.basename(folder).slice(6, 25)} ${f.replace(/^.*-(R\d+)\.rec$/i, '$1')}`;
      let r;
      try {
        r = new Reader(fs.readFileSync(path.join(folder, f)), { scoreLog: true });
        r.read();
      } catch (e) {
        tot.failed++;
        continue;
      }
      if (r.header.matchType === 13) continue; // team deathmatch has no bomb
      tot.rounds++;
      const c = checkRound(r, label);
      for (const k of Object.keys(c)) if (typeof c[k] === 'number') tot[k] = (tot[k] || 0) + c[k];
      if (c.plant) tot.plantRounds++;
      bad.push(...c.bad);
    }
  }
  console.log(`rounds=${tot.rounds} (unreadable ${tot.failed}), plant completions=${tot.plant} in ${tot.plantRounds} rounds, disable completions=${tot.disable}`);
  const n = tot.plant + tot.disable;
  console.log(`attributed to a player: ${tot.named}/${n} (${pct(tot.named, n)}); correct side: ${tot.roleOk}/${tot.named}; alive at the time: ${tot.aliveOk}/${tot.named}; with a start event by the same player: ${tot.startOk}/${tot.named}`);
  console.log(`start events: ${tot.starts}, correct side and alive: ${tot.startsOk} (${pct(tot.startsOk, tot.starts)})`);
  console.log(`round outcome consistency (disable -> defenders won, plant without disable -> attackers won): ${tot.outcomeOk} ok, ${tot.outcomeBad} contradicting`);
  console.log(`+${BONUS} scoreboard bonus on the actor's next score update: ${tot.bonusOk}/${tot.named} (no later update in the recording: ${tot.bonusNone}, other value: ${tot.bonusBad})`);
  for (const b of bad) console.log(`FAIL ${b}`);
  console.log(bad.length ? 'defuser check FAILED' : 'defuser check ok');
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
