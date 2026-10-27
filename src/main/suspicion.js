'use strict';
// "Epätavalliset tilastot" -indikaattori (vain Overwatch 2). Puhdas moduuli: ei Electron-riippuvuuksia.
// Heuristiikka julkisista tilastoista, EI todiste huijaamisesta. Kaikki rajat ovat THRESHOLDS-taulukossa.

const THRESHOLDS = Object.freeze({
  // Otoksen vähimmäiskoko; sen alapuolella tasoa ei arvioida.
  minGames: 20,
  minTimeSeconds: 2 * 3600,
  // Tasorajat pistemäärälle. Tiukka laskee rajoja yhdellä.
  levels: Object.freeze({
    normal: Object.freeze({ watch: 2, suspicious: 4 }),
    strict: Object.freeze({ watch: 1, suspicious: 3 }),
  }),
  // Final blowseja kuolemaa kohti (kaikki hahmot, vähintään 20 peliä). Korkein täyttyvä taso.
  finalBlowsPerDeath: Object.freeze({ minGames: 20, tiers: Object.freeze([{ min: 2.0, weight: 1 }, { min: 3.0, weight: 2 }]) }),
  // Tapot / kuolemat (kaikki hahmot, vähintään 20 peliä).
  kd: Object.freeze({ minGames: 20, tiers: Object.freeze([{ min: 4.0, weight: 1 }, { min: 5.5, weight: 2 }]) }),
  // Voitto-% (mahdollinen smurffi).
  winrate: Object.freeze({ minGames: 30, min: 75, weight: 1 }),
  // Hitscan-hahmot: kriittisten osumien tarkkuus (%) ja aseen tarkkuus (%). null = ei käytössä.
  // Raja ylittyy -> paino 1; ylitys vähintään strongRelative-kertoimella -> paino 2.
  hitscan: Object.freeze({
    minHeroSeconds: 3600,   // hahmoa pitää olla pelattu vähintään tunti
    top: 3,                 // vain 3 eniten pelattua hitscan-hahmoa
    strongRelative: 1.25,   // +25 % rajasta
    heroes: Object.freeze({
      widowmaker: Object.freeze({ crit: 50, weapon: 70 }),
      ashe: Object.freeze({ crit: 40, weapon: 70 }),
      cassidy: Object.freeze({ crit: 30, weapon: 65 }),
      'soldier-76': Object.freeze({ crit: 25, weapon: 60 }),
      sojourn: Object.freeze({ crit: 30, weapon: 60 }),
      tracer: Object.freeze({ crit: 20, weapon: 55 }),
      sombra: Object.freeze({ crit: 20, weapon: 55 }),
      bastion: Object.freeze({ crit: 15, weapon: 60 }),
      baptiste: Object.freeze({ crit: 20, weapon: 55 }),
      ana: Object.freeze({ crit: null, weapon: 75 }),
    }),
  }),
});

// Rainbow Six Siege: ei datalähdettä, luvut syötetään käsin (tai tuleva lähde syöttää ne providers/r6.js:n kautta).
// Sama pisteytys ja tasorajat (THRESHOLDS.levels) kuin OW:lla.
const R6_THRESHOLDS = Object.freeze({
  minMatches: 30,   // pienin otos, jolla mitään arvioidaan (alle: sampleOk false)
  kd: Object.freeze({ minMatches: 50, tiers: Object.freeze([{ min: 2.0, weight: 1 }, { min: 3.0, weight: 2 }]) }),
  headshot: Object.freeze({ minKills: 100, tiers: Object.freeze([{ min: 60, weight: 1 }, { min: 75, weight: 2 }]) }),
  winrate: Object.freeze({ minMatches: 30, min: 75, weight: 1 }),
  killsPerRound: Object.freeze({ min: 1.3, weight: 1 }),   // valinnainen
  smurfLevel: Object.freeze({ maxLevel: 49, minRankIndex: 6, weight: 1 }), // taso < 50 ja rank Diamond+ (indeksi R6_RANKS-taulukossa)
});
const R6_RANKS = Object.freeze(['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Champion']);

