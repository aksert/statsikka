'use strict';
// Watches an R6 MatchReplay directory and emits parsed rounds / finished matches.
// Parsing is done by the JS port of r6-dissect (https://github.com/redraskal/r6-dissect,
// MIT License, Copyright (c) 2022 Benjamin Ryan).
//
// Events:
//   'round'      { dir, file, round, match }            a .rec file finished writing (size stable for stableMs)
//   'matchEnd'   { dir, match, reason }                 reason: 'idle' (no change for matchEndMs) | 'newMatch'
//   'parseError' { dir, file, error }                   a round could not be parsed (retried once its size changes)
//   'ready'      { dir, folders }                        baseline taken, watching started
// `match` is the parseMatchFolder() result (rounds, stats, errors, summary).

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseRound, parseMatchFolder, listMatchFolders, defaultCache, yieldLoop } = require('./parse');

class R6Watcher extends EventEmitter {
  /**
   * @param {string} dir MatchReplay directory
   * @param {{pollMs?:number, stableMs?:number, matchEndMs?:number, recentFolders?:number,
   *          emitExisting?:boolean, cache?:object|null, now?:()=>number, useFsWatch?:boolean}} [opts]
   */
  constructor(dir, opts = {}) {
    super();
    this.dir = dir;
    this.pollMs = opts.pollMs || 5000;
    this.stableMs = opts.stableMs || 2000;
    this.matchEndMs = opts.matchEndMs || 3 * 60 * 1000;
    this.recentFolders = opts.recentFolders || 4;
    this.emitExisting = !!opts.emitExisting;
    this.cache = opts.cache === undefined ? defaultCache : opts.cache;
    this.now = opts.now || Date.now;
    this.useFsWatch = opts.useFsWatch !== false;
    this.files = new Map(); // file path -> {size, mtimeMs, changedAt, doneSig, failedSig}
    this.folders = new Map(); // dir -> {lastChange, ended}
    this.currentDir = null;
    this.fsWatcher = null;
    this.pollTimer = null;
    this.nextTimer = null;
    this.debounce = null;
    this.running = false;
    this.ticking = false;
    this.rerun = false;
  }

  /** Parses every existing match folder (cached by folder + file mtimes/sizes). Chronological order. */
  async scanAll(onProgress) {
    const folders = await listMatchFolders(this.dir);
    const out = [];
    for (let i = 0; i < folders.length; i++) {
      out.push(await parseMatchFolder(folders[i], { cache: this.cache }));
      if (onProgress) onProgress({ done: i + 1, total: folders.length, dir: folders[i] });
      await yieldLoop();
    }
    return out;
  }

