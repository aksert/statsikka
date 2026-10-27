'use strict';
// Rainbow Six Siege: rank-pisteiden (RP) muutos per ranked-ottelu Arenyzen rank-historiasta (providers/arenyze.js parseHistory: [{ ts, rp, rank }]).
// Puhdasta logiikkaa (ei fs/electron-riippuvuuksia) -> testattavissa selftest.js:llä.
const stats = require('./r6-stats');

const MAX_LAG_MS = 3 * 60 * 60 * 1000;   // historiapiste kelpaa vain, jos se on enintään 3 h ottelun päättymisen jälkeen
const LAST_ROUND_MS = 4 * 60 * 1000;      // viimeisen kierroksen alusta ottelun loppuun (mitattu: tiedoston mtime on 0-8 min, keskimäärin ~3,5 min kierroksen alun jälkeen)
const MTIME_AGREE_MS = 20 * 60 * 1000;    // mtime hyväksytään vain, jos se vastaa paikallisaikaa tämän verran

// AIKALEIMAT: tallenteen sisäinen `timestamp` / `lastRoundTimestamp` on pelikoneen PAIKALLINEN kellonaika, vaikka loppuun on merkitty 'Z'
// (esim. kansio Match-2026-10-26_17-55-02 = klo 17.55 Suomen aikaa, tallenteen timestamp "2026-10-26T17:56:23Z" = oikea UTC olisi 15:56Z).
// Siksi Date.parse() antaa ajan, joka on UTC-eron (2-3 h) verran liian myöhäinen. Tässä Z ohitetaan ja merkkijono tulkitaan paikalliseksi
// (new Date(v, k, p, h, min, s) huomioi kesä- ja talviajan oikein). Tarkistettu oikeasta datasta (47 ottelua): mtime - paikallisena tulkittu
// lastRoundTimestamp = 0-8 min joka ottelulle, kun taas Date.parse(timestamp) - mtime = 80-180 min (= UTC-ero).
function localWallMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z?$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}

// Ottelun päättymisaika (ms, oikea UTC-epoch) tai 0. Luotettavin lähde on tallennetietueen lastMtime (tallennekansion uusimman
// tiedoston muokkausaika = viimeisen kierroksen loppu, käyttöjärjestelmän UTC-aikaa). Se hyväksytään, kun se täsmää paikallisaikana tulkittuun
// viimeisen kierroksen alkuun (+ ~4 min). Jos ne eroavat yli 20 min (esim. kansio kopioitu tai tiedostot koskettu myöhemmin) tai mtimea ei ole,
// käytetään paikallisaikana tulkittua viimeisen kierroksen alkua + ~4 min.
function matchEndMs(m, lastMtime) {
  const wall = localWallMs(m && (m.lastRoundTimestamp || m.timestamp));
  const est = Number.isFinite(wall) ? wall + LAST_ROUND_MS : NaN;
  const mt = Number(lastMtime);
  if (Number.isFinite(mt) && mt > 0 && (!Number.isFinite(est) || Math.abs(mt - est) <= MTIME_AGREE_MS)) return mt;
  return Number.isFinite(est) ? est : 0;
}

// matches: ottelun yhteenvedot (summary + name). history: [{ ts, rp }] (mielivaltainen järjestys). opts: { ownId, mtimes (nimi -> lastMtime), excludeName, maxLagMs }.
// Palauttaa Map: ottelun nimi -> { rpBefore, rpAfter, rpDelta } vain ranked-otteluille, joissa olit mukana.
// Sovitus: kahden peräkkäisen historiapisteen väli P(i-1) -> P(i). Jos välillä (P(i-1).ts, P(i).ts] päättyi täsmälleen yksi oma ranked-ottelu ja
// P(i) on enintään maxLagMs sen päättymisestä, delta = P(i).rp - P(i-1).rp. Useampi ottelu tai ei yhtään välillä -> ei deltaa (ei arvailua).
function attachRpDeltas(matches, history, opts = {}) {
  const out = new Map();
  const ownId = opts.ownId;
  const maxLag = Number.isFinite(opts.maxLagMs) ? opts.maxLagMs : MAX_LAG_MS;
  const pts = (Array.isArray(history) ? history : []).filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.rp)).slice().sort((a, b) => a.ts - b.ts);
  if (!ownId || pts.length < 2) return out;
  const mt = opts.mtimes || {};
  const ranked = [];
  for (const m of matches || []) {
    if (!m || !Array.isArray(m.players) || m.name === opts.excludeName) continue;
    if (stats.typeKey(m) !== 'ranked' || !stats.ownPlayer(m, ownId)) continue;
    const end = matchEndMs(m, mt instanceof Map ? mt.get(m.name) : mt[m.name]);
    if (end > 0) ranked.push({ name: m.name, end });
  }
  ranked.sort((a, b) => a.end - b.end);
  let j = 0;
  for (let i = 1; i < pts.length; i++) {
    const lo = pts[i - 1].ts, hi = pts[i].ts;
    while (j < ranked.length && ranked[j].end <= lo) j++;
    let k = j;
    while (k < ranked.length && ranked[k].end <= hi) k++;
    if (k - j !== 1) continue;
    const mm = ranked[j];
    if (hi - mm.end > maxLag) continue;
    out.set(mm.name, { rpBefore: pts[i - 1].rp, rpAfter: pts[i].rp, rpDelta: pts[i].rp - pts[i - 1].rp });
  }
  return out;
}

module.exports = { attachRpDeltas, matchEndMs, localWallMs, MAX_LAG_MS };
