'use strict';
// Statsikka R6 replay reader (CommonJS, no dependencies).
// Parser is a port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan); see ./dissect/LICENSE.
//
//   parseRound(file, {cache?})        -> Promise<round JSON>
//   parseMatchFolder(dir, {cache?})   -> Promise<{dir, name, rounds, stats, errors, summary}>
//   summarizeMatch(matchOrRounds)     -> summary object | null (sync)
//   createWatcher(replayDir, opts?)   -> R6Watcher (EventEmitter; call .start(), .stop(), .scanAll())
//   findReplayDirs({extra?})          -> Promise<string[]>

const { parseRound, parseMatchFolder, listMatchFolders, ParseCache, defaultCache } = require('./parse');
const { summarizeMatch, aggregatePlayers, hsPercent, kd, kpr } = require('./summary');
const { createWatcher, R6Watcher } = require('./watcher');
const { findReplayDirs } = require('./locate');

module.exports = {
  parseRound,
  parseMatchFolder,
  summarizeMatch,
  createWatcher,
  findReplayDirs,
  // extras
  listMatchFolders,
  ParseCache,
  defaultCache,
  R6Watcher,
  helpers: { aggregatePlayers, hsPercent, kd, kpr },
};