// Rainbow Six Siege: arvio omista ottelutallenteista (replay) kertyneistä pelaajakohtaisista summista.
// Eri otoskoot kuin käsin syötetyssä tarkistuksessa: tallenteita on vähän, mutta ne ovat tarkkoja.
const R6_REPLAY_THRESHOLDS = Object.freeze({
  headshot: Object.freeze({ minKills: 20, tiers: Object.freeze([{ min: 65, weight: 1 }, { min: 80, weight: 2 }]) }),
  kd: Object.freeze({ minMatches: 3, minRounds: 15, tiers: Object.freeze([{ min: 2.5, weight: 1 }, { min: 4.0, weight: 2 }]) }),
  killsPerRound: Object.freeze({ minRounds: 15, tiers: Object.freeze([{ min: 1.3, weight: 1 }, { min: 1.8, weight: 2 }]) }),
  // Yksittäinen ottelu: HS-% ≥ 85 vähintään 8 tapolla TAI vähintään 12 tappoa enintään 6 kierroksessa.
  singleMatch: Object.freeze({ hsMin: 85, hsMinKills: 8, killsMin: 12, maxRounds: 6, weight: 1 }),
});

const SENSITIVITIES = ['off', 'normal', 'strict'];
const NO_SAMPLE_TEXT = 'liian vähän pelejä arvioon';
const HERO_NAMES = { 'soldier-76': 'Soldier: 76' };

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function firstNum(...vals) {
  for (const v of vals) { const n = num(v); if (n !== null) return n; }
  return null;
}
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
const f0 = (n) => String(Math.round(n));

