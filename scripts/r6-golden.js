'use strict';
// Golden test: compares the JS port against the upstream r6-dissect.exe on real replays.
// Usage: node scripts/r6-golden.js [--matches 5] [--dir <MatchReplay>] [--exe <r6-dissect.exe>] [--verbose]
// Read-only for the replay folder. Exe output goes to the OS temp dir.
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License) is compared against its v0.24.0 binary.
//
// Fields that the upstream binary cannot produce on current replays are compared only where upstream
// has data (so the JS port may know more than upstream, but must never disagree with it):
//   - operator swaps: upstream has none -> JS OperatorSwap feed entries are ignored and players are compared
//     by their round-start operator (player.startOperator when the player swapped, else player.operator)
//   - score / assists: upstream reads 0 on Y11S3 -> compared only when the upstream round has a non-zero
//     value for any player (score and assists separately); a non-zero upstream value must match exactly
//   - defuser events (types 2-5): upstream attributes every plant/disable on Y11S3 to the first roster player, starts no
//     countdown events and emits a bogus DisableComplete for the 0.000 packet that follows each plant. The JS port decodes the
//     acting player (see dissect/defuse.js), so defuser events are removed from the feed comparison and only the FIRST
//     DefuserPlantComplete (type 3: its clock text and seconds, not its actor) is compared; both sides must agree on whether
//     and when it happened.
//   - team won / winCondition: derived by upstream from those wrong actors, so they are compared only in rounds where the
//     upstream feed has no plant/disable completion (name, score, startingScore, role are always compared)
//   - 1vX: upstream derives the winning side from the same team `won` flags, so it is compared only where those are compared
//   - JS-only extras (roundScore, scoreStart, sbKills, ...) are never compared

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseRound } = require('../src/main/r6');
const { findReplayDirs } = require('../src/main/r6');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const verbose = args.includes('--verbose');
const nMatches = Number(opt('matches', 5));
const exe = opt('exe', path.join(os.tmpdir(), 'r6dissect-dl', 'x', 'r6-dissect.exe'));

function runExe(file, out) {
  return new Promise((resolve) => {
    execFile(exe, [file, '-o', out], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, message: String(stderr || err.message).split('\n').find((l) => l.trim()) || 'failed' });
      try {
        resolve({ ok: true, json: JSON.parse(fs.readFileSync(out, 'utf8')) });
      } catch (e) {
        resolve({ ok: false, message: `bad json: ${e.message}` });
      }
    });
  });
}

function compare(exe, js) {
  const d = [];
  const DEFUSER = new Set([2, 3, 4, 5]);
  const exeHasDefuser = (exe.matchFeedback || []).some((m) => m.type.id === 3 || m.type.id === 5);
  const eq = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) d.push(`${label}: exe=${JSON.stringify(a)} js=${JSON.stringify(b)}`);
  };
  for (const k of ['gameVersion', 'codeVersion', 'timestamp', 'site', 'recordingProfileID', 'roundsPerMatch', 'roundNumber', 'matchID']) {
    eq(k, exe[k] || '', js[k] || '');
  }
  eq('matchType', exe.matchType.id, js.matchType.id);
  eq('map', exe.map.id, js.map.id);
  eq('gamemode', exe.gamemode.id, js.gamemode.id);
  for (let i = 0; i < 2; i++) {
    const a = exe.teams[i];
    const b = js.teams[i];
    const t = (x, withResult) => ({ n: x.name, s: x.score, r: x.role || '', ...(withResult ? { w: x.won, c: x.winCondition || '' } : {}) });
    eq(`team${i}`, t(a, exeHasDefuser ? false : true), t(b, exeHasDefuser ? false : true));
  }
  const pl = (x) => (x.players || []).map((p) => ({ u: p.username, p: p.profileID || '', t: p.teamIndex, o: p.operator.id, s: p.spawn || '' }));
  const plJs = (x) => (x.players || []).map((p) => ({ u: p.username, p: p.profileID || '', t: p.teamIndex, o: (p.startOperator || p.operator).id, s: p.spawn || '' }));
  eq('players', pl(exe), plJs(js));
  const fb = (x) => (x.matchFeedback || []).filter((m) => m.type.id !== 7 && !DEFUSER.has(m.type.id)).map((m) => ({
    t: m.type.id, u: m.username || '', g: m.target || '', h: m.headshot === undefined ? null : m.headshot, ti: m.time, s: m.timeInSeconds, o: m.operator ? m.operator.id : 0,
  }));
  eq('matchFeedback', fb(exe), fb(js));
  const plant1 = (x) => { const m = (x.matchFeedback || []).find((e) => e.type.id === 3); return m ? { ti: m.time, s: m.timeInSeconds } : null; };
  eq('firstPlantComplete', plant1(exe), plant1(js));
  const exeScore = (exe.stats || []).some((s) => s.score > 0);
  const exeAssists = (exe.stats || []).some((s) => s.assists > 0);
  const st = (x) => (x.stats || []).map((s) => ({ u: s.username, sc: exeScore ? s.score : null, k: s.kills, d: s.died, a: exeAssists ? s.assists : null, h: s.headshots, hp: Math.round(s.headshotPercentage * 1e6), x: exeHasDefuser ? null : s['1vX'] || 0 }));
  // Upstream credits kills of killers that are not in the player list to player 0
  // (Go map miss -> index 0); emulate that quirk so only real differences remain.
  const jsq = JSON.parse(JSON.stringify(js));
  const names = new Set(jsq.players.map((p) => p.username));
  for (const m of jsq.matchFeedback) {
    if (m.type.id === 0 && !names.has(m.username) && jsq.stats.length) {
      const s0 = jsq.stats[0];
      s0.kills += 1;
      if (m.headshot) s0.headshots += 1;
      s0.headshotPercentage = (s0.headshots / s0.kills) * 100;
    }
  }
  eq('stats', st(exe), st(jsq));
  return d;
}

