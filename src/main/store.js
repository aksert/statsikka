'use strict';
// JSON-tallennus: atominen kirjoitus (väliaikainen tiedosto + rename).
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(txt);
  } catch (_) {
    return fallback;
  }
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ei väliä */ }
    throw e;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

module.exports = { readJson, writeJsonAtomic, writeFileAtomic };