function heroLabel(key, profile) {
  const hit = profile && Array.isArray(profile.heroes) ? profile.heroes.find((x) => x.key === key) : null;
  if (hit && hit.name) return hit.name;
  if (HERO_NAMES[key]) return HERO_NAMES[key];
  return String(key).split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function tierWeight(value, tiers) {
  let hit = null;
  for (const t of tiers) if (value >= t.min) hit = t;
  return hit;
}

// Kolme eniten pelattua hitscan-hahmoa (>= 1 h) tarkkuuslukuineen. Rivit palautetaan peliajan mukaan laskevasti.
function topHitscan(career, cfg = THRESHOLDS.hitscan) {
  if (!career || typeof career !== 'object') return [];
  const rows = [];
  for (const [key, lim] of Object.entries(cfg.heroes)) {
    const hero = career[key];
    if (!hero || typeof hero !== 'object') continue;
    const timePlayed = firstNum(hero.game && hero.game.time_played);
    if (timePlayed === null || timePlayed < cfg.minHeroSeconds) continue;
    const crit = lim.crit === null ? null : firstNum(hero.combat && hero.combat.critical_hit_accuracy);
    const weapon = firstNum(hero.combat && hero.combat.weapon_accuracy);
    const ratio = (v, l) => (v !== null && l !== null && l > 0 ? v / l : null);
    const critRatio = ratio(crit, lim.crit);
    const weaponRatio = ratio(weapon, lim.weapon);
    const critOver = critRatio !== null && crit > lim.crit;
    const weaponOver = weaponRatio !== null && weapon > lim.weapon;
    let weight = 0;
    if (critOver || weaponOver) {
      const strong = (critOver && critRatio >= cfg.strongRelative) || (weaponOver && weaponRatio >= cfg.strongRelative);
      weight = strong ? 2 : 1;
    }
    rows.push({
      key, timePlayed, games: firstNum(hero.game && hero.game.games_played) || 0,
      crit, weapon, critLimit: lim.crit, weaponLimit: lim.weapon, critOver, weaponOver, critRatio, weaponRatio, weight,
    });
  }
  rows.sort((a, b) => b.timePlayed - a.timePlayed);
  return rows.slice(0, cfg.top);
}

// Pistemäärästä taso valitulla herkkyydellä. Tuntematon herkkyys = normaali.
function levelFor(score, sensitivity) {
  const c = THRESHOLDS.levels[sensitivity] || THRESHOLDS.levels.normal;
  return score >= c.suspicious ? 'suspicious' : score >= c.watch ? 'watch' : 'none';
}

// Normalisoidusta profiilista (providers/ow.normalizeProfile) + raakadatasta (stats/career) -> arvio normaalilla herkkyydellä.
// Palauttaa null, jos dataa ei ole lainkaan (yksityinen profiili).
function evaluate(profile, career) {
  const tiles = profile && profile.tiles ? profile.tiles : null;
  const all = career && career['all-heroes'] ? career['all-heroes'] : null;
  if (!tiles && !all) return null;
  const comb = (all && all.combat) || {};
  const gm = (all && all.game) || {};
  const games = firstNum(tiles && tiles.games, gm.games_played) || 0;
  const timePlayed = firstNum(gm.time_played, tiles && tiles.timePlayed);
  const elims = firstNum(comb.eliminations, tiles && tiles.eliminations);
  const deaths = firstNum(comb.deaths, tiles && tiles.deaths);
  const finals = firstNum(comb.final_blows);
  const winrate = firstNum(tiles && tiles.winrate, games > 0 && num(gm.games_won) !== null ? (gm.games_won / games) * 100 : null);

  const sampleOk = games >= THRESHOLDS.minGames && (timePlayed === null || timePlayed >= THRESHOLDS.minTimeSeconds);
  if (!sampleOk) {
    return { level: 'none', score: 0, reasons: [{ text: NO_SAMPLE_TEXT, value: games, threshold: THRESHOLDS.minGames, weight: 0 }], sampleOk: false, sensitivity: 'normal' };
  }

  const reasons = [];
  if (finals !== null && deaths !== null && deaths > 0) {
    const v = finals / deaths;
    const t = games >= THRESHOLDS.finalBlowsPerDeath.minGames ? tierWeight(v, THRESHOLDS.finalBlowsPerDeath.tiers) : null;
    if (t) reasons.push({ kind: 'finalBlows', text: `Final blowseja kuolemaa kohti ${f2(v)} (raja ${f2(t.min)})`, value: Math.round(v * 100) / 100, threshold: t.min, weight: t.weight });
  }
  if (elims !== null && deaths !== null && deaths > 0) {
    const v = elims / deaths;
    const t = games >= THRESHOLDS.kd.minGames ? tierWeight(v, THRESHOLDS.kd.tiers) : null;
    if (t) reasons.push({ kind: 'kd', text: `Tapot / kuolemat (K/D) ${f2(v)} (raja ${f2(t.min)})`, value: Math.round(v * 100) / 100, threshold: t.min, weight: t.weight });
  }
  for (const r of topHitscan(career)) {
    if (!r.weight) continue;
    const parts = [];
    let value = null, threshold = null, worst = 0;
    if (r.critOver) { parts.push(`kriittiset ${f1(r.crit)} % (raja ${f0(r.critLimit)} %)`); if (r.critRatio > worst) { worst = r.critRatio; value = r.crit; threshold = r.critLimit; } }
    if (r.weaponOver) { parts.push(`aseen tarkkuus ${f1(r.weapon)} % (raja ${f0(r.weaponLimit)} %)`); if (r.weaponRatio > worst) { worst = r.weaponRatio; value = r.weapon; threshold = r.weaponLimit; } }
    reasons.push({ kind: 'hitscan', hero: r.key, text: `${heroLabel(r.key, profile)}: ${parts.join(', ')}`, value, threshold, weight: r.weight });
  }
  if (winrate !== null && games >= THRESHOLDS.winrate.minGames && winrate >= THRESHOLDS.winrate.min) {
    reasons.push({ kind: 'smurf', text: `Voitto-% ${f1(winrate)} % ${games} pelissä (mahdollinen smurffi)`, value: Math.round(winrate * 10) / 10, threshold: THRESHOLDS.winrate.min, weight: THRESHOLDS.winrate.weight });
  }

  const score = reasons.reduce((a, r) => a + r.weight, 0);
  return { level: levelFor(score, 'normal'), score, reasons, sampleOk: true, sensitivity: 'normal' };
}

function r6RankIndex(rank) {
  if (typeof rank !== 'string') return -1;
  return R6_RANKS.findIndex((r) => r.toLowerCase() === rank.trim().toLowerCase());
}

// R6-syötteen tiukka validointi (IPC). Vain matches on pakollinen; muut kentät ovat valinnaisia (puuttuva = sääntöä ei arvioida).
// Palauttaa { value } tai { error }.
function validateR6Input(arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return { error: 'Virheellinen syöte.' };
  const allowed = ['kd', 'hsPercent', 'winrate', 'matches', 'kills', 'killsPerRound', 'level', 'rank'];
  for (const k of Object.keys(arg)) if (!allowed.includes(k)) return { error: `Tuntematon kenttä: ${k}.` };
  const out = {};
  const field = (key, label, lo, hi, int, required) => {
    const v = arg[key];
    if (v === undefined || v === null || v === '') { if (required) return `${label} puuttuu.`; out[key] = null; return null; }
    if (typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) return `${label}: virheellinen arvo.`;
    const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) return `${label}: anna ${int ? 'kokonaisluku' : 'luku'} väliltä ${lo}–${hi}.`;
    out[key] = n; return null;
  };
  const errs = [
    field('matches', 'Ottelut', 0, 100000, true, true), field('kd', 'K/D', 0, 20, false), field('hsPercent', 'HS-%', 0, 100, false),
    field('winrate', 'Voitto-%', 0, 100, false), field('kills', 'Tapot', 0, 10000000, true), field('killsPerRound', 'Tappoja/kierros', 0, 5, false),
    field('level', 'Taso', 0, 9999, true),
  ].filter(Boolean);
  if (errs.length) return { error: errs[0] };
  const rank = arg.rank;
  if (rank === undefined || rank === null || rank === '') out.rank = null;
  else if (typeof rank !== 'string' || r6RankIndex(rank) < 0) return { error: 'Rank: valitse Copper–Champion.' };
  else out.rank = R6_RANKS[r6RankIndex(rank)];
  return { value: out };
}

