'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.

const { Reader, DissectError } = require('./reader');
const { roundToJSON, playerStats, matchPlayerStats, headshotPercentage } = require('./stats');
const tables = require('./tables');
const { formatClock, parseClock } = require('./time');

/** Synchronously parses the contents of one .rec file. Returns the round JSON (+ `errors`). */
function parseBuffer(buf) {
  const r = new Reader(buf);
  r.read();
  const out = roundToJSON(r);
  out.errors = r.errors;
  return out;
}

module.exports = { parseBuffer, Reader, DissectError, tables, playerStats, matchPlayerStats, headshotPercentage, formatClock, parseClock };
