'use strict';
// Rainbow Six Siege: edistyneet kierrostilastot ottelutallenteen kierroksista (KOST, entry, tradet, clutchit, multikillit, plantit/purut).
// Puhdasta logiikkaa (ei fs/electron-riippuvuuksia). Syöte: jäsennetyt kierrokset (parseRound-JSON: players, teams, matchFeedback, matchType).
// Kierrosten tulkinta ei muuta jäsennintä: kaikki johdetaan tappofeedistä (Kill / Death / DefuserPlantComplete / DefuserDisableComplete).
//
// Määritelmät (yksi kierros, yksi pelaaja):
//  - Tappo: vihollisen tappo (tappaja ja kohde rosterissa eri tiimeissä tai kohde tuntematon). Tiimitappo, itsemurha ja
//    tuntemattoman tappajan tappo eivät ole tappoja; tiimitapon uhri silti kuolee (elossa-laskuri ja selviytyminen).
//  - Entry: kierroksen ensimmäinen vihollisen tappo; tappaja saa entry-tapon, uhri entry-kuoleman. Itsemurha tms. ei ole entry.
//  - Trade: tappo on trade-tappo, jos tapettu oli tappanut tappajan tiimikaverin enintään TRADE_WINDOW_S sekuntia aiemmin
//    (kierroskello laskee alaspäin). Tiimikaverin kuolema on tradattu kuolema (jokainen sillä ikkunalla tapetuista uhreista);
//    trade-tappo lasketaan kerran tappoa kohti. Kello-oikuissa (aika kasvaa) ei tulkita tradeksi.
//  - Selviytyi: ei kuollut kierroksella. Objektiivi: asensi (plant) tai purki (defuse) defuserin. Tekijä hyväksytään vain, jos
//    samalla pelaajalla on aiempi DefuserPlantStart / DefuserDisableStart -tapahtuma samalla kierroksella (vanha jäsennin
//    arvasi tekijäksi rosterin ensimmäisen pelaajan eikä tuottanut Start-tapahtumia; Y11S3-jäsennin tunnistaa tekijän
//    pelaajahahmon kautta, ks. dissect/defuse.js, ja tuottaa Start-tapahtuman vain tunnistetulle tekijälle), tekijän tiimin
//    rooli ei ole väärä ja tekijä on elossa (ei kuollut aiemmin feedissä); purku vaatii lisäksi, että tiimi voitti kierroksen.
//    Tunnistamattomat asennukset/purut lasketaan kierroskohtaisesti (ou), mutta eivät kuulu kenellekään.
//  - Kello: asennuksen jälkeen kello voi näyttää pommin laskuria, eikä tapahtumien järjestys ole asennuksen kohdalla varma,
//    joten trade tunnistetaan vain saman vaiheen (ennen / jälkeen asennuksen) tapahtumien välillä.
//  - KOST-kierros: Tappo TAI Objektiivi TAI Selviytyi TAI Tradattu kuolema. KOST % = KOST-kierrokset / kierrokset.
//  - 1vX clutch: pelaaja jää tiiminsä viimeiseksi eläväksi, kun vastustajia on vielä X >= 1 elossa (tiimillä enintään yksi
//    clutch kierroksella; X rajataan 5:een). Voitto = tiimi voitti kierroksen. Kierros ilman tunnettua voittajaa ei lasketa.
//  - Multikill: vihollistappoja kierroksella 2 / 3 / 4 / 5+ (ace).
// Ohitetut kierrokset: TeamDeathmatch (ei pommikierroksia), kierros ilman Kill/Death/defuser-tapahtumia (tallenne puutteellinen)
// ja kierros ilman kelvollista rosteria. Ylipitkät (overtime) kierrokset käsitellään tavallisina kierroksina.

const TRADE_WINDOW_S = 10;
const ADV_VERSION = 2; // 2: asennus/purku tunnistetaan Y11S3-tallenteista (aiemmin aina 0)
const MAX_X = 5;
const TDM_MATCH_TYPE = 13;

const round1 = (n) => Math.round(n * 10) / 10;
const typeName = (e) => (e && e.type ? e.type.name : '');

