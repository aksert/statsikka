'use strict';
// Oikean datan tarkistus edistyneille R6-tilastoille (src/main/r6-advanced.js). Vain luku: MatchReplay-kansiota ei muuteta.
// Käyttö: node scripts/r6-advanced-check.js [--dir <MatchReplay>] [--id <recordingProfileID>] [--matches N] [--verbose]
// Tulostaa pelaajan KOST-%, entry K-D, tradet, clutchit X:n mukaan, multikillit, plantit/purut sekä invariantit:
//   entry-tappoja = entry-kuolemia, KOST <= 100 %, clutch-yritykset <= kierrokset, tradet <= tapot/kuolemat, ym.
// Poistumiskoodi 1, jos jokin invariantti ei päde.

const path = require('path');
const { parseMatchFolder, listMatchFolders, findReplayDirs } = require('../src/main/r6');
const adv = require('../src/main/r6-advanced');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const verbose = args.includes('--verbose');
const OWN_ID = opt('id', 'd8591237-2892-4246-bb64-a668bd3bd7ba');
const pct1 = (n) => (n == null ? '–' : `${n.toFixed(1)} %`);

async function main() {
  let dir = opt('dir', null);
  if (!dir) dir = (await findReplayDirs())[0];
  if (!dir) throw new Error('MatchReplay-kansiota ei löytynyt; anna --dir');
  let folders = await listMatchFolders(dir);
  const limit = Number(opt('matches', 0));
  if (limit > 0) folders = folders.slice(-limit);

  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const tot = { matches: 0, rounds: 0, used: 0, tdm: 0, noFeedback: 0, noRoster: 0, anomalies: 0, spurious: 0, noWinner: 0, planted: 0, plants: 0, defuses: 0, wrongRole: 0, objUnknown: 0, kills: 0, upstreamKills: 0 };
  const entry = { kills: 0, deaths: 0, mismatchRounds: 0, noEntryRounds: 0 };
  const cross = { rounds: 0, agree: 0, disagree: 0, missing: 0, upstreamWrongWinner: 0 };
  const perPlayer = new Map(); // username@match -> adv (invarianttien tarkistus kaikille pelaajille)
  let own = adv.emptyAdv();
  let ownMatches = 0, ownTdm = 0;
  const t0 = Date.now();

  for (const folder of folders) {
    const m = await parseMatchFolder(folder, { cache: null });
    tot.matches++;
    let matchHasOwn = false;
    const matchAdv = adv.computeMatch(m.rounds);
    for (const rd of m.rounds) {
      tot.rounds++;
      const res = adv.computeRound(rd);
      if (res.skip) { tot[res.skip]++; if (res.skip === 'tdm' && (rd.players || []).some((p) => p.profileID === OWN_ID)) ownTdm++; continue; }
      tot.used++;
      tot.anomalies += res.anomalies; tot.objUnknown += res.objUnknown ? 1 : 0;
      tot.spurious += res.spuriousDefuses;
      if (res.winner < 0) tot.noWinner++;
      if (res.rows.some((r) => r.plants)) tot.planted++;
      for (const r of res.rows) {
        const role = (rd.teams[r.teamIndex] || {}).role;
        if (r.plants) { tot.plants++; if (role && role !== 'Attack') tot.wrongRole++; }
        if (r.defuses) { tot.defuses++; if (role && role !== 'Defense') tot.wrongRole++; }
      }
      const ek = res.rows.filter((r) => r.entryKill).length, ed = res.rows.filter((r) => r.entryDeath).length;
      entry.kills += ek; entry.deaths += ed;
      if (ek !== ed) { entry.mismatchRounds++; if (verbose) console.log(`  entry-ero: ${path.basename(folder)} R${rd.roundIndex} ek=${ek} ed=${ed}`); }
      if (ek === 0) entry.noEntryRounds++;
      const myKills = res.rows.reduce((n, r) => n + r.kills, 0);
      tot.kills += myKills;
      tot.upstreamKills += (rd.stats || []).reduce((n, s) => n + (s.kills || 0), 0);
      // Kierroskohtaiset invariantit
      check(res.rows.filter((r) => r.clutchX).every((r) => r.clutchX >= 1 && r.clutchX <= 5), 'clutch X rajojen ulkopuolella');
      check(res.rows.every((r) => r.tradeKills <= r.kills), 'trade-tappoja enemmän kuin tappoja kierroksella');
      check(res.rows.filter((r) => r.clutchX).length <= 2, 'yli 2 clutchia kierroksella');
      check(res.rows.every((r) => !(r.entryKill && r.entryDeath)), 'sama pelaaja entry-tappaja ja -uhri');
      // Vertailu jäsentimen 1vX-arvoon (vain voittajan viimeinen pelaaja)
      for (const s of rd.stats || []) {
        if (!s['1vX']) continue;
        cross.rounds++;
        const r = res.rows.find((x) => x.username === s.username);
        if (!r || !r.clutchX) cross.missing++;
        else if (r.clutchWon && r.clutchX === s['1vX']) cross.agree++;
        else { cross.disagree++; if (!r.clutchWon) cross.upstreamWrongWinner++; if (verbose) console.log(`  1vX-ero: ${path.basename(folder)} R${rd.roundIndex} ${s.username} jäsennin=${s['1vX']} oma=1v${r.clutchX}${r.clutchWon ? ' voitto' : ' tappio'}`); }
      }
      if ((rd.players || []).some((p) => p.profileID === OWN_ID)) matchHasOwn = true;
    }
    if (matchAdv) {
      for (const [u, a] of matchAdv.players) {
        perPlayer.set(`${u}@${path.basename(folder)}`, a);
        check(a.kr <= a.r, `KOST-kierroksia enemmän kuin kierroksia (${u})`);
        check(a.ca.reduce((x, y) => x + y, 0) <= a.r, `clutch-yrityksiä enemmän kuin kierroksia (${u})`);
        check(a.cw.every((w, i) => w <= a.ca[i]), `clutch-voittoja enemmän kuin yrityksiä (${u})`);
        check(a.tk <= a.kl, `trade-tappoja enemmän kuin tappoja (${u})`);
        check(a.td <= a.dt, `tradattuja kuolemia enemmän kuin kuolemia (${u})`);
        check(a.sv + a.dt === a.r, `selviytyneet + kuolleet != kierrokset (${u})`);
        check(a.ek + a.ed <= a.r, `entry-kierroksia enemmän kuin kierroksia (${u})`);
        check(a.ek <= a.kl && a.ed <= a.dt, `entry-tappoja/kuolemia enemmän kuin tappoja/kuolemia (${u})`);
        check(a.mk.reduce((x, y) => x + y, 0) <= a.r, `multikillejä enemmän kuin kierroksia (${u})`);
      }
      const p = [...matchAdv.players.keys()].find((u) => m.rounds.some((rd) => (rd.players || []).some((x) => x.username === u && x.profileID === OWN_ID)));
      if (p && matchHasOwn) {
        own = adv.sumAdv([own.r ? own : null, matchAdv.players.get(p)]) || own;
        ownMatches++;
      }
    }
  }

  const f = adv.finalize(own);
  console.log(`Kansio: ${dir}`);
  console.log(`Ottelukansioita ${tot.matches}, kierroksia ${tot.rounds} (käytetty ${tot.used}; ohitettu TDM ${tot.tdm}, puutteellinen feedi ${tot.noFeedback}, ei rosteria ${tot.noRoster}), aikaa ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Trade-ikkuna ${adv.TRADE_WINDOW_S} s. Kelloanomalioita ${tot.anomalies}, hylättyjä purkuja ${tot.spurious}, kierroksia ilman tunnettua voittajaa ${tot.noWinner}, kierroksia joissa plantti tunnistettu pelaajalle ${tot.planted}`);
  console.log(`Plantit ${tot.plants}, hyväksytyt purut ${tot.defuses}, väärän puolen asentaja/purkaja ${tot.wrongRole}, kierroksia joilla tekijä tunnistamatta ${tot.objUnknown}`);
  console.log(`Tappoja yhteensä (oma laskenta / jäsennin): ${tot.kills} / ${tot.upstreamKills} (ero = tiimitapot, rosterin ulkopuoliset)`);
  console.log(`Omia otteluita (profiili ${OWN_ID}): ${ownMatches}${ownTdm ? `, TDM-kierroksia ohitettu ${ownTdm}` : ''}`);
  if (f) {
    console.log(`\nOMA PROFIILI (${f.rounds} kierrosta)`);
    console.log(`  KOST: ${pct1(f.kost)} (${f.kostRounds} / ${f.rounds}); selviytyi ${f.survived}, objektiivi ${f.objective}`);
    console.log(`  Entry: ${f.entryKills}–${f.entryDeaths}, onnistuminen ${pct1(f.entryPct)}`);
    console.log(`  Tradet: ${f.tradeKills} trade-tappoa, ${f.tradedDeaths} tradattua kuolemaa (tappoja ${f.kills}, kuolemia ${f.deaths})`);
    console.log(`  Clutchit: ${f.clutch.winsTotal} / ${f.clutch.attemptsTotal} (${pct1(f.clutch.winPct)}); ${f.clutch.attempts.map((a, i) => `1v${i + 1}: ${f.clutch.wins[i]}/${a}`).join(', ')}`);
    console.log(`  Multikillit: 2K ${f.multi.k2}, 3K ${f.multi.k3}, 4K ${f.multi.k4}, ace ${f.multi.ace}`);
    console.log(`  Plantit ${f.plants}, purut ${f.defuses}`);
  } else {
    console.log('\nOmaa profiilia ei löytynyt tallenteista (anna --id).');
  }
  console.log(`\nINVARIANTIT`);
  console.log(`  entry-tappoja yhteensä ${entry.kills}, entry-kuolemia ${entry.deaths}, kierroksia joissa ero ${entry.mismatchRounds}, kierroksia ilman entryä ${entry.noEntryRounds}`);
  console.log(`  jäsentimen 1vX-voittoja ${cross.rounds}: täsmää ${cross.agree}, eri tulos ${cross.disagree} (joista ${cross.upstreamWrongWinner}: jäsennin nimesi hävinneen tiimin voittajaksi), ei clutchia omassa laskennassa ${cross.missing}`);
  // entry-kierrosero kelpaa vain, jos syy on rosterin ulkopuolinen tappaja/kohde (ei virhe)
  const entryOk = entry.kills === entry.deaths;
  console.log(`  entry-tappoja == entry-kuolemia: ${entryOk ? 'OK' : 'EROA (rosterin ulkopuolisia tappajia/kohteita)'}`);
  console.log(`  muut invariantit (KOST <= 100 %, clutch <= kierrokset, trade <= tapot/kuolemat, selviytyi + kuollut = kierrokset): ${fails.length ? `${fails.length} EPÄONNISTUI` : 'OK'}`);
  for (const m of [...new Set(fails)].slice(0, 10)) console.log(`    ${m}`);
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
