'use strict';
// Rainbow Six Siege: käsin syötettyjen lukujen arvio (R6 > Pelaajan tarkistus). Verkkohakua ei ole (search/getProfile eivät ole käytössä).
// Varsinainen data tulee pelin omista ottelutallenteista: ks. ../r6-service.js (palvelu), ../r6-stats.js (koosteet) ja ../r6/ (jäsennin).

const S = require('../suspicion');

const AVAILABLE = false;
const REASON = 'Datalähdettä ei ole vielä kytketty.';

// Epätavallisten tilastojen arvio normalisoidusta syötteestä { kd, hsPercent, winrate, matches, kills, killsPerRound?, level?, rank? }.
// Myöhemmin kytkettävä datalähde palauttaa saman muodon ja kutsuu tätä; nyt luvut syötetään käsin (renderer/r6-check.js).
function assess(stats) { return S.evaluateR6(stats); }

function createR6() {
  const unavailable = async () => { throw new Error(REASON); };
  return { available: AVAILABLE, search: unavailable, getProfile: unavailable, assess };
}

module.exports = { createR6, assess, AVAILABLE, REASON };