function isTdm(rd) {
  const mt = rd && rd.matchType;
  const gm = rd && rd.gamemode;
  return !!((mt && (mt.id === TDM_MATCH_TYPE || /deathmatch/i.test(String(mt.name || '')))) || (gm && /deathmatch/i.test(String(gm.name || ''))));
}

// Voittajatiimi (0/1) tai -1. Ensisijainen lähde on pistetilanne (score > startingScore): jäsennin merkitsee `won`-lipun
// molemmille tiimeille kierroksilla, joilla joku asensi defuserin ja asentajatiimi hävisi, joten lippu yksin ei riitä.
function winnerOf(rd) {
  const t = (rd && rd.teams) || [];
  const gain = (x) => (x && Number.isFinite(x.score) && Number.isFinite(x.startingScore) ? x.score - x.startingScore : 0);
  const g0 = gain(t[0]), g1 = gain(t[1]);
  if (g0 > 0 && g1 <= 0) return 0;
  if (g1 > 0 && g0 <= 0) return 1;
  const w0 = !!(t[0] && t[0].won), w1 = !!(t[1] && t[1].won);
  return w0 && !w1 ? 0 : w1 && !w0 ? 1 : -1;
}

/**
 * Yhden kierroksen pelaajakohtaiset luvut.
 * @returns {{skip: string}|{skip: null, winner: number, rows: object[], anomalies: number, spuriousDefuses: number, objUnknown: number}}
 *   skip: 'tdm' | 'noFeedback' | 'noRoster'
 */
function computeRound(rd) {
  if (!rd || typeof rd !== 'object') return { skip: 'noRoster' };
  if (isTdm(rd)) return { skip: 'tdm' };
  const teamOf = new Map();
  for (const p of rd.players || []) if (p && p.username && (p.teamIndex === 0 || p.teamIndex === 1)) teamOf.set(p.username, p.teamIndex);
  if (!teamOf.size) for (const s of rd.stats || []) if (s && s.username && (s.teamIndex === 0 || s.teamIndex === 1)) teamOf.set(s.username, s.teamIndex);
  const sizes = [0, 0];
  for (const t of teamOf.values()) sizes[t]++;
  if (sizes[0] < 1 || sizes[1] < 1) return { skip: 'noRoster' };

  const feed = Array.isArray(rd.matchFeedback) ? rd.matchFeedback : [];
  const RELEVANT = ['Kill', 'Death', 'DefuserPlantComplete', 'DefuserDisableComplete'];
  if (!feed.some((e) => RELEVANT.includes(typeName(e)))) return { skip: 'noFeedback' };
  // Pistetaulu kertoo tappoja, mutta feedissä ei ole yhtään tappoa/kuolemaa -> feedi on puutteellinen.
  const sbKills = (rd.stats || []).reduce((n, s) => n + (Number(s && s.sbKills) || 0), 0);
  if (sbKills > 0 && !feed.some((e) => typeName(e) === 'Kill' || typeName(e) === 'Death')) return { skip: 'noFeedback' };

  const rows = new Map();
  const alive = [new Set(), new Set()];
  for (const [u, t] of teamOf) {
    rows.set(u, { username: u, teamIndex: t, kills: 0, dead: false, entryKill: false, entryDeath: false, tradeKills: 0, tradedDeath: false, plants: 0, defuses: 0, clutchX: 0, clutchWon: false });
    alive[t].add(u);
  }
  const prior = []; // vihollistapot järjestyksessä: { killer, victim, victimTeam, t, planted }
  const clutches = [null, null];
  let entryDone = false;
  let anomalies = 0;
  let planted = false;
  let objUnknown = 0;
  const started = { plant: new Set(), disable: new Set() };
  const roleOf = (r) => ((rd.teams && rd.teams[r.teamIndex]) || {}).role || '';

  for (const e of feed) {
    const tn = typeName(e);
    if (tn === 'Kill' || tn === 'Death') {
      const killer = tn === 'Kill' ? e.username : '';
      const target = tn === 'Kill' ? e.target : e.username;
      const trow = rows.get(target);
      if (trow && trow.dead) continue; // sama kuolema raportoitu kahdesti
      const krow = killer ? rows.get(killer) : null;
      const t = Number(e.timeInSeconds);
      const valid = !!krow && killer !== target && (!trow || trow.teamIndex !== krow.teamIndex);
      if (trow) { trow.dead = true; alive[trow.teamIndex].delete(target); }
      if (valid) {
        krow.kills++;
        if (!entryDone) {
          entryDone = true;
          krow.entryKill = true;
          if (trow) trow.entryDeath = true;
        }
        let traded = false;
        for (const p of prior) {
          if (p.killer !== target || p.victimTeam !== krow.teamIndex || p.planted !== planted) continue;
          const dt = p.t - t; // kello laskee: aiempi tapahtuma on suurempi
          if (!(dt >= 0)) { if (Number.isFinite(dt)) anomalies++; continue; }
          if (dt <= TRADE_WINDOW_S) { traded = true; rows.get(p.victim).tradedDeath = true; }
        }
        if (traded) krow.tradeKills++;
        prior.push({ killer, victim: target, victimTeam: trow ? trow.teamIndex : -1, t, planted });
      }
      if (trow) {
        const ti = trow.teamIndex, oi = 1 - ti;
        if (alive[ti].size === 1 && !clutches[ti] && alive[oi].size >= 1) {
          clutches[ti] = { username: alive[ti].values().next().value, x: Math.min(MAX_X, alive[oi].size) };
        }
      }
    } else if (tn === 'DefuserPlantStart') {
      started.plant.add(e.username);
    } else if (tn === 'DefuserDisableStart') {
      started.disable.add(e.username);
    } else if (tn === 'DefuserPlantComplete') {
      const r = rows.get(e.username);
      planted = true;
      if (r && started.plant.has(e.username) && roleOf(r) !== 'Defense' && !r.dead) r.plants = 1; else objUnknown++;
    } else if (tn === 'DefuserDisableComplete') {
      const r = rows.get(e.username);
      if (r && started.disable.has(e.username) && roleOf(r) !== 'Attack' && !r.dead) r.defuses = 1; else objUnknown++;
    }
  }

  const winner = winnerOf(rd);
  let spuriousDefuses = 0; // hyväksytty purku, vaikka tiimi hävisi (ei pitäisi esiintyä)
  for (const r of rows.values()) {
    if (r.defuses && winner >= 0 && r.teamIndex !== winner) { r.defuses = 0; spuriousDefuses++; }
  }
  if (winner >= 0) {
    for (let ti = 0; ti < 2; ti++) {
      const c = clutches[ti];
      if (!c) continue;
      const r = rows.get(c.username);
      r.clutchX = c.x;
      r.clutchWon = winner === ti;
    }
  }
  const out = [];
  for (const r of rows.values()) {
    r.survived = !r.dead;
    r.objective = r.plants > 0 || r.defuses > 0;
    r.kost = r.kills > 0 || r.objective || r.survived || r.tradedDeath;
    out.push(r);
  }
  if (objUnknown) for (const r of out) r.objUnknown = 1;
  return { skip: null, winner, rows: out, anomalies, spuriousDefuses, objUnknown };
}

