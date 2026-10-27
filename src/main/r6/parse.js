'use strict';
// Async parsing API on top of the JS port of r6-dissect
// (https://github.com/redraskal/r6-dissect, MIT License, Copyright (c) 2022 Benjamin Ryan).

const fs = require('fs');
const path = require('path');
const { parseBuffer } = require('./dissect');
const { matchPlayerStats } = require('./dissect/stats');
const { aggregatePlayers, summarizeMatch } = require('./summary');

/** Small Map-based cache with FIFO eviction. */
class ParseCache {
  constructor(max = 600) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, value);
  }
  delete(key) {
    this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}

const defaultCache = new ParseCache();
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function roundIndexOf(file) {
  const m = /-R(\d+)\.rec$/i.exec(file);
  return m ? Number(m[1]) : 0;
}

/**
 * Parses one .rec file.
 * @param {string} file
 * @param {{cache?: ParseCache|null}} [opts] pass cache:null to disable caching
 * @returns {Promise<object>} round JSON (upstream shape) + {file, roundIndex, errors[]}
 */
async function parseRound(file, opts = {}) {
  const cache = opts.cache === undefined ? defaultCache : opts.cache;
  const st = await fs.promises.stat(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const buf = await fs.promises.readFile(file);
  const out = parseBuffer(buf);
  out.file = path.basename(file);
  out.roundIndex = roundIndexOf(file);
  if (cache) cache.set(key, out);
  return out;
}

/** Lists match folders (Match-*) of a MatchReplay directory, oldest first. */
async function listMatchFolders(replayDir) {
  const ents = await fs.promises.readdir(replayDir, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory() && /^Match-/i.test(e.name)).map((e) => path.join(replayDir, e.name)).sort();
}

/**
 * Parses all rounds of one match folder. A failing round does not fail the match:
 * it is reported in `errors` ({file, message}) and the rest is returned.
 * @returns {Promise<{dir:string, name:string, rounds:object[], stats:object[], errors:object[], summary:object|null}>}
 */
async function parseMatchFolder(dir, opts = {}) {
  const cache = opts.cache === undefined ? defaultCache : opts.cache;
  let files = [];
  const errors = [];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => /\.rec$/i.test(f)).sort();
  } catch (e) {
    errors.push({ file: dir, message: e.message });
  }
  // Folder-level cache: dir + per-file mtime/size
  let folderKey = null;
  if (cache) {
    const sig = [];
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        sig.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch (_) {
        sig.push(`${f}:?`);
      }
    }
    folderKey = `folder|${dir}|${sig.join(',')}`;
    const hit = cache.get(folderKey);
    if (hit) return hit;
  }
  const rounds = [];
  for (const f of files) {
    try {
      rounds.push(await parseRound(path.join(dir, f), { cache }));
    } catch (e) {
      errors.push({ file: f, message: e.message });
    }
    await yieldLoop(); // never block the event loop for more than one round
  }
  rounds.sort((a, b) => a.roundIndex - b.roundIndex);
  const stats = aggregatePlayers(rounds).map((a) => ({
    username: a.username, profileID: a.profileID, teamIndex: a.teamIndex, rounds: a.rounds, kills: a.kills,
    deaths: a.deaths, assists: a.assists, headshots: a.headshots, headshotPercentage: a.headshotPercentage,
  }));
  const match = { dir, name: path.basename(dir), rounds, stats, errors, summary: null };
  match.summary = summarizeMatch(rounds);
  if (cache && folderKey) cache.set(folderKey, match);
  return match;
}

module.exports = { ParseCache, defaultCache, parseRound, parseMatchFolder, listMatchFolders, roundIndexOf, matchPlayerStats, yieldLoop };
