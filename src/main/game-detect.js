'use strict';
// Peliprosessien tunnistus (tasklist, ei natiivimoduuleja) ja pelikohtainen tilakone: pois -> käynnissä -> ottelu.
// Tunnistus ei koskaan avaa ikkunoita (windowsHide) eikä tuo sovellusikkunaa esiin.
const { execFile } = require('child_process');

const GAMES = ['r6', 'ow', 'rl'];
const PROCESSES = {
  r6: ['rainbowsix.exe', 'rainbowsix_vulkan.exe'],
  ow: ['overwatch.exe'],
  rl: ['rocketleague.exe'],
};
const POLL_MS = 5000;

// `tasklist /FO CSV /NH` -> Set pienellä kirjoitetuista kuvanimistä.
function parseTasklist(csv) {
  const names = new Set();
  for (const line of String(csv || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^"((?:[^"]|"")*)"/.exec(t);
    if (m) names.add(m[1].replace(/""/g, '"').toLowerCase());
  }
  return names;
}
function stateFromNames(names) {
  const out = {};
  for (const g of GAMES) out[g] = PROCESSES[g].some((p) => names.has(p));
  return out;
}
function runTasklist() {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Tilakone. Vaihe: 'off' (peli ei käynnissä) -> 'running' (peli käynnissä) -> 'match' (ottelu käynnissä).
// Ottelu päättyy kun peli sulkeutuu tai matchEnded kutsutaan. onChange(snapshot) kutsutaan jokaisesta muutoksesta.
function createGameTracker(onChange) {
  const st = {};
  for (const g of GAMES) st[g] = { running: false, match: false, matchId: null };
  const snap = () => ({
    r6: st.r6.running, ow: st.ow.running, rl: st.rl.running,
    match: { r6: st.r6.match, ow: st.ow.match, rl: st.rl.match },
  });
  const emit = () => { if (onChange) onChange(snap()); };
  return {
    snapshot: snap,
    phase(g) { return !st[g].running ? 'off' : st[g].match ? 'match' : 'running'; },
    setRunning(g, running) {
      const s = st[g];
      running = !!running;
      if (s.running === running) return false;
      s.running = running;
      if (!running) { s.match = false; s.matchId = null; }
      emit();
      return true;
    },
    // id = ottelun tunniste (RL: MatchGuid, R6: kansion nimi). Sama id uudelleen ei ole uusi alku. Palauttaa true, kun ottelu alkoi uutena.
    matchStarted(g, id) {
      const s = st[g];
      const key = id == null ? '' : String(id);
      if (s.match && s.matchId === key) return false;
      s.running = true; s.match = true; s.matchId = key;
      emit();
      return true;
    },
    matchEnded(g) {
      const s = st[g];
      if (!s.match) return false;
      s.match = false; s.matchId = null;
      emit();
      return true;
    },
  };
}

// Tunnistin: kysyy prosessit 5 s välein. inject() ohittaa kyselyn (savutesti; oikeita pelejä ei käynnistetä).
function createDetector({ run = runTasklist, intervalMs = POLL_MS, onState } = {}) {
  let timer = null;
  let injected = false;
  let busy = false;
  let last = { r6: false, ow: false, rl: false };
  let lastError = '';
  const apply = (s) => { last = s; if (onState) onState(s); };
  async function poll() {
    if (injected || busy) return;
    busy = true;
    try { const names = parseTasklist(await run()); if (!injected) apply(stateFromNames(names)); lastError = ''; } catch (e) { lastError = e && e.message ? e.message : String(e); } finally { busy = false; }
  }
  return {
    poll,
    start() { if (timer) return; poll(); timer = setInterval(poll, intervalMs); if (timer.unref) timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    inject(partial) { injected = true; apply({ ...last, ...partial }); },
    release() { injected = false; },
    get: () => ({ ...last }),
    error: () => lastError,
  };
}

module.exports = { GAMES, PROCESSES, POLL_MS, parseTasklist, stateFromNames, createGameTracker, createDetector, runTasklist };