// ---- Tiivis tallennusmuoto (summary.players[i].adv) -------------------------------------------------
//  r kierrokset, kr KOST-kierrokset, kl tapot, dt kuolemat, ek/ed entry-tapot/-kuolemat, tk trade-tapot, td tradatut kuolemat,
//  sv selviytymiset, ob objektiivikierrokset, pl plantit, df purut, ou kierrokset joilla asennus/purku jäi ilman tekijää, ca/cw clutch-yritykset/-voitot X=1..5, mk [2K, 3K, 4K, ace]
function emptyAdv() {
  return { r: 0, kr: 0, kl: 0, dt: 0, ek: 0, ed: 0, tk: 0, td: 0, sv: 0, ob: 0, pl: 0, df: 0, ou: 0, ca: [0, 0, 0, 0, 0], cw: [0, 0, 0, 0, 0], mk: [0, 0, 0, 0] };
}
function isAdv(a) { return !!a && typeof a === 'object' && Number.isFinite(a.r) && a.r > 0; }

function addRow(a, r) {
  a.r++;
  if (r.kost) a.kr++;
  a.kl += r.kills;
  if (r.dead) a.dt++;
  if (r.entryKill) a.ek++;
  if (r.entryDeath) a.ed++;
  a.tk += r.tradeKills;
  if (r.tradedDeath) a.td++;
  if (r.survived) a.sv++;
  if (r.objective) a.ob++;
  a.pl += r.plants;
  a.df += r.defuses;
  if (r.objUnknown) a.ou++;
  if (r.clutchX >= 1) {
    a.ca[r.clutchX - 1]++;
    if (r.clutchWon) a.cw[r.clutchX - 1]++;
  }
  if (r.kills >= 2) a.mk[Math.min(r.kills, 5) - 2]++;
}