// R6: normalisoidusta syötteestä { kd, hsPercent, winrate, matches, kills, killsPerRound?, level?, rank? } arvio normaaliherkkyydellä.
function evaluateR6(input) {
  const T = R6_THRESHOLDS;
  const g = (k) => (input ? num(input[k]) : null);
  const matches = g('matches') || 0;
  const kd = g('kd'), hs = g('hsPercent'), wr = g('winrate'), kills = g('kills'), kpr = g('killsPerRound'), level = g('level');
  const rankIdx = r6RankIndex(input && input.rank);
  if (matches < T.minMatches) {
    return { level: 'none', score: 0, reasons: [{ text: NO_SAMPLE_TEXT, value: matches, threshold: T.minMatches, weight: 0 }], sampleOk: false, sensitivity: 'normal' };
  }
  const reasons = [];
  if (kd !== null && matches >= T.kd.minMatches) {
    const t = tierWeight(kd, T.kd.tiers);
    if (t) reasons.push({ kind: 'kd', text: `K/D ${f2(kd)} (raja ${f2(t.min)})`, value: kd, threshold: t.min, weight: t.weight });
  }
  if (hs !== null && kills !== null && kills >= T.headshot.minKills) {
    const t = tierWeight(hs, T.headshot.tiers);
    if (t) reasons.push({ kind: 'headshot', text: `Headshot-% ${f1(hs)} % (raja ${f0(t.min)} %)`, value: hs, threshold: t.min, weight: t.weight });
  }
  if (wr !== null && matches >= T.winrate.minMatches && wr >= T.winrate.min) {
    reasons.push({ kind: 'smurf', text: `Voitto-% ${f1(wr)} % ${matches} ottelussa (mahdollinen smurffi)`, value: wr, threshold: T.winrate.min, weight: T.winrate.weight });
  }
  if (kpr !== null && kpr >= T.killsPerRound.min) {
    reasons.push({ kind: 'killsPerRound', text: `Tappoja per kierros ${f2(kpr)} (raja ${f2(T.killsPerRound.min)})`, value: kpr, threshold: T.killsPerRound.min, weight: T.killsPerRound.weight });
  }
  if (level !== null && rankIdx >= T.smurfLevel.minRankIndex && level <= T.smurfLevel.maxLevel) {
    reasons.push({ kind: 'smurf', text: `Matala taso (${f0(level)}) ja korkea rank (${R6_RANKS[rankIdx]}): mahdollinen smurffi`, value: level, threshold: T.smurfLevel.maxLevel + 1, weight: T.smurfLevel.weight });
  }
  const score = reasons.reduce((a, r) => a + r.weight, 0);
  return { level: levelFor(score, 'normal'), score, reasons, sampleOk: true, sensitivity: 'normal' };
}