  /** Takes the baseline (existing files are not reported) and starts watching. */
  async start() {
    if (this.running) return this;
    this.running = true;
    const folders = await listMatchFolders(this.dir);
    const now = this.now();
    for (const f of folders.slice(-this.recentFolders)) {
      const st = { lastChange: 0, ended: true };
      const files = await this.listRecs(f);
      for (const p of files) {
        const s = files.stats.get(p);
        this.files.set(p, {
          size: s.size, mtimeMs: s.mtimeMs, changedAt: now - this.stableMs - 1,
          doneSig: this.emitExisting ? null : `${s.size}|${s.mtimeMs}`, failedSig: null,
        });
        st.lastChange = Math.max(st.lastChange, s.mtimeMs);
      }
      // A folder touched within the idle window may still be an ongoing match.
      st.ended = !(this.emitExisting || now - st.lastChange < this.matchEndMs);
      if (!st.ended) st.lastChange = Math.max(st.lastChange, now - this.matchEndMs + 1);
      this.folders.set(f, st);
    }
    this.currentDir = folders.length ? folders[folders.length - 1] : null;
    if (this.useFsWatch) {
      try {
        this.fsWatcher = fs.watch(this.dir, { recursive: true }, () => this.schedule(300));
        this.fsWatcher.on('error', () => {
          try { this.fsWatcher.close(); } catch (_) { /* ignore */ }
          this.fsWatcher = null; // polling continues
        });
      } catch (_) {
        this.fsWatcher = null; // polling fallback only
      }
    }
    this.pollTimer = setInterval(() => this.tick(), this.pollMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
    this.emit('ready', { dir: this.dir, folders: folders.length });
    if (this.emitExisting) this.schedule(0);
    return this;
  }

  stop() {
    this.running = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.nextTimer);
    clearTimeout(this.debounce);
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch (_) { /* ignore */ }
    }
    this.fsWatcher = null;
    this.pollTimer = this.nextTimer = this.debounce = null;
  }

  schedule(ms) {
    if (!this.running) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.tick(), ms);
    if (this.debounce.unref) this.debounce.unref();
  }

  async listRecs(folder) {
    let names = [];
    try {
      names = (await fs.promises.readdir(folder)).filter((n) => /\.rec$/i.test(n)).sort();
    } catch (_) {
      /* folder vanished */
    }
    const paths = [];
    paths.stats = new Map();
    for (const n of names) {
      const p = path.join(folder, n);
      try {
        paths.stats.set(p, await fs.promises.stat(p));
        paths.push(p);
      } catch (_) {
        /* file vanished */
      }
    }
    return paths;
  }

  /** One scan of the newest folders; safe to call concurrently (serialized). */
  async tick() {
    if (!this.running) return;
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.rerun = false;
        await this.tickOnce();
      } while (this.rerun && this.running);
    } catch (e) {
      this.emit('parseError', { dir: this.dir, file: null, error: e });
    } finally {
      this.ticking = false;
    }
  }

  async tickOnce() {
    const now = this.now();
    const all = await listMatchFolders(this.dir);
    const recent = all.slice(-this.recentFolders);
    const newest = all.length ? all[all.length - 1] : null;
    // A new match folder ends the previous one right away.
    if (newest && newest !== this.currentDir) {
      const prev = this.currentDir && this.folders.get(this.currentDir);
      if (prev && !prev.ended) await this.endMatch(this.currentDir, 'newMatch');
      this.currentDir = newest;
    }
    let pendingIn = Infinity;
    for (const folder of recent) {
      const fst = this.folders.get(folder) || { lastChange: now, ended: false };
      this.folders.set(folder, fst);
      const recs = await this.listRecs(folder);
      for (const p of recs) {
        const s = recs.stats.get(p);
        const sig = `${s.size}|${s.mtimeMs}`;
        let e = this.files.get(p);
        if (!e) {
          e = { size: s.size, mtimeMs: s.mtimeMs, changedAt: now, doneSig: null, failedSig: null };
          this.files.set(p, e);
          fst.lastChange = now;
          fst.ended = false;
        } else if (e.size !== s.size || e.mtimeMs !== s.mtimeMs) {
          e.size = s.size;
          e.mtimeMs = s.mtimeMs;
          e.changedAt = now;
          fst.lastChange = now;
          fst.ended = false;
        }
        if (e.doneSig === sig || e.failedSig === sig || s.size === 0) continue;
        const wait = e.changedAt + this.stableMs - now;
        if (wait > 0) {
          pendingIn = Math.min(pendingIn, wait);
          continue;
        }
        try {
          const round = await parseRound(p, { cache: this.cache });
          e.doneSig = sig;
          const match = await parseMatchFolder(folder, { cache: this.cache });
          this.emit('round', { dir: folder, file: path.basename(p), round, match });
        } catch (err) {
          e.failedSig = sig;
          this.emit('parseError', { dir: folder, file: path.basename(p), error: err });
        }
      }
      // idle detection (only when nothing is still being written)
      if (!fst.ended && pendingIn === Infinity && now - fst.lastChange >= this.matchEndMs) {
        await this.endMatch(folder, 'idle');
      } else if (!fst.ended) {
        pendingIn = Math.min(pendingIn, Math.max(100, fst.lastChange + this.matchEndMs - now));
      }
    }
    clearTimeout(this.nextTimer);
    if (this.running && pendingIn !== Infinity) {
      this.nextTimer = setTimeout(() => this.tick(), pendingIn + 50);
      if (this.nextTimer.unref) this.nextTimer.unref();
    }
  }

  async endMatch(folder, reason) {
    const st = this.folders.get(folder);
    if (!st || st.ended) return;
    st.ended = true;
    try {
      const match = await parseMatchFolder(folder, { cache: this.cache });
      this.emit('matchEnd', { dir: folder, match, reason });
    } catch (err) {
      this.emit('parseError', { dir: folder, file: null, error: err });
    }
  }
}

function createWatcher(dir, opts) {
  return new R6Watcher(dir, opts);
}

module.exports = { R6Watcher, createWatcher };