async function main() {
  let dir = opt('dir', null);
  if (!dir) {
    const dirs = await findReplayDirs();
    dir = dirs[0];
  }
  if (!dir) throw new Error('MatchReplay directory not found; pass --dir');
  const folders = fs.readdirSync(dir).filter((n) => n.startsWith('Match-')).sort().slice(-nMatches);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6golden-'));
  const counts = { PASS: 0, DIFF: 0, 'EXE-FAIL': 0, 'EXE-FAIL-JS-OK': 0, 'EXE-FAIL-JS-FAIL': 0 };
  let jsMs = 0;
  let rounds = 0;
  for (const folder of folders) {
    const files = fs.readdirSync(path.join(dir, folder)).filter((f) => f.endsWith('.rec')).sort();
    for (const f of files) {
      const file = path.join(dir, folder, f);
      const label = `${folder.slice(6, 25)} ${f.replace(/^.*-(R\d+)\.rec$/, '$1')}`;
      const out = path.join(tmp, 'o.json');
      const ex = await runExe(file, out);
      let js;
      let jsErr = null;
      const t0 = process.hrtime.bigint();
      try {
        js = await parseRound(file);
      } catch (e) {
        jsErr = e;
      }
      jsMs += Number(process.hrtime.bigint() - t0) / 1e6;
      rounds++;
      if (!ex.ok) {
        counts['EXE-FAIL']++;
        if (jsErr) {
          counts['EXE-FAIL-JS-FAIL']++;
          console.log(`${label}  EXE-FAIL  JS-FAIL  (${jsErr.message})`);
        } else {
          counts['EXE-FAIL-JS-OK']++;
          const unk = js.players.filter((p) => p.operator.name.startsWith('Operaattori')).map((p) => p.operator.id);
          console.log(`${label}  EXE-FAIL  JS-OK    (exe: ${ex.message.slice(0, 80)}; js errors: ${js.errors.length}, unknown ops: ${unk.join(',') || '-'})`);
        }
        continue;
      }
      if (jsErr) {
        counts.DIFF++;
        console.log(`${label}  DIFF  JS threw: ${jsErr.message}`);
        continue;
      }
      const d = compare(ex.json, js);
      if (d.length === 0) {
        counts.PASS++;
        console.log(`${label}  PASS`);
      } else {
        counts.DIFF++;
        console.log(`${label}  DIFF (${d.length})`);
        for (const line of d.slice(0, verbose ? 50 : 3)) console.log(`    ${line.slice(0, verbose ? 4000 : 600)}`);
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nrounds=${rounds} PASS=${counts.PASS} DIFF=${counts.DIFF} EXE-FAIL=${counts['EXE-FAIL']} (JS-OK=${counts['EXE-FAIL-JS-OK']}, JS-FAIL=${counts['EXE-FAIL-JS-FAIL']})  js avg=${(jsMs / Math.max(1, rounds)).toFixed(0)} ms/round`);
  process.exitCode = counts.DIFF || counts['EXE-FAIL-JS-FAIL'] ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
