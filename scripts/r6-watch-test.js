'use strict';
// Watcher integration test. Copies real replay files (read-only source) into a temp
// directory and simulates a match being played by writing files there. Never writes to the game folder.
// Usage: node scripts/r6-watch-test.js [--src <MatchReplay>]

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatcher, findReplayDirs } = require('../src/main/r6');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argSrc = process.argv.indexOf('--src');

async function main() {
  const src = argSrc >= 0 ? process.argv[argSrc + 1] : (await findReplayDirs())[0];
  if (!src) throw new Error('no MatchReplay dir found; use --src');
  const folders = fs.readdirSync(src).filter((n) => n.startsWith('Match-')).sort();
  const pick = (idx) => {
    const f = folders[idx];
    const recs = fs.readdirSync(path.join(src, f)).filter((n) => n.endsWith('.rec')).sort();
    return { f, recs };
  };
  const oldM = pick(folders.length - 3);
  const newM = pick(folders.length - 1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r6watch-'));
  assert(!path.resolve(root).toLowerCase().startsWith(path.resolve(src).toLowerCase()), 'temp dir must not be inside the game folder');
  const oldDir = path.join(root, oldM.f);
  fs.mkdirSync(oldDir);
  fs.copyFileSync(path.join(src, oldM.f, oldM.recs[0]), path.join(oldDir, oldM.recs[0]));
  console.log(`temp root: ${root}`);

  const w = createWatcher(root, { pollMs: 400, stableMs: 700, matchEndMs: 3000 });
  const events = [];
  const t0 = Date.now();
  w.on('round', (e) => events.push({ ev: 'round', t: Date.now() - t0, dir: e.dir, file: e.file, rounds: e.match.rounds.length, round: e.round }));
  w.on('matchEnd', (e) => events.push({ ev: 'matchEnd', t: Date.now() - t0, dir: path.basename(e.dir), reason: e.reason, rounds: e.match.rounds.length, summary: e.match.summary }));
  w.on('parseError', (e) => events.push({ ev: 'parseError', file: e.file, msg: e.error.message }));

  // scanAll on the baseline (cache check)
  let s = Date.now();
  const all1 = await w.scanAll();
  const d1 = Date.now() - s;
  s = Date.now();
  const all2 = await w.scanAll();
  const d2 = Date.now() - s;
  assert.strictEqual(all1.length, 1);
  assert.strictEqual(all1[0], all2[0], 'second scanAll must hit the cache');
  console.log(`scanAll: first ${d1} ms, cached ${d2} ms`);

  await w.start();
  await sleep(1000);
  assert.strictEqual(events.filter((e) => e.ev === 'round').length, 0, 'existing files must not be reported');

  // A new match starts: round 1 is written slowly (in two parts)
  const newDir = path.join(root, newM.f);
  fs.mkdirSync(newDir);
  const rec1 = fs.readFileSync(path.join(src, newM.f, newM.recs[0]));
  const target1 = path.join(newDir, newM.recs[0]);
  // write in 6 chunks with gaps shorter than stableMs: file keeps growing, must not be reported meanwhile
  const chunk = Math.ceil(rec1.length / 6);
  fs.writeFileSync(target1, rec1.subarray(0, chunk));
  for (let i = 1; i < 6; i++) {
    await sleep(300);
    fs.appendFileSync(target1, rec1.subarray(i * chunk, (i + 1) * chunk));
  }
  const early = events.filter((e) => e.ev === 'round').length;
  const waitFor = async (pred, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label}; events=${JSON.stringify(events.map((e) => [e.ev, e.file || e.dir, e.t]))}`);
  };
  await waitFor(() => events.some((e) => e.ev === 'round' && e.file === newM.recs[0] && e.rounds === 1 && e.round.errors.length === 0), 15000, 'round 1 event');
  const r1Events = events.filter((e) => e.ev === 'round' && e.file === newM.recs[0]);
  console.log(`early events before file complete: ${early}; round-1 events: ${r1Events.length}`);
  assert.strictEqual(early, 0, 'half-written file reported');
  assert.strictEqual(r1Events.length, 1, 'round 1 reported exactly once');

  // Round 2 arrives
  fs.copyFileSync(path.join(src, newM.f, newM.recs[1]), path.join(newDir, newM.recs[1]));
  await waitFor(() => events.some((e) => e.ev === 'round' && e.file === newM.recs[1] && e.rounds === 2), 15000, 'round 2 event');

  // No more files: match ends after matchEndMs
  await waitFor(() => events.some((e) => e.ev === 'matchEnd' && e.dir === newM.f), 15000, 'matchEnd idle');
  const me = events.find((e) => e.ev === 'matchEnd');
  assert.strictEqual(me.reason, 'idle');
  assert.strictEqual(me.rounds, 2);
  assert(me.summary && me.summary.players.length >= 10);

  // Another match folder appears -> previous active one ends immediately ('newMatch')
  // (first re-activate the old one by touching a new file so it is "active")
  const nextName = newM.f.replace(/Match-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})-(\d{2})/, (m, a, b) => `Match-${a}-${String(Number(b) + 1).padStart(2, '0')}`);
  const lateDir = path.join(root, `${nextName}-X`);
  fs.mkdirSync(lateDir);
  fs.copyFileSync(path.join(src, oldM.f, oldM.recs[0]), path.join(lateDir, oldM.recs[0]));
  await waitFor(() => events.some((e) => e.ev === 'round' && e.dir === lateDir), 15000, 'round in third folder');

  // A fourth folder appears while the third is still active -> immediate matchEnd with reason 'newMatch'
  const fourth = path.join(root, `${nextName}-Y`);
  fs.mkdirSync(fourth);
  await waitFor(() => events.some((e) => e.ev === 'matchEnd' && e.dir === path.basename(lateDir) && e.reason === 'newMatch'), 15000, 'matchEnd newMatch');

  w.stop();
  console.log(events.map((e) => `${String(e.t).padStart(6)} ms ${e.ev} ${e.file || e.dir || ''} ${e.reason || ''}`).join('\n'));
  console.log(`parse errors: ${events.filter((e) => e.ev === 'parseError').length}`);
  assert.strictEqual(events.filter((e) => e.ev === 'parseError').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('WATCHER OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
