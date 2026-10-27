'use strict';
// Rocket League Stats API:n käyttöönotto: ini-tiedoston muokkaus ja asennuksen etsintä.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../store');

const SECTION = 'TAGame.MatchStatsExporter_TA';
const KEYS = ['PacketSendRate', 'Port', 'WebPort'];

// ---- Puhdas ini-käsittely -----------------------------------------------

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : (text.includes('\n') ? '\n' : '\r\n');
}

function isSectionHeader(line) {
  const m = /^\s*\[(.+?)\]\s*$/.exec(line);
  return m ? m[1].trim() : null;
}

function keyOf(line) {
  const m = /^\s*([^=;#\s][^=]*?)\s*=/.exec(line);
  return m ? m[1].toLowerCase() : null;
}

// Palauttaa osion avainarvot (kuten tiedostossa, merkkijonoina).
function readSectionValues(text, section = SECTION) {
  const out = {};
  let inSec = false;
  for (const line of String(text).split(/\r?\n/)) {
    const h = isSectionHeader(line);
    if (h !== null) { inSec = h.toLowerCase() === section.toLowerCase(); continue; }
    if (!inSec) continue;
    const m = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Päivittää/lisää avaimet osioon säilyttäen muun sisällön.
function applyIniValues(text, values, section = SECTION) {
  const eol = detectEol(text);
  const src = String(text);
  let lines = src === '' ? [] : src.split(/\r?\n/);
  // Poista jäljellä oleva tyhjä loppurivi (split jättää sen kun teksti päättyy rivinvaihtoon)
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = isSectionHeader(lines[i]);
    if (h !== null && h.toLowerCase() === section.toLowerCase()) { start = i; break; }
  }
  const entries = Object.entries(values).map(([k, v]) => [k, String(v)]);

  if (start === -1) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`);
    for (const [k, v] of entries) lines.push(`${k}=${v}`);
    return lines.join(eol) + eol;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i]) !== null) { end = i; break; }
  }
  for (const [k, v] of entries) {
    let found = false;
    for (let i = start + 1; i < end; i++) {
      if (keyOf(lines[i]) === k.toLowerCase()) { lines[i] = `${k}=${v}`; found = true; }
    }
    if (!found) {
      // lisää osion viimeisen ei-tyhjän rivin jälkeen
      let at = end;
      while (at > start + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, `${k}=${v}`);
      end++;
    }
  }
  return lines.join(eol) + eol;
}

function buildSnippet(webPort, packetRate = 10, port = 49123) {
  return `[${SECTION}]\r\nPacketSendRate=${packetRate}\r\nPort=${port}\r\nWebPort=${webPort}\r\n`;
}

// ---- Tiedostojärjestelmä ------------------------------------------------

function decodeIni(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.slice(2).toString('utf16le'), enc: 'utf16le' };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.slice(3).toString('utf8'), enc: 'utf8bom' };
  return { text: buf.toString('utf8'), enc: 'utf8' };
}
function encodeIni(text, enc) {
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

function configDirOf(dir) { return path.join(dir, 'TAGame', 'Config'); }

// Mikä tiedosto muokataan: TAStatsAPI.ini jos on, muuten DefaultStatsAPI.ini.
function targetIniFile(dir) {
  const cfg = configDirOf(dir);
  const ta = path.join(cfg, 'TAStatsAPI.ini');
  if (fs.existsSync(ta)) return ta;
  return path.join(cfg, 'DefaultStatsAPI.ini');
}

function inspectInstall(dir) {
  const valid = fs.existsSync(path.join(dir, 'TAGame'));
  const file = valid ? targetIniFile(dir) : null;
  let values = {};
  let fileExists = false;
  if (file && fs.existsSync(file)) {
    fileExists = true;
    try { values = readSectionValues(decodeIni(fs.readFileSync(file)).text); } catch (_) { /* ei oikeuksia */ }
  }
  return { dir, valid, file, fileExists, values };
}

function enableInstall(dir, webPort) {
  const info = inspectInstall(dir);
  const snippet = buildSnippet(webPort);
  if (!info.valid) return { ok: false, code: 'INVALID_DIR', message: 'Kansiosta ei löydy TAGame-kansiota.', snippet, file: null };
  const file = info.file;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = '';
    let enc = 'utf8';
    let backup = null;
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      const dec = decodeIni(raw);
      text = dec.text; enc = dec.enc;
      backup = `${file}.bak`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw); // säilytä alkuperäinen
    }
    const next = applyIniValues(text, { PacketSendRate: 10, Port: 49123, WebPort: webPort });
    writeFileAtomic(file, encodeIni(next, enc));
    return { ok: true, file, backup, values: readSectionValues(next) };
  } catch (e) {
    const code = e && e.code ? e.code : 'ERROR';
    return { ok: false, code, message: e && e.message ? e.message : String(e), snippet, file };
  }
}

// ---- Asennuksen etsintä -------------------------------------------------

function parseLibraryFolders(vdfText) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(vdfText))) !== null) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

function candidateDirs(env = process.env, exists = fs.existsSync, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const list = [
    'C:\\Program Files\\Epic Games\\rocketleague',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague',
    'D:\\SteamLibrary\\steamapps\\common\\rocketleague',
  ];
  const pf = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432']].filter(Boolean);
  const steamRoots = new Set(['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']);
  for (const p of pf) {
    list.push(path.join(p, 'Epic Games', 'rocketleague'));
    steamRoots.add(path.join(p, 'Steam'));
  }
  for (const letter of ['C', 'D', 'E', 'F', 'G']) {
    list.push(`${letter}:\\Epic Games\\rocketleague`);
    list.push(`${letter}:\\Games\\Epic Games\\rocketleague`);
    list.push(`${letter}:\\SteamLibrary\\steamapps\\common\\rocketleague`);
    list.push(`${letter}:\\Steam\\steamapps\\common\\rocketleague`);
  }
  for (const root of steamRoots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    try {
      if (!exists(vdf)) continue;
      for (const lib of parseLibraryFolders(readFile(vdf))) {
        list.push(path.join(lib, 'steamapps', 'common', 'rocketleague'));
      }
    } catch (_) { /* ohita */ }
  }
  const seen = new Set();
  return list.filter((d) => { const k = path.normalize(d).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function detectInstalls() {
  return candidateDirs()
    .filter((d) => { try { return fs.existsSync(path.join(d, 'TAGame')); } catch (_) { return false; } })
    .map(inspectInstall);
}

module.exports = {
  SECTION, KEYS, readSectionValues, applyIniValues, buildSnippet,
  inspectInstall, enableInstall, parseLibraryFolders, candidateDirs, detectInstalls, targetIniFile,
};