/**
 * Koko ottelun luvut: { players: Map<username, adv>, meta } tai null, jos yksikään kierros ei kelvannut.
 * meta: { rounds, used, skipped: {tdm, noFeedback, noRoster}, anomalies, spuriousDefuses }
 */
function computeMatch(rounds) {
  const players = new Map();
  const meta = { rounds: 0, used: 0, skipped: { tdm: 0, noFeedback: 0, noRoster: 0 }, anomalies: 0, spuriousDefuses: 0 };
  for (const rd of Array.isArray(rounds) ? rounds : []) {
    meta.rounds++;
    let res;
    try { res = computeRound(rd); } catch (_) { res = { skip: 'noFeedback' }; }
    if (res.skip) { meta.skipped[res.skip]++; continue; }
    meta.used++;
    meta.anomalies += res.anomalies;
    meta.spuriousDefuses += res.spuriousDefuses;
    for (const r of res.rows) {
      let a = players.get(r.username);
      if (!a) { a = emptyAdv(); players.set(r.username, a); }
      addRow(a, r);
    }
  }
  return meta.used ? { players, meta } : null;
}

/** Tallennettavaksi: { username: adv } tai null. */
function matchAdv(rounds) {
  const m = computeMatch(rounds);
  if (!m) return null;
  const out = {};
  for (const [u, a] of m.players) out[u] = a;
  return out;
}

/** Summaa tiiviit adv-oliot (ohittaa virheelliset). Palauttaa null, jos mitään summattavaa ei ole. */
function sumAdv(list) {
  const out = emptyAdv();
  let n = 0;
  for (const a of list || []) {
    if (!isAdv(a)) continue;
    n++;
    for (const k of ['r', 'kr', 'kl', 'dt', 'ek', 'ed', 'tk', 'td', 'sv', 'ob', 'pl', 'df', 'ou']) out[k] += Number(a[k]) || 0;
    for (let i = 0; i < 5; i++) { out.ca[i] += Number(a.ca && a.ca[i]) || 0; out.cw[i] += Number(a.cw && a.cw[i]) || 0; }
    for (let i = 0; i < 4; i++) out.mk[i] += Number(a.mk && a.mk[i]) || 0;
  }
  return n ? out : null;
}

const pctOf = (a, b) => (b > 0 ? round1((a / b) * 100) : null);

/** Tiivis -> näytettävä muoto (UI/IPC). null, jos dataa ei ole. */
function finalize(a) {
  if (!isAdv(a)) return null;
  const ca = [0, 1, 2, 3, 4].map((i) => Number(a.ca && a.ca[i]) || 0);
  const cw = [0, 1, 2, 3, 4].map((i) => Number(a.cw && a.cw[i]) || 0);
  const mk = [0, 1, 2, 3].map((i) => Number(a.mk && a.mk[i]) || 0);
  const att = ca.reduce((x, y) => x + y, 0), won = cw.reduce((x, y) => x + y, 0);
  return {
    rounds: a.r, kostRounds: a.kr, kost: pctOf(a.kr, a.r),
    kills: a.kl, deaths: a.dt,
    entryKills: a.ek, entryDeaths: a.ed, entryPct: pctOf(a.ek, a.ek + a.ed),
    tradeKills: a.tk, tradedDeaths: a.td, survived: a.sv, objective: a.ob, plants: a.pl, defuses: a.df, objectiveUnknown: a.ou || 0,
    clutch: { attempts: ca, wins: cw, attemptsTotal: att, winsTotal: won, winPct: pctOf(won, att) },
    multi: { k2: mk[0], k3: mk[1], k4: mk[2], ace: mk[3] },
  };
}

module.exports = {
  TRADE_WINDOW_S, ADV_VERSION, computeRound, computeMatch, matchAdv, emptyAdv, isAdv, sumAdv, finalize, isTdm, winnerOf,
};