// R6 (replay): agg = { matches, rounds, kills, deaths, headshots, match?: { kills, headshots, rounds } }.
// Kokonaisluvut (matches/rounds/kills/...) ovat pelaajan kaikista tallenteista; `match` on valinnainen yksittäisen ottelun luvut.
// Samat tasorajat ja herkkyys kuin evaluateR6:lla (pisteet -> levelFor / withSensitivity).
function evaluateR6ReplayBase(agg) {
  const T = R6_REPLAY_THRESHOLDS;
  const g = (k) => (agg ? num(agg[k]) : null) || 0;
  const matches = g('matches'), rounds = g('rounds'), kills = g('kills'), deaths = g('deaths'), headshots = g('headshots');
  const m = agg && agg.match && typeof agg.match === 'object' ? agg.match : null;
  const mk = m ? num(m.kills) || 0 : 0, mh = m ? num(m.headshots) || 0 : 0, mr = m ? num(m.rounds) || 0 : 0;

  const hsGate = kills >= T.headshot.minKills;
  const kdGate = deaths >= 0 && (matches >= T.kd.minMatches || rounds >= T.kd.minRounds);
  const kprGate = rounds >= T.killsPerRound.minRounds;
  const hsMatch = mk >= T.singleMatch.hsMinKills && (mh / mk) * 100 >= T.singleMatch.hsMin;
  const fastMatch = mk >= T.singleMatch.killsMin && mr > 0 && mr <= T.singleMatch.maxRounds;
  const single = hsMatch || fastMatch;

  if (!hsGate && !kdGate && !kprGate && !single) {
    return { level: 'none', score: 0, reasons: [{ text: NO_SAMPLE_TEXT, value: matches, threshold: T.kd.minMatches, weight: 0 }], sampleOk: false, sensitivity: 'normal', source: 'replay' };
  }
  const reasons = [];
  if (hsGate) {
    const hs = (headshots / kills) * 100;
    const t = tierWeight(hs, T.headshot.tiers);
    if (t) reasons.push({ kind: 'headshot', text: `Headshot-% ${f1(hs)} % ${kills} tapossa (raja ${f0(t.min)} %)`, value: Math.round(hs * 10) / 10, threshold: t.min, weight: t.weight });
  }
  if (kdGate && kills > 0) {
    const kdv = deaths > 0 ? kills / deaths : kills;
    const t = tierWeight(kdv, T.kd.tiers);
    if (t) reasons.push({ kind: 'kd', text: `K/D ${f2(kdv)} (raja ${f2(t.min)}), ${matches} ottelua ja ${rounds} kierrosta`, value: Math.round(kdv * 100) / 100, threshold: t.min, weight: t.weight });
  }
  if (kprGate) {
    const k = kills / rounds;
    const t = tierWeight(k, T.killsPerRound.tiers);
    if (t) reasons.push({ kind: 'killsPerRound', text: `Tappoja per kierros ${f2(k)} (raja ${f2(t.min)}), ${rounds} kierrosta`, value: Math.round(k * 100) / 100, threshold: t.min, weight: t.weight });
  }
  if (hsMatch) {
    const hs = (mh / mk) * 100;
    reasons.push({ kind: 'singleMatch', text: `Tämä ottelu: headshot-% ${f1(hs)} % ${mk} tapossa (raja ${f0(T.singleMatch.hsMin)} %)`, value: Math.round(hs * 10) / 10, threshold: T.singleMatch.hsMin, weight: T.singleMatch.weight });
  } else if (fastMatch) {
    reasons.push({ kind: 'singleMatch', text: `Tämä ottelu: ${mk} tappoa ${mr} kierroksessa (raja ${T.singleMatch.killsMin} tappoa enintään ${T.singleMatch.maxRounds} kierroksessa)`, value: mk, threshold: T.singleMatch.killsMin, weight: T.singleMatch.weight });
  }
  const score = reasons.reduce((a, r) => a + r.weight, 0);
  return { level: levelFor(score, 'normal'), score, reasons, sampleOk: true, sensitivity: 'normal', source: 'replay' };
}

// sensitivity pois = normaali arvio (kuten evaluateR6); annettuna sovelletaan withSensitivity() ('off' -> null).
function evaluateR6Replay(agg, sensitivity) {
  const r = evaluateR6ReplayBase(agg);
  return sensitivity === undefined ? r : withSensitivity(r, sensitivity);
}

// Soveltaa käyttäjän herkkyyttä valmiiseen arvioon. 'off' -> null (indikaattori piilotetaan).
function withSensitivity(result, sensitivity) {
  if (!result) return null;
  if (sensitivity === 'off') return null;
  const s = sensitivity === 'strict' ? 'strict' : 'normal';
  if (!result.sampleOk) return { ...result, sensitivity: s };
  return { ...result, level: levelFor(result.score, s), sensitivity: s };
}

module.exports = { THRESHOLDS, R6_THRESHOLDS, R6_REPLAY_THRESHOLDS, R6_RANKS, SENSITIVITIES, NO_SAMPLE_TEXT, evaluate, evaluateR6, evaluateR6Replay, validateR6Input, withSensitivity, levelFor, topHitscan };
