'use strict';
// Finds Rainbow Six Siege MatchReplay directories (Steam, Steam libraries, Ubisoft Connect).

const fs = require('fs');
const path = require('path');

const GAME = "Tom Clancy's Rainbow Six Siege";

async function isDir(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch (_) {
    return false;
  }
}

/** Extracts library paths from the text of Steam's libraryfolders.vdf. */
function parseLibraryFolders(text) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

/** Candidate MatchReplay paths (not checked for existence). Windows-centric. */
function candidatePaths(extra = []) {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [];
  const steamRoots = [path.join(pf86, 'Steam'), path.join(pf, 'Steam')];
  const ubiRoots = [path.join(pf86, 'Ubisoft', 'Ubisoft Game Launcher', 'games')];
  for (const d of ['D', 'E', 'F', 'G']) {
    steamRoots.push(`${d}:\\Steam`, `${d}:\\SteamLibrary`, `${d}:\\Program Files (x86)\\Steam`, `${d}:\\Program Files\\Steam`, `${d}:\\Games\\Steam`, `${d}:\\Games\\SteamLibrary`);
    ubiRoots.push(`${d}:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games`, `${d}:\\Ubisoft\\Ubisoft Game Launcher\\games`, `${d}:\\Games\\Ubisoft\\games`);
  }
  for (const s of steamRoots) roots.push(path.join(s, 'steamapps', 'common', GAME, 'MatchReplay'));
  for (const u of ubiRoots) roots.push(path.join(u, GAME, 'MatchReplay'));
  return [...extra, ...roots];
}

/**
 * Returns existing MatchReplay directories, most likely first (deduplicated).
 * Also follows Steam libraries listed in steamapps/libraryfolders.vdf and the
 * R6_REPLAY_DIR environment variable.
 * @param {{extra?: string[]}} [opts]
 * @returns {Promise<string[]>}
 */
async function findReplayDirs(opts = {}) {
  const extra = [...(opts.extra || [])];
  if (process.env.R6_REPLAY_DIR) extra.unshift(process.env.R6_REPLAY_DIR);
  const cands = candidatePaths(extra);
  // Steam libraries from libraryfolders.vdf
  const steamApps = new Set();
  for (const c of cands) {
    const i = c.toLowerCase().lastIndexOf(`${path.sep}steamapps${path.sep}`);
    if (i > 0) steamApps.add(c.slice(0, i + '\\steamapps'.length));
  }
  for (const sa of steamApps) {
    try {
      const txt = await fs.promises.readFile(path.join(sa, 'libraryfolders.vdf'), 'utf8');
      for (const lib of parseLibraryFolders(txt)) cands.push(path.join(lib, 'steamapps', 'common', GAME, 'MatchReplay'));
    } catch (_) {
      /* no such steam install */
    }
  }
  const seen = new Set();
  const found = [];
  for (const c of cands) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isDir(c)) found.push(path.resolve(c));
  }
  return found;
}

module.exports = { findReplayDirs, candidatePaths, parseLibraryFolders };
