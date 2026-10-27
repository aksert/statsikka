'use strict';
// Näkymätön savutesti: `electron . --smoke-test`. Ikkuna ei koskaan näy.
// Lataa renderöijän, käy kaikki näkymät ja lomakkeet läpi DOM:ssa, kerää konsolivirheet ja käsittelemättömät hylkäykset,
// tulostaa jokaisesta tarkistuksesta "ok" / "FAIL" ja lopuksi "SMOKE OK" tai virheet. Kuvakaappaukset: ST_SHOTS=<kansio>.
const ow = require('./providers/ow');
const SIM = require('../../scripts/gep-sim'); // keinotekoiset GEP-viestit (vain savutesti)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tulostus myös tiedostoon (ST_LOG), koska putkitettu stdout puskuroituu eikä näy, jos prosessi tapetaan.
const log = (line) => { console.log(line); if (process.env.ST_LOG) require('fs').appendFileSync(process.env.ST_LOG, `${line}\n`); };

// Esitäytetty OW-historia (vanhempia tilannekuvia), jotta kortit ja kaaviot voidaan todentaa myös ilman verkkoa.
function owSeed(now) {
  const d = 86400000;
  const rk = (division, tier) => ({ division, tier });
  const S = (ago, ranks, w, l, wr, kd) => ({ ts: now - ago, ranks, games_played: w + l, games_won: w, games_lost: l, eliminations: w * 20, deaths: l * 14 + 40, kd, winrate: wr, season: 22 });
  const snapshots = [
    S(9 * d, { tank: rk('gold', 3), damage: rk('silver', 2), support: rk('silver', 5) }, 20, 20, 50, 1.1),
    S(5 * d, { tank: rk('gold', 3), damage: rk('silver', 2), support: rk('silver', 4) }, 26, 24, 52, 1.2),
    S(2 * d, { tank: rk('gold', 2), damage: rk('silver', 1), support: rk('silver', 4) }, 30, 25, 54.5, 1.25),
    S(d / 2, { tank: rk('gold', 2), damage: rk('silver', 1), support: rk('silver', 4) }, 33, 26, 55.9, 1.3),
  ];
  const e = (id, ago, percent) => ({ id, ts: now - ago, percent, division: 'silver', tier: 4, season: 22 });
  return { snapshots, progress: { support: [e('smokea1', 5 * d - 1000, 20), e('smokea2', 2 * d - 1000, 50)] } };
}

// Keinotekoinen OW-profiili oikean normalisoinnin läpi (vain savutesti; ei koskaan haeta verkosta).
const SYNTH = {
  suspicious: { games: 140, wins: 100, elims: 6600, deaths: 1000, finals: 3300, heroes: { widowmaker: [40000, 78, 64], ashe: [20000, 76, 52], cassidy: [12000, 70, 40] } },
  watch: { games: 80, wins: 44, elims: 4200, deaths: 1000, finals: 2100, heroes: { cassidy: [30000, 55, 12], tracer: [9000, 40, 8] } },
  clean: { games: 90, wins: 45, elims: 1500, deaths: 1100, finals: 500, heroes: { ana: [30000, 38, 0], widowmaker: [10000, 33, 20] } },
};
function synthProfile(kind, name, id) {
  const s = SYNTH[kind];
  const total = 150000;
  const career = { 'all-heroes': { game: { time_played: total, games_played: s.games, games_won: s.wins, games_lost: s.games - s.wins }, combat: { eliminations: s.elims, deaths: s.deaths, final_blows: s.finals }, best: {} } };
  const heroStats = {};
  for (const [k, [t, w, c]] of Object.entries(s.heroes)) {
    career[k] = { game: { time_played: t, games_played: 20 }, combat: { weapon_accuracy: w, critical_hit_accuracy: c } };
    heroStats[k] = { games_played: 20, winrate: 50, kda: 3, time_played: t };
  }
  const wr = (s.wins / s.games) * 100;
  const stats = {
    general: { games_played: s.games, games_won: s.wins, games_lost: s.games - s.wins, winrate: wr, kda: s.elims / s.deaths, time_played: total, total: { eliminations: s.elims, deaths: s.deaths } },
    roles: { damage: { games_played: s.games, games_won: s.wins, games_lost: s.games - s.wins, winrate: wr, kda: s.elims / s.deaths, time_played: total, total: { eliminations: s.elims, deaths: s.deaths } } },
    heroes: heroStats,
  };
  const summary = { username: name, avatar: null, title: 'Testiprofiili', endorsement: { level: 3, frame: null }, competitive: { pc: { season: 22, damage: { division: 'diamond', tier: 2 }, support: { division: 'gold', tier: 3 } } } };
  return ow.normalizeProfile({ id, summary, stats, career, heroMap: {}, platform: 'pc', gamemode: 'competitive' });
}
function synthProfiles() {
  return {
    'Synth-1111': synthProfile('suspicious', 'SynthHacker', 'Synth-1111'),
    'Synth-2222': synthProfile('watch', 'SynthWatcher', 'Synth-2222'),
    'Synth-3333': synthProfile('clean', 'SynthClean', 'Synth-3333'),
    'Priv-4444': ow.normalizeProfile({ id: 'Priv-4444', summary: { username: 'PrivPlayer', avatar: null, title: null }, stats: {}, career: null, platform: 'pc', gamemode: 'competitive', isPublic: false }),
  };
}

// R6: kopioi 3 uusinta ottelukansiota pelaajan oikeasta MatchReplay-kansiosta (vain luetaan) väliaikaiseen kansioon, jotta testi
// on deterministinen eikä koske pelikansioon. Palauttaa { dir, spare: [kierrostiedostot 4. uusimmasta ottelusta] } tai null, jos tallenteita ei ole.
async function prepareR6Smoke() {
  const fs = require('fs');
  const path = require('path');
  const { findReplayDirs, listMatchFolders } = require('./r6');
  const found = await findReplayDirs();
  if (!found.length) return null;
  // Ohitetaan ottelut, joihin peli kirjoittaa parhaillaan (muutettu < 10 min sitten): keskeneräinen kierrostiedosto tekisi testistä epädeterministisen.
  const settled = (f) => fs.readdirSync(f).filter((n) => /\.rec$/i.test(n))
    .every((n) => Date.now() - fs.statSync(path.join(f, n)).mtimeMs > 10 * 60 * 1000);
  const folders = (await listMatchFolders(found[0])).filter(settled);
  if (folders.length < 3) return null;
  const dir = path.join(require('os').tmpdir(), 'statsikka-r6-smoke');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const copyFile = (src, dst) => { fs.copyFileSync(src, dst); const st = fs.statSync(src); fs.utimesSync(dst, st.atime, st.mtime); }; // mtime säilyy: vanha tallenne ei näytä käynnissä olevalta
  for (const f of folders.slice(-3)) {
    const dst = path.join(dir, path.basename(f));
    fs.mkdirSync(dst);
    for (const n of fs.readdirSync(f)) if (/\.rec$/i.test(n)) copyFile(path.join(f, n), path.join(dst, n));
  }
  // Live-simulaation kierrokset otetaan uusimmasta kopioidusta ottelusta: simuloitu "live"-ottelu jakaa kaikki pelaajat edellisen ottelun kanssa (Edellinen-merkit).
  // Jos uusimmassa on alle 2 kierrosta, käytetään 4. uusimman kierroksia (ei välttämättä yhteisiä pelaajia).
  const recsOf = (src) => fs.readdirSync(src).filter((n) => /\.rec$/i.test(n)).sort().slice(0, 2).map((n) => path.join(src, n));
  let spare = recsOf(folders[folders.length - 1]);
  let overlap = spare.length >= 2;
  if (!overlap) { spare = folders.length >= 4 ? recsOf(folders[folders.length - 4]) : []; }
  // Odotetut pelaajamäärät lasketaan kierroksista samalla tavalla kuin ottelunäkymä (aggregatePlayers, avain käyttäjänimi): oikeassa ottelussa ei aina ole 10 pelaajaa.
  let players1 = 0, players2 = 0;
  if (spare.length >= 2) {
    const { parseRound, helpers } = require('./r6');
    const rounds = [];
    for (const f of spare.slice(0, 2)) rounds.push(await parseRound(f, { cache: null }));
    players1 = helpers.aggregatePlayers(rounds.slice(0, 1)).length;
    players2 = helpers.aggregatePlayers(rounds).length;
  }
  return { dir, spare, overlap, players1, players2 };
}
const pad2 = (n) => String(n).padStart(2, '0');
function liveFolderName() {
  const d = new Date();
  return `Match-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}-9292`;
}

// Sivun sisäiset apurit (injektoidaan renderöijään; vain savutestissä).
const HELPERS = `(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__t = {
    wait,
    until: async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch (_) { /* odota */ } await wait(60); } return false; },
    vis: () => document.querySelector('#view > .view-pane:not([hidden])'),
    btn: (text, root) => [...(root || document).querySelectorAll('button')].find((b) => b.textContent.trim() === text),
    modalBtn: (text) => [...document.querySelectorAll('#modal-root button')].find((b) => b.textContent.trim() === text),
    toast: (text, err) => [...document.querySelectorAll('.toast' + (err ? '.err' : ''))].some((t) => t.textContent.includes(text)),
    set: (input, v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); },
    nav: (g) => document.querySelector('.nav-item[data-game=' + g + ']').click(),
    tab: (label) => { const t = [...document.querySelectorAll('#tabs .tab')].find((x) => x.textContent === label); if (!t) throw new Error('ei välilehteä ' + label); t.click(); },
    go: (g, label) => { document.querySelector('.nav-item[data-game=' + g + ']').click(); if (label) { const t = [...document.querySelectorAll('#tabs .tab')].find((x) => x.textContent === label); if (!t) throw new Error('ei välilehteä ' + label); t.click(); } },
    seg: (root, text) => { const b = [...root.querySelectorAll('.seg button')].find((x) => x.textContent === text); if (!b) throw new Error('ei painiketta ' + text); b.click(); },
    fill: (inputs, rank, v) => { const keys = ['kd', 'hsPercent', 'winrate', 'matches', 'kills', 'killsPerRound', 'level']; keys.forEach((k, i) => window.__t.set(inputs[i], v[k] == null ? '' : String(v[k]))); rank.value = v.rank || ''; rank.dispatchEvent(new Event('change', { bubbles: true })); },
    on: (root) => [...root.querySelectorAll('.seg button.on')].map((b) => b.textContent),
    overflow: () => {
      const bad = [], info = [];
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth + 1) bad.push('sivu vierittyy vaakasuunnassa ' + de.scrollWidth + '>' + de.clientWidth);
      const view = document.getElementById('view');
      if (view.scrollWidth > view.clientWidth + 1) bad.push('näkymä vierittyy vaakasuunnassa ' + view.scrollWidth + '>' + view.clientWidth);
      const pane = document.querySelector('#view > .view-pane:not([hidden])');
      const vr = view.getBoundingClientRect();
      const desc = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + ' "' + (el.textContent || '').trim().slice(0, 24) + '"';
      if (bad.length) { // diagnostiikka: leveimmät elementit (oikea reuna)
        const wide = [...pane.querySelectorAll('*')].map((el) => ({ el, r: el.getBoundingClientRect().right })).sort((a, b) => b.r - a.r).slice(0, 3);
        bad.push('leveimmät: ' + wide.map((x) => desc(x.el) + ' @' + Math.round(x.r)).join(' ; '));
      }
      for (const el of pane.querySelectorAll('*')) {
        if (bad.length > 6) break;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || el instanceof SVGElement && el.tagName !== 'svg') continue;
        const scroller = (() => { for (let p = el.parentElement; p && p !== pane; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p; } return null; })();
        const r = el.getBoundingClientRect();
        if (el.scrollWidth > el.clientWidth + 1 && (cs.overflowX === 'auto' || cs.overflowX === 'scroll')) { info.push('sisäinen vierityspalkki: ' + desc(el)); continue; }
        if (scroller) continue;
        if (el.tagName === 'IMG') continue;
        if (r.width > 0 && r.right > vr.right + 1) bad.push('ylittää oikean reunan (' + Math.round(r.right - vr.right) + ' px): ' + desc(el));
        else if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) bad.push('sisältö leikkautuu: ' + desc(el));
      }
      return { bad, info };
    },
  };
  return true;
})()`;

exports.run = async function run(win, app, probe, hooks) {
  const errors = [];
  let okCount = 0;
  process.on('unhandledRejection', (e) => errors.push(`pääprosessi: käsittelemätön hylkäys: ${e && e.message ? e.message : e}`));
  win.webContents.on('console-message', (event, level, message) => {
    const e = event && typeof event === 'object' && 'message' in event ? event : { level, message };
    const lv = e.level;
    if (lv === 'error' || lv === 3) errors.push(`console: ${e.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone ${d.reason}`));

  const ev = (code, ms = 60000) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error('ev-aikakatkaisu ' + ms + ' ms')), ms))]);
  // Valinnainen: ST_SHOTS=<kansio> tallentaa kuvakaappaukset näkymistä (ikkuna pysyy piilossa).
  const shot = async (name) => {
    if (!process.env.ST_SHOTS) return;
    await sleep(600);
    // Piilotettu ikkuna maalaa hitaasti: pyydä uusi kuva ja ota vasta sitten varsinainen.
    win.webContents.invalidate();
    await win.webContents.capturePage();
    await sleep(500);
    const img = await win.webContents.capturePage();
    require('fs').mkdirSync(process.env.ST_SHOTS, { recursive: true });
    require('fs').writeFileSync(require('path').join(process.env.ST_SHOTS, `${name}.png`), img.toPNG());
  };
  const pass = (name) => { okCount++; log(`  ok   ${name}`); };
  const fail = (name, why) => { errors.push(`${name}${why ? `: ${why}` : ''}`); log(`  FAIL ${name}${why ? ` (${why})` : ''}`); };
  const check = async (name, code, diag) => {
    try {
      const r = await ev(code);
      if (!r) {
        let d = '';
        if (diag) { try { d = JSON.stringify(await ev(diag)); } catch (e) { d = e.message; } }
        fail(name, d);
      } else pass(name);
    } catch (e) { fail(name, e.message); }
  };
  // Odottaa kunnes lauseke on tosi (enintään ms).
  const waitCheck = async (name, code, ms = 8000) => {
    const end = Date.now() + ms;
    try {
      while (Date.now() < end) { if (await ev(code)) { pass(name); return; } await sleep(250); }
      fail(name, 'aikakatkaisu');
    } catch (e) { fail(name, e.message); }
  };
  const info = (s) => log(`  info ${s}`);
  const nav = (g) => `window.__t.nav('${g}')`;
  const go = (g, tab) => `window.__t.go('${g}', ${tab ? `'${tab}'` : 'null'})`;
  const inject = () => ev(HELPERS);
  const gepFeed = { info: (g, m) => hooks.gepInfo(g, m), event: (g, m) => hooks.gepEvent(g, m) };
  const hasGep = !!(hooks && hooks.gepInfo && hooks.gepEvent && hooks.gepReset);
  // R6-roster tallenteiden pelaajista: oma + 4 tiimikaveria (Blue), 3 vastustajaa tallenteista + 2 tuntematonta (Orange) -> 8 tuttua, 2 uutta.
  const gepR6Players = async () => {
    const known = await ev(`window.api.r6Live().then((r) => r.data.match.players.map((p) => ({ id: p.profileID, name: p.username, own: p.isOwn, blue: p.teamIndex === r.data.match.ownTeamIndex })))`);
    const blue = known.filter((p) => p.blue).sort((a, b) => Number(b.own) - Number(a.own)).slice(0, 5);
    const orange = known.filter((p) => !p.blue).slice(0, 3);
    const mk = (p, i, team) => ({ id: p.id, name: p.name, local: !!p.own, team, kills: (i * 3) % 7, deaths: (i * 5) % 4, assists: i % 3, score: 100 + i * 37 });
    const players = [...blue.map((p, i) => mk(p, i, 'Blue')), ...orange.map((p, i) => mk(p, 5 + i, 'Orange'))];
    for (let i = players.length; i < 10; i++) players.push({ id: `00000000-0000-4000-8000-0000000000${10 + i}`, name: `GepUusi${i}`, local: false, team: i < 5 ? 'Blue' : 'Orange', kills: 1, deaths: 2, assists: 0, score: 50 });
    return { players, knownCount: blue.length + orange.length };
  };

  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await sleep(500);
  await inject();
  if (hooks && hooks.setProfiles) hooks.setProfiles(synthProfiles());
  if (hooks && hooks.injectGame) hooks.injectGame({}); // ei oikeita prosessikyselyitä (tasklist) savutestissä
  // Mock-RL ei saa käyttää pelin oletusporttia 49124: muuten käynnissä oleva oikea Statsikka yhdistäisi samaan mockiin ja tallentaisi testiottelut käyttäjän historiaan.
  // Asetus tallentuu vain savutestin omaan userData-kansioon; portin vaihto avaa yhteyden uudelleen (main.js: rlClient.reconnect()).
  const mockPort = Number(process.env.MOCK_RL_PORT) || 49130;
  await ev(`window.api.setSettings({ rlWebPort: ${mockPort} })`);
  info(`mock-RL portti: ${mockPort}`);

  // Kertaluonteinen oikean datan tarkistus: ST_R6_REAL=1 ja R6_REPLAY_DIR=<oikea MatchReplay> (vain luetaan). Tulostaa luvut ja lopettaa.
  if (process.env.ST_R6_REAL) {
    const t0 = Date.now();
    hooks.startR6();
    await hooks.r6Ready();
    const r = await ev(`(async () => {
      const u = (p) => p.then((x) => { if (!x.ok) throw new Error(x.error.message); return x.data; });
      const st = await u(window.api.r6Status()); const o = await u(window.api.r6Own({ matchType: 'all' }));
      const pl = await u(window.api.r6Players({ pageSize: 100 })); const fl = await u(window.api.r6Players({ flaggedOnly: true, pageSize: 100 }));
      const lv = await u(window.api.r6Live());
      return { st, o, pl, fl, lv: { active: lv.active, name: lv.match && lv.match.name, players: lv.match && lv.match.players.length } };
    })()`);
    const o = r.o;
    log(`R6-OIKEA-DATA kansio=${r.st.dir}`);
    log(`R6-OIKEA-DATA skannaus ${(Date.now() - t0) / 1000} s, otteluita=${r.st.matchCount}, oma nimi=${r.st.ownName}`);
    log(`R6-OIKEA-DATA oma: ${o.wins}V-${o.losses}H-${o.draws}T, voitto-%=${o.winrate}, K/D=${o.kd}, HS-%=${o.hsPercent}, T/kierros=${o.kpr}, kierroksia=${o.rounds}, putki=${JSON.stringify(o.streak)}`);
    log(`R6-OIKEA-DATA hyökkäys ${o.attack.winrate} % (${o.attack.won}/${o.attack.played}), puolustus ${o.defense.winrate} % (${o.defense.won}/${o.defense.played})`);
    log(`R6-OIKEA-DATA top3 operaattorit: ${o.operators.slice(0, 3).map((x) => `${x.name} ${x.rounds} krs K/D ${x.kd} HS ${x.hsPercent}`).join(' | ')}`);
    log(`R6-OIKEA-DATA pelaajia=${r.pl.knownTotal}, merkitty: Tarkkaile=${r.fl.flagged.watch}, Mahdollinen hakkeri=${r.fl.flagged.suspicious}`);
    log(`R6-OIKEA-DATA live: aktiivinen=${r.lv.active}, ${r.lv.name}, pelaajia ${r.lv.players}`);
    log(`R6-OIKEA-DATA merkityt: ${r.fl.players.map((p) => `${p.username} (${p.suspicion.level}, ${p.suspicion.score} p, ${p.matches} ott.)`).join('; ') || '–'}`);
    app.quit();
    return;
  }

  // ======================= 1. Rakenne: sivupalkki ja välilehdet =======================
  await check('sidebar + otsikko', "document.title === 'Statsikka' && document.querySelectorAll('.nav-item').length === 5");
  await check('Oma profiili on oletusnäkymä ja kehottaa lisäämään profiilin', "document.querySelector('.nav-item.active').dataset.game === 'me' && document.querySelectorAll('.add-card').length === 3 && window.__t.vis().textContent.includes('Lisää oma profiili asetuksista')");
  await check('Välilehdet: OW / RL / R6, Oma profiili ensin ja valittuna', `(() => {
    const want = { ow: ['Oma profiili', 'Pelaajahaku', 'Live-lobby'], rl: ['Oma profiili', 'Live-peli', 'Historia', 'Pelaajat'], r6: ['Oma profiili', 'Live-peli', 'Ottelut', 'Pelaajat', 'Pelaajan tarkistus'] };
    for (const g of Object.keys(want)) {
      window.__t.nav(g);
      const labels = [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent);
      if (labels.join('|') !== want[g].join('|')) return false;
      if (document.querySelector('#tabs .tab.active').textContent !== 'Oma profiili') return false;
    }
    return true;
  })()`);
  await check('Sivupalkin kohteet vaihtavat näkymän (Oma profiili, OW, RL, R6, Asetukset)', `(() => {
    for (const g of ['me', 'ow', 'rl', 'r6', 'settings']) {
      window.__t.nav(g);
      if (document.body.dataset.game !== g) return false;
      if (document.querySelectorAll('#view > .view-pane:not([hidden])').length !== 1) return false;
      if (!document.querySelector('.nav-item[data-game=' + g + '].active')) return false;
    }
    window.__t.nav('me'); return true;
  })()`);
  await check('CSP-meta', "document.querySelector('meta[http-equiv=Content-Security-Policy]').content.includes(\"default-src 'self'\")");
  await check('window.api eristetty (ei require/process)', "typeof require === 'undefined' && typeof process === 'undefined' && typeof window.api.owProfile === 'function' && typeof window.api.profileGet === 'function' && typeof window.api.clearCache === 'function'");
  await check('Asetukset: "Siirry live-näkymään automaattisesti" -valintaruutu (teksti, ikkunaa ei tuoda esiin -huomautus) kytkee asetuksen päälle ja pois', `(async () => {
    ${nav('settings')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('input.auto-live'), 6000))) return false;
    const v = window.__t.vis(), cb = v.querySelector('input.auto-live');
    if (!v.textContent.includes('Siirry live-näkymään automaattisesti') || !v.textContent.includes('ikkunaa ei tuoda esiin')) return false;
    const was = (await window.api.getSettings()).data.autoLive; // savutestissä aluksi pois (oletus on päällä, ks. selftest)
    cb.checked = !was; cb.dispatchEvent(new Event('change', { bubbles: true }));
    if (!(await window.__t.until(async () => (await window.api.getSettings()).data.autoLive === !was, 3000))) { await window.__t.wait(300); }
    if ((await window.api.getSettings()).data.autoLive !== !was) return false;
    cb.checked = was; cb.dispatchEvent(new Event('change', { bubbles: true }));
    await window.__t.wait(500);
    return (await window.api.getSettings()).data.autoLive === was && was === false;
  })()`);
  await check('Asetukset: virheellinen autoLive hylätään (BAD_INPUT)', `window.api.setSettings({ autoLive: 'kyllä' }).then((r) => !r.ok && r.error.code === 'BAD_INPUT')`);

  // ======================= 1b. Taustatila: tray, --hidden-käynnistys, sulkeminen trayhin, Windows-käynnistys (kaikki näkymättömästi) =======================
  // Ikkunaa ei näytetä eikä oikeaa trayta luoda: näyttö/piilotus, Tray ja Windowsin käynnistysasetus ovat main.js:ssä kirjaavia tekaistuja toteutuksia (hooks.bg).
  if (hooks && hooks.bg) {
    const bg = hooks.bg;
    const hiddenRun = process.argv.includes('--hidden');
    const t0 = bg.tray();
    if (t0 && !t0.destroyed && t0.tooltip === 'Statsikka' && !t0.empty && t0.size.width === 16 && t0.size.height === 16 && t0.scales.includes(2) && t0.doubleClick &&
      t0.labels.join('|') === 'Avaa Statsikka|-|Overwatch 2|Rocket League|Rainbow Six Siege|-|Lopeta') pass('Tray: kuvake (16 px + @2x), tooltip "Statsikka", valikko (Avaa, OW2 / RL / R6, Lopeta) ja kaksoisnapsautus luotu virheittä');
    else fail('Tray: kuvake, tooltip ja valikko', JSON.stringify(t0));
    // Käynnistys: ilman --hidden-argumenttia ikkuna näytetään (ready-to-show), --hidden-argumentilla se jää piiloon (suoraan trayhin).
    if (!hiddenRun) {
      const end = Date.now() + 8000;
      while (!bg.state().startupShown && Date.now() < end) await sleep(100);
      if (bg.state().startedHidden === false && bg.state().startupShown) pass('Käynnistys ilman --hidden: ikkuna näytetään normaalisti (ready-to-show)'); else fail('Käynnistys ilman --hidden', JSON.stringify(bg.state()));
    } else {
      await sleep(3500); // ready-to-show on ehtinyt laueta, jos se tulisi
      const s = bg.state();
      if (s.startedHidden === true && s.startupShown === false && s.argv.includes('--hidden') && s.inactive === 0 && s.focused.length === 0) pass('Käynnistys --hidden: ikkunaa ei näytetä, sovellus jää trayhin');
      else fail('Käynnistys --hidden', JSON.stringify(s));
    }
    // Sulkeminen: runInBackground päällä -> piilotetaan trayhin (ei suljeta); pois -> normaali sulkeminen; Ctrl+Q lopettaa; toinen käynnistys tuo esiin
    bg.reset();
    const c1 = bg.close();
    if (c1.prevented && c1.hides === 1) pass('Ikkunan sulkeminen (runInBackground päällä): sulkeminen estetään ja ikkuna piilotetaan trayhin'); else fail('Ikkunan sulkeminen piilottaa trayhin', JSON.stringify(c1));
    const k1 = bg.key({ type: 'keyDown', key: 'q', control: true, shift: false, alt: false, meta: false });
    const k2 = bg.key({ type: 'keyDown', key: 'w', control: true, shift: false, alt: false, meta: false });
    if (k1.prevented && k1.quits === 1 && !k2.prevented && k2.quits === 1) pass('Ctrl+Q lopettaa sovelluksen (muut näppäimet eivät)'); else fail('Ctrl+Q', JSON.stringify([k1, k2]));
    bg.secondInstance(['x.exe', '.']);
    bg.secondInstance(['x.exe', '.', '--hidden']);
    if (bg.state().focused.join() === 'second-instance') pass('Toinen käynnistys (Kaynnista.bat) tuo piilossa olevan ikkunan esiin; Windowsin --hidden-käynnistys ei'); else fail('Toinen käynnistys', JSON.stringify(bg.state().focused));
    bg.reset();
    bg.trayClick('Avaa Statsikka'); bg.trayDoubleClick();
    bg.trayClick('Lopeta');
    bg.trayClick('Rocket League');
    const ts = bg.state();
    if (ts.focused.join() === 'tray,tray,tray-rl' && ts.quits === 1 && ts.inactive === 0) pass('Tray-valikko: Avaa / kaksoisnapsautus näyttää ikkunan (kohdistus), Lopeta lopettaa, pelivalinta avaa ikkunan'); else fail('Tray-valikko', JSON.stringify(ts));
    await waitCheck('Tray-valikko: "Rocket League" vie RL:n Live-peliin', `document.body.dataset.game === 'rl' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli'`, 4000);
    await ev(nav('me'));
    bg.setVisible(null); bg.reset();

    // Asetuskortti "Tausta ja käynnistys": kolme valintaruutua, tallennus levylle, tray syntyy/poistuu, Windows-käynnistyksen argumentit
    await check('Asetukset: "Tausta ja käynnistys" -kortti (3 valintaruutua, selitykset, tray-huomautus)', `(async () => {
      ${nav('settings')};
      if (!(await window.__t.until(() => window.__t.vis().querySelector('.bg-settings .run-bg'), 6000))) return false;
      const c = window.__t.vis().querySelector('.bg-settings'), s = (await window.api.getSettings()).data;
      return c.querySelector('h2').textContent === 'Tausta ja käynnistys' && c.querySelectorAll('input[type=checkbox]').length === 3 &&
        c.querySelector('.run-bg').checked === s.runInBackground && c.querySelector('.open-launch').checked === s.openOnGameLaunch && c.querySelector('.start-win').checked === s.startWithWindows &&
        s.runInBackground === true && s.startWithWindows === false &&
        c.textContent.includes('Ctrl+Q') && c.textContent.includes('ilman kohdistusta') && c.textContent.includes('ilmaisinalueen kuvakkeeseen') && c.textContent.includes('Kaynnista.bat');
    })()`);
    await ev(`(() => { window.__t.vis().querySelector('.bg-settings').scrollIntoView(); return true; })()`);
    await shot('asetukset-tausta');
    await check('Asetukset: virheelliset taustatilan arvot hylätään (BAD_INPUT), tuntematon avain hylätään', `Promise.all([
      window.api.setSettings({ runInBackground: 'kyllä' }), window.api.setSettings({ openOnGameLaunch: 1 }), window.api.setSettings({ startWithWindows: null }), window.api.setSettings({ startWithWindows: 'true' }),
    ]).then((rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT'))`);
    if (bg.state().login.calls.length === 0) pass('Windows-käynnistykseen ei kosketa ennen käyttäjän valintaa (savutestissä vain tekaistu toteutus)'); else fail('Windows-käynnistykseen ei kosketa', JSON.stringify(bg.state().login));
    await check('Asetukset: "Toimi taustalla" pois -> tray poistuu, asetus tallentuu levylle; päälle -> tray luodaan uudelleen', `(async () => {
      const v = window.__t.vis(), cb = () => v.querySelector('.bg-settings .run-bg');
      cb().checked = false; cb().dispatchEvent(new Event('change', { bubbles: true }));
      if (!(await window.__t.until(async () => (await window.api.getSettings()).data.runInBackground === false, 4000))) return false;
      return true;
    })()`);
    const settingsFile = () => JSON.parse(require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'statsikka-smoke', 'settings.json'), 'utf8'));
    {
      const gone = bg.tray();
      const c2 = bg.close();
      if (gone && gone.destroyed && settingsFile().runInBackground === false && !c2.prevented && c2.hides === 0) pass('Toimi taustalla pois: tray poistettu, tiedostoon tallennettu, ikkunan sulkeminen sulkee normaalisti (ei piilotusta)');
      else fail('Toimi taustalla pois', JSON.stringify({ gone, c2, file: settingsFile().runInBackground }));
    }
    await check('Asetukset: "Toimi taustalla" päälle -> uusi tray ja sulkeminen piilottaa taas', `(async () => {
      const v = window.__t.vis(), cb = v.querySelector('.bg-settings .run-bg');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return await window.__t.until(async () => (await window.api.getSettings()).data.runInBackground === true, 4000);
    })()`);
    {
      const t1 = bg.tray(), c3 = bg.close();
      if (t1 && !t1.destroyed && t1.labels.length === 7 && c3.prevented && settingsFile().runInBackground === true) pass('Toimi taustalla päälle: tray luotu uudelleen ja ikkunan sulkeminen piilottaa'); else fail('Toimi taustalla päälle', JSON.stringify({ t1, c3 }));
      bg.reset();
    }
    await check('Asetukset: "Avaa pelin käynnistyessä" -valintaruutu kytkee asetuksen päälle ja pois (tallentuu levylle)', `(async () => {
      const v = window.__t.vis(), cb = () => v.querySelector('.bg-settings .open-launch');
      const was = cb().checked;
      cb().checked = !was; cb().dispatchEvent(new Event('change', { bubbles: true }));
      if (!(await window.__t.until(async () => (await window.api.getSettings()).data.openOnGameLaunch === !was, 4000))) return false;
      cb().checked = was; cb().dispatchEvent(new Event('change', { bubbles: true }));
      return await window.__t.until(async () => (await window.api.getSettings()).data.openOnGameLaunch === was, 4000);
    })()`);
    if (settingsFile().openOnGameLaunch === false) pass('Avaa pelin käynnistyessä: tallennettu arvo säilyi levyllä (savutestissä aluksi pois)'); else fail('Avaa pelin käynnistyessä tallentuu', String(settingsFile().openOnGameLaunch));
    await check('Asetukset: "Käynnistä Windowsin mukana" päälle -> todellinen tila päällä; pois -> pois', `(async () => {
      const v = window.__t.vis(), cb = () => v.querySelector('.bg-settings .start-win');
      cb().checked = true; cb().dispatchEvent(new Event('change', { bubbles: true }));
      if (!(await window.__t.until(async () => (await window.api.getSettings()).data.startWithWindows === true && cb().checked === true, 4000))) return false;
      cb().checked = false; cb().dispatchEvent(new Event('change', { bubbles: true }));
      return await window.__t.until(async () => (await window.api.getSettings()).data.startWithWindows === false && cb().checked === false, 4000);
    })()`);
    {
      const st = bg.state(), calls = st.login.calls;
      const want = [st.appPath, '--hidden'].concat(st.hasOverwolf ? ['--owepm-package-channel=gep:dev'] : []);
      if (calls.length === 2 && calls[0].openAtLogin === true && calls[0].path === st.execPath && JSON.stringify(calls[0].args) === JSON.stringify(want) && calls[1].openAtLogin === false && JSON.stringify(calls[1].args) === JSON.stringify(want) && settingsFile().startWithWindows === false)
        pass(`Windows-käynnistys: setLoginItemSettings-kutsut (päälle, pois) polulla execPath, argumentit ${JSON.stringify(want.slice(1))}, tila tallentuu`);
      else fail('Windows-käynnistyksen kutsut', JSON.stringify({ calls, want }));
    }
    await ev(nav('me'));
    bg.reset();
  }

  // ======================= 2. Kirjautumiskortit (profiilia ei vielä asetettu) =======================
  const NOTE = 'Salasanaa ei tarvita eikä kysytä – profiili yhdistetään nimellä.';
  await check('OW > Oma profiili: Kirjaudu omaan profiiliin (BattleTag, alusta, Tarkista, Tallenna, salasanahuomautus)', `(async () => {
    ${go('ow', 'Oma profiili')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.link-card form')))) return false;
    const v = window.__t.vis(), c = v.querySelector('.link-card');
    return c.textContent.includes('Kirjaudu omaan profiiliin') && c.textContent.includes(${JSON.stringify(NOTE)}) && !!c.querySelector('input[type=text]') &&
      [...c.querySelectorAll('.seg button')].map((b) => b.textContent).join() === 'PC,Konsoli' && !!window.__t.btn('Tarkista', c) && !!window.__t.btn('Tallenna', c) && !c.querySelector('input[type=password]');
  })()`);
  await check('RL > Oma profiili: Kirjaudu (pelinimi, alusta, Tallenna, salasanahuomautus)', `(async () => {
    ${go('rl', 'Oma profiili')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.link-card form')))) return false;
    const c = window.__t.vis().querySelector('.link-card');
    return c.textContent.includes(${JSON.stringify(NOTE)}) && !!c.querySelector('input[type=text]') && c.querySelectorAll('select option').length === 5 && !!window.__t.btn('Tallenna', c);
  })()`);
  await check('R6 > Oma profiili: Kirjaudu (Ubisoft-nimi, Tallenna, salasanahuomautus)', `(async () => {
    ${go('r6', 'Oma profiili')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.link-card form')))) return false;
    const c = window.__t.vis().querySelector('.link-card');
    return c.textContent.includes(${JSON.stringify(NOTE)}) && c.textContent.includes('Ubisoft-nimi') && !!c.querySelector('input[type=text]') && !!window.__t.btn('Tallenna', c);
  })()`);
  await check('R6: "tulossa"-merkki ja "ei datalähdettä" -tekstit poistettu', `(() => {
    const nav = document.querySelector('.nav-item[data-game=r6]');
    return !nav.querySelector('.tag') && !nav.classList.contains('disabled-look') && !!document.getElementById('r6-dot') && !document.body.textContent.includes('Tulossa');
  })()`);
  await shot('ow-oma-kirjautumaton');

  // ======================= 3. Kirjautuminen käyttöliittymästä =======================
  await check('OW: virheellinen BattleTag hylätään (ei tallennu, virheilmoitus)', `(async () => {
    ${go('ow', 'Oma profiili')};
    await window.__t.until(() => window.__t.vis().querySelector('.link-card form'));
    const f = window.__t.vis().querySelector('.link-card form');
    window.__t.set(f.querySelector('input[type=text]'), 'roska'); f.requestSubmit();
    if (!(await window.__t.until(() => window.__t.toast('Virheellinen BattleTag', true)))) return false;
    const s = await window.api.getSettings();
    return s.data.owProfile.battletag === '' && !!window.__t.vis().querySelector('.link-card');
  })()`);
  await check('OW: Tarkista keinotekoisella profiilista (offline) näyttää nimen', `(async () => {
    const c = window.__t.vis().querySelector('.link-card');
    window.__t.set(c.querySelector('input[type=text]'), 'Synth#1111'); window.__t.btn('Tarkista', c).click();
    return await window.__t.until(() => c.querySelector('.check-out').textContent.includes('SynthHacker') && c.querySelector('.check-out').textContent.includes('Profiili löytyi'));
  })()`);
  await check('OW: Tarkista olemattomalla tunnuksella antaa virheen (ei kaadu)', `(async () => {
    const c = window.__t.vis().querySelector('.link-card');
    window.__t.set(c.querySelector('input[type=text]'), 'Zzqxkv#99999'); window.__t.btn('Tarkista', c).click();
    return await window.__t.until(() => c.querySelector('.check-out .errbox'), 20000);
  })()`);
  await check('OW: Tallenna kirjaa profiilin (sama asetus kuin Asetuksissa) ja näyttää tilirivin', `(async () => {
    const c = window.__t.vis().querySelector('.link-card');
    window.__t.set(c.querySelector('input[type=text]'), 'TeKrop#2217'); c.querySelector('form').requestSubmit();
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.account-bar') && window.__t.vis().querySelector('.ow-section'), 10000))) return false;
    const s = (await window.api.getSettings()).data;
    const bar = window.__t.vis().querySelector('.account-bar');
    return s.owProfile.battletag === 'TeKrop#2217' && bar.textContent.includes('TeKrop#2217') && !!window.__t.btn('Vaihda profiili', bar) && !!window.__t.btn('Kirjaudu ulos', bar);
  })()`);
  await check('OW: Vaihda profiili avaa esitäytetyn lomakkeen; Peruuta palauttaa osion', `(async () => {
    const v = window.__t.vis();
    window.__t.btn('Vaihda profiili', v).click();
    if (!(await window.__t.until(() => v.querySelector('.link-card input[type=text]')))) return false;
    const c = v.querySelector('.link-card');
    if (c.querySelector('input[type=text]').value !== 'TeKrop#2217') return false;
    window.__t.btn('Peruuta', c).click();
    return await window.__t.until(() => v.querySelector('.ow-section') && !v.querySelector('.link-card'));
  })()`);
  await check('OW: toiseen BattleTagiin vaihto kysyy vahvistuksen; Peruuta ei muuta asetusta', `(async () => {
    const v = window.__t.vis();
    window.__t.btn('Vaihda profiili', v).click();
    await window.__t.until(() => v.querySelector('.link-card input[type=text]'));
    const c = v.querySelector('.link-card');
    window.__t.set(c.querySelector('input[type=text]'), 'Toinen#9999'); c.querySelector('form').requestSubmit();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta')))) return false;
    if (!document.querySelector('#modal-root').textContent.includes('Kehityshistoria')) return false;
    window.__t.modalBtn('Peruuta').click();
    await window.__t.wait(300);
    const s = (await window.api.getSettings()).data;
    window.__t.btn('Peruuta', v.querySelector('.link-card')).click();
    return s.owProfile.battletag === 'TeKrop#2217' && !document.querySelector('#modal-root .modal');
  })()`);
  await check('OW: Kirjaudu ulos kysyy vahvistuksen (Peruuta säilyttää, vahvistus tyhjentää asetuksen)', `(async () => {
    const v = window.__t.vis();
    await window.__t.until(() => window.__t.btn('Kirjaudu ulos', v));
    window.__t.btn('Kirjaudu ulos', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta')))) return false;
    window.__t.modalBtn('Peruuta').click(); await window.__t.wait(300);
    if ((await window.api.getSettings()).data.owProfile.battletag !== 'TeKrop#2217') return false;
    window.__t.btn('Kirjaudu ulos', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Kirjaudu ulos')))) return false;
    window.__t.modalBtn('Kirjaudu ulos').click();
    if (!(await window.__t.until(() => v.querySelector('.link-card form')))) return false;
    const s = (await window.api.getSettings()).data;
    return s.owProfile.battletag === '' && !v.querySelector('.account-bar');
  })()`);
  await check('OW: uudelleenkirjautuminen toimii uloskirjauksen jälkeen', `(async () => {
    const v = window.__t.vis(), c = v.querySelector('.link-card');
    window.__t.set(c.querySelector('input[type=text]'), 'TeKrop#2217'); c.querySelector('form').requestSubmit();
    return await window.__t.until(() => v.querySelector('.account-bar') && v.querySelector('.ow-section'), 10000);
  })()`);

  await check('RL: kirjautuminen nimellä ja alustalla (tilirivi + RL-osio)', `(async () => {
    ${go('rl', 'Oma profiili')};
    const v = window.__t.vis();
    if (!(await window.__t.until(() => v.querySelector('.link-card form')))) return false;
    const c = v.querySelector('.link-card');
    c.querySelector('select').value = 'steam';
    window.__t.set(c.querySelector('input[type=text]'), 'Akseli'); c.querySelector('form').requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.account-bar') && v.querySelector('.rl-section'), 10000))) return false;
    const s = (await window.api.getSettings()).data;
    return s.rlOwnName === 'Akseli' && s.rlPlatform === 'steam' && v.querySelector('.account-bar').textContent.includes('Akseli');
  })()`);
  await check('RL: tyhjä nimi hylätään; Kirjaudu ulos vahvistuksella ja uudelleenkirjautuminen', `(async () => {
    const v = window.__t.vis();
    window.__t.btn('Vaihda profiili', v).click();
    await window.__t.until(() => v.querySelector('.link-card input[type=text]'));
    window.__t.set(v.querySelector('.link-card input[type=text]'), ''); v.querySelector('.link-card form').requestSubmit();
    if (!(await window.__t.until(() => window.__t.toast('Anna pelinimesi', true)))) return false;
    window.__t.btn('Peruuta', v.querySelector('.link-card')).click();
    await window.__t.until(() => v.querySelector('.account-bar'));
    window.__t.btn('Kirjaudu ulos', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Kirjaudu ulos')))) return false;
    window.__t.modalBtn('Kirjaudu ulos').click();
    if (!(await window.__t.until(() => v.querySelector('.link-card form')))) return false;
    if ((await window.api.getSettings()).data.rlOwnName !== '') return false;
    const c = v.querySelector('.link-card');
    c.querySelector('select').value = 'steam';
    window.__t.set(c.querySelector('input[type=text]'), 'Akseli'); c.querySelector('form').requestSubmit();
    return await window.__t.until(() => v.querySelector('.account-bar') && v.querySelector('.rl-section'), 10000);
  })()`);
  await check('R6: kirjautuminen Ubisoft-nimellä, uloskirjaus ja uudelleenkirjautuminen', `(async () => {
    ${go('r6', 'Oma profiili')};
    const v = window.__t.vis();
    if (!(await window.__t.until(() => v.querySelector('.link-card form')))) return false;
    window.__t.set(v.querySelector('.link-card input[type=text]'), 'SmokeR6'); v.querySelector('.link-card form').requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.account-bar') && v.querySelector('.r6-own') && v.textContent.includes('Match Replay'), 10000))) return false;
    if ((await window.api.getSettings()).data.r6Name !== 'SmokeR6') return false;
    window.__t.btn('Kirjaudu ulos', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Kirjaudu ulos')))) return false;
    window.__t.modalBtn('Kirjaudu ulos').click();
    if (!(await window.__t.until(() => v.querySelector('.link-card form')))) return false;
    if ((await window.api.getSettings()).data.r6Name !== '') return false;
    window.__t.set(v.querySelector('.link-card input[type=text]'), 'SmokeR6'); v.querySelector('.link-card form').requestSubmit();
    return await window.__t.until(() => v.querySelector('.account-bar'), 10000);
  })()`);
  await check('Oma profiili -koostenäkymä näyttää kaikki kolme linkitettyä peliä (sama asetus)', `(async () => {
    ${nav('me')}; const v = window.__t.vis();
    return await window.__t.until(() => v.querySelectorAll('.add-card').length === 0 && v.querySelector('.ow-section') && v.querySelector('.rl-section') && v.textContent.includes('SmokeR6'), 8000);
  })()`);

  // ======================= 4. IPC: validointi =======================
  await check('IPC settings:get', "window.api.getSettings().then((r) => r.ok && r.data.rlWebPort > 0 && r.data.owProfile.platform === 'pc' && r.data.owGamemode === 'competitive' && r.data.suspicionSensitivity === 'normal')");
  await check('IPC app:info (versio)', "window.api.appInfo().then((r) => r.ok && /^\\d+\\.\\d+\\.\\d+$/.test(r.data.version) && !!r.data.electron)");
  await check('IPC updater:state: savutestissä päivitykset pois (dev/disabled), nykyinen versio 1.2.0', "window.api.updaterState().then((r) => r.ok && (r.data.state === 'dev' || r.data.state === 'disabled') && r.data.current === '1.2.0' && r.data.enabled === false && r.data.text === 'Päivitykset ovat käytössä vain asennetussa versiossa.')");
  await check('IPC updater:check ja updater:install: no-op / virhe savutestissä, tila ei muutu', `Promise.all([window.api.updaterCheck(), window.api.updaterInstall()]).then(([c, i]) => c.ok && (c.data.state === 'dev' || c.data.state === 'disabled') && !i.ok)`);
  await check('Asetukset: "Päivitykset" -kortti (versio 1.2.0, dev-teksti, napit pois käytöstä, ei uudelleenkäynnistysnappia)', `(async () => {
    ${nav('settings')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.upd-settings .upd-state'), 6000))) return false;
    const c = window.__t.vis().querySelector('.upd-settings');
    return c.querySelector('h2').textContent === 'Päivitykset' && c.querySelector('.upd-version').textContent === '1.2.0' &&
      c.querySelector('.upd-state').textContent === 'Päivitykset ovat käytössä vain asennetussa versiossa.' &&
      window.__t.btn('Tarkista päivitykset', c).disabled === true && !c.querySelector('.upd-install') && !window.__t.btn('Käynnistä uudelleen ja päivitä', c);
  })()`);
  await check('IPC rl:history', "window.api.rlHistory().then((r) => r.ok && Array.isArray(r.data.matches))");
  await check('IPC validointi (huono BattleTag, alusta, pelitila)', "Promise.all([window.api.owProfile({ ref: '../x', gamemode: 'competitive', platform: 'pc' }), window.api.owProfile({ ref: 'TeKrop-2217', gamemode: 'arcade', platform: 'pc' }), window.api.owProfile({ ref: 'TeKrop-2217', gamemode: 'competitive', platform: 'ps' }), window.api.owProfile(null), window.api.owSearch('a b'), window.api.owSearch('')]).then((rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT'))");
  await check('IPC settings:set hylkää virheellisen (portti, tuntematon avain, sisäiset avaimet, tyypit, enumit)', `Promise.all([
    window.api.setSettings({ rlWebPort: 80 }), window.api.setSettings({ rlWebPort: 'abc' }), window.api.setSettings({ evil: 1 }),
    window.api.setSettings({ rlInstallDir: 'C:\\\\Windows' }), window.api.setSettings({ rlOwnId: 'x' }), window.api.setSettings({ owPlatform: 'xbox' }),
    window.api.setSettings({ owGamemode: 'arcade' }), window.api.setSettings({ suspicionSensitivity: 'max' }), window.api.setSettings({ r6Name: 5 }),
    window.api.setSettings({ owProfile: { battletag: 'roska' } }), window.api.setSettings({ owProfile: { platform: 'ps' } }), window.api.setSettings(null), window.api.setSettings({}),
  ]).then((rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT'))`);
  await check('IPC r6:assess: kelvollinen arvio ja tiukka validointi', `(async () => {
    const ok = await window.api.r6Assess({ matches: 200, kd: 3.4, hsPercent: 80, kills: 4000 });
    if (!ok.ok || ok.data.level !== 'suspicious' || ok.data.score !== 4) return false;
    const bad = await Promise.all([window.api.r6Assess(null), window.api.r6Assess({}), window.api.r6Assess({ matches: -1 }), window.api.r6Assess({ matches: 50, rank: 'Foo' }), window.api.r6Assess({ matches: 50, evil: 1 }), window.api.r6Assess({ matches: 50, kd: 99 })]);
    return bad.every((r) => !r.ok && r.error.code === 'BAD_INPUT');
  })()`);
  await check('IPC openExternal hylkää http; copy hylkää liian pitkän; rl:inspect/enable hylkäävät tuntemattoman kansion', `Promise.all([
    window.api.openExternal('http://example.com'), window.api.copyText('x'.repeat(2001)), window.api.rlInspect('C:\\\\Windows'), window.api.rlEnable('C:\\\\Windows'),
  ]).then((rs) => rs.every((r) => !r.ok))`);
  await check('IPC profiilin validointi (rank, prosentti, id, ei BattleTagia)', `(async () => {
    const keep = (await window.api.getSettings()).data.owProfile;
    const rs = await Promise.all([
      window.api.profileRlRank({ playlist: 'standard', rank: 99, division: 1 }),
      window.api.profileRlRank({ playlist: 'standard', rank: 3, division: 1, mmr: 1000, nextMmr: 900 }),
      window.api.profileOwProgress({ role: 'tank', percent: 150 }),
      window.api.profileOwProgress({ role: 'nope', percent: 5 }),
      window.api.profileRlRankDelete('../x'),
      window.api.profileOwProgressDelete(5),
    ]);
    return rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT') && keep.battletag === 'TeKrop#2217';
  })()`);

  // ======================= 5. Oma profiili: tiedot (OW, RL, R6) =======================
  await check('Omat profiilit tallentuvat asetuksiin (IPC)', "window.api.setSettings({ owProfile: { battletag: 'TeKrop#2217', platform: 'pc' }, rlOwnName: 'Akseli', rlPlatform: 'steam', r6Name: 'SmokeR6' }).then((r) => r.ok && r.data.owProfile.battletag === 'TeKrop#2217' && r.data.rlPlatform === 'steam' && r.data.r6Name === 'SmokeR6')");
  let owNet = 'ei yritetty';
  try {
    owNet = await ev("window.api.profileOwRefresh().then((r) => r.ok ? 'ok' : 'virhe:' + r.error.code)");
  } catch (e) { owNet = `poikkeus: ${e.message}`; }
  info(`oman OW-profiilin haku: ${owNet}`);
  const online = owNet === 'ok';
  if (hooks && hooks.seedOw) hooks.seedOw(owSeed(Date.now()));

  await check('Oma profiili: OW-kortit (3 roolia) ja tilat renderöityvät', `(async () => {
    ${nav('me')}; await new Promise((r) => setTimeout(r, 900));
    const q = (s) => window.__t.vis().querySelectorAll('.ow-section ' + s).length;
    return q('.ow-rank-card') >= 3 && q('.rv.big') >= 1 && q('.rc-next') >= 1 && q('.tiles .tile') === 6 && q('.delta-grid') === 2;
  })()`, "(() => { const q = (s) => window.__t.vis().querySelectorAll('.ow-section ' + s).length; return { cards: q('.ow-rank-card'), big: q('.rv.big'), next: q('.rc-next'), tiles: q('.tiles .tile'), delta: q('.delta-grid'), banner: (document.querySelector('#view .ow-section .banner, #view .ow-section .errbox') || {}).textContent }; })()");
  await check('Oma profiili: OW-kaaviot piirtyvät (svg, pisteet, otsikot)', "(() => { const c = window.__t.vis().querySelectorAll('.ow-section .chart-svg'); return c.length === 3 && [...c].every((s) => s.querySelectorAll('circle').length >= 2 && s.querySelectorAll('circle > title').length >= 2 && s.getAttribute('viewBox')); })()");
  await check('Oma profiili: kaavioissa on viiva (path)', "window.__t.vis().querySelectorAll('.ow-section .chart-svg path.ch-line').length >= 1");
  if (!online) {
    await check('Oma profiili: voittoarvio näkyy (seed-merkinnät)', "(() => { const t = document.querySelector('.ow-section').textContent; return t.includes('noin 5 voittoa seuraavaan rankiin (arvio)') && t.includes('Seuraava: Hopea 3'); })()");
  }
  await check('Oma profiili: edistymisen kirjaus lomakkeella', `(() => {
    const f = document.querySelector('.ow-rank-card .pct-form');
    if (!f) return false;
    f.querySelector('input').value = '65'; f.requestSubmit(); return true;
  })()`);
  await waitCheck('Oma profiili: kirjattu edistyminen näkyy listassa', "[...document.querySelectorAll('.ow-rank-card .entries li')].some((li) => li.textContent.includes('65 %'))");
  await check('IPC profile:get sisältää kirjatun edistymisen', "window.api.profileGet().then((r) => r.ok && r.data.ow.roles.some((x) => x.progress && x.progress.lastPercent === 65))");
  await check('Oma profiili: virheellinen edistymisprosentti hylätään lomakkeella', `(async () => {
    const f = document.querySelector('.ow-rank-card .pct-form'); f.noValidate = true; f.querySelector('input').value = '150'; f.requestSubmit();
    return await window.__t.until(() => window.__t.toast('luku 0–100', true));
  })()`);
  await check('Oma profiili: edistymismerkinnän poisto napista', `(async () => {
    const li = [...document.querySelectorAll('.ow-rank-card .entries li')].find((x) => x.textContent.includes('65 %'));
    if (!li) return false;
    const before = document.querySelectorAll('.ow-rank-card .entries li').length;
    window.__t.btn('Poista', li).click();
    return await window.__t.until(() => ![...document.querySelectorAll('.ow-rank-card .entries li')].some((x) => x.textContent.includes('65 %')) && document.querySelectorAll('.ow-rank-card .entries li').length === before - 1);
  })()`);

  await check('RL-rankin kirjaus IPC:llä (kaksi merkintää)', `(async () => {
    const a = await window.api.profileRlRank({ playlist: 'standard', rank: 8, division: 2, mmr: 1000, nextMmr: 1090 });
    const b = await window.api.profileRlRank({ playlist: 'standard', rank: 8, division: 2, mmr: 1000, nextMmr: 1090 });
    return a.ok && b.ok && a.data.value === 33 && a.data.id !== b.data.id;
  })()`);
  await check('Oma profiili: RL-rankki, seuraava ja MMR-tarve näkyvät', `(async () => {
    ${nav('me')}; await new Promise((r) => setTimeout(r, 900));
    const c = document.querySelector('.rl-section .rl-rank-card'); if (!c) return false;
    const t = c.textContent;
    return t.includes('Standard 3v3') && t.includes('Gold III, Div 2') && t.includes('Seuraava: Gold III, Div 3') && t.includes('+90 MMR tarvitaan') && t.includes('noin 10 voittoa') && t.includes('~9 MMR/voitto');
  })()`);
  await check('Oma profiili: RL-lomake ja rankkikaavio', "(() => { const s = document.querySelector('.rl-section'); return !!s.querySelector('.rl-form') && s.querySelectorAll('.chart').length >= 3; })()");
  await check('RL-rankin lisäys ja poisto lomakkeella / napilla (UI)', `(async () => {
    const s = () => document.querySelector('.rl-section');
    const count = () => s().querySelectorAll('.rl-rank-card .entries li').length;
    const before = count();
    s().querySelector('.rl-form').requestSubmit();
    if (!(await window.__t.until(() => count() === before + 1 || s().querySelectorAll('.rl-rank-card .entries li').length > before))) return false;
    const now = count();
    window.__t.btn('Poista', s().querySelector('.rl-rank-card .entries li')).click();
    return await window.__t.until(() => count() === now - 1);
  })()`);
  await check('RL-rankin poisto IPC:llä', `(async () => {
    const d = await window.api.profileGet(); const pl = d.data.rl.playlists.find((p) => p.key === 'standard');
    const r = await window.api.profileRlRankDelete(pl.entries[pl.entries.length - 1].id);
    const d2 = await window.api.profileGet();
    return r.ok && r.data === true && d2.data.rl.playlists.find((p) => p.key === 'standard').entries.length === pl.entries.length - 1;
  })()`);
  await check('Oma profiili: R6-osio näyttää nimen ja tallennekansion tilan (ei vielä tallenteita luettu)', `(async () => {
    ${nav('me')}; await new Promise((r) => setTimeout(r, 700));
    const v = window.__t.vis();
    return v.textContent.includes('SmokeR6') && !!v.querySelector('.r6-section .r6-own') && !v.textContent.includes('Tilastoja ei vielä saatavilla');
  })()`);
  await check('Pelikohtainen Oma profiili käyttää samaa renderöijää (OW- ja RL-välilehdillä samat osiot kuin koosteessa)', `(async () => {
    ${go('ow', 'Oma profiili')}; const a = await window.__t.until(() => window.__t.vis().querySelectorAll('.ow-rank-card').length >= 3 && window.__t.vis().querySelectorAll('.chart-svg').length === 3);
    ${go('rl', 'Oma profiili')}; const b = await window.__t.until(() => window.__t.vis().querySelectorAll('.rl-rank-card').length >= 1 && window.__t.vis().querySelector('.rl-form'));
    ${go('r6', 'Oma profiili')}; const c = await window.__t.until(() => window.__t.vis().textContent.includes('SmokeR6'));
    return a && b && c;
  })()`);
  await check('Asetukset: Omat profiilit -osio (BattleTag, Tarkista, RL, R6)', `(async () => {
    ${nav('settings')}; await new Promise((r) => setTimeout(r, 700));
    const v = window.__t.vis();
    const vals = [...v.querySelectorAll('input')].map((i) => i.value);
    return v.textContent.includes('Omat profiilit') && vals.includes('TeKrop#2217') && vals.includes('Akseli') && vals.includes('SmokeR6') && [...v.querySelectorAll('button')].some((b) => b.textContent === 'Tarkista');
  })()`);
  await ev("(async () => { document.querySelector('.nav-item[data-game=me]').click(); await new Promise((r) => setTimeout(r, 900)); document.getElementById('view').scrollTop = 0; return true; })()");
  await shot('own-profile');
  if (process.env.ST_SHOTS) {
    for (const [n, y] of [['own-profile-2', 700], ['own-profile-3', 1400], ['own-profile-4', 2100]]) {
      await ev(`document.getElementById('view').scrollTop = ${y}; true`);
      await shot(n);
    }
    await ev("document.getElementById('view').scrollTop = 0; true");
  }

  // ======================= 6. Epätavalliset tilastot: oma profiili =======================
  if (hooks && hooks.setOwnProfile) {
    hooks.setOwnProfile(synthProfile('suspicious', 'SynthHacker', 'Synth-1111'));
    await check('Oma OW-profiili (keinotekoinen): merkki "Mahdollinen hakkeri", perusteet aukeavat, Tarkkuus-kortti', `(async () => {
      ${go('ow', 'Oma profiili')};
      if (!(await window.__t.until(() => window.__t.vis().querySelector('.susp.suspicious'), 8000))) {
        window.__t.nav('me'); await window.__t.wait(300); ${go('ow', 'Oma profiili')};
        if (!(await window.__t.until(() => window.__t.vis().querySelector('.susp.suspicious'), 8000))) return false;
      }
      const v = window.__t.vis(), d = v.querySelector('.susp.suspicious');
      if (!d.textContent.includes('Mahdollinen hakkeri') || d.open) return false;
      d.querySelector('summary').click();
      if (!d.open) return false;
      const t = d.textContent;
      return d.querySelectorAll('.susp-reasons li').length >= 4 && t.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.') && t.includes('Widowmaker') &&
        !!v.querySelector('.accuracy-card') && v.querySelectorAll('.accuracy-card tbody tr').length === 3 && v.querySelectorAll('.accuracy-card td.acc-over').length >= 3;
    })()`);
    await shot('own-profile-suspicious');
    await check('Oma OW-profiili: herkkyys Pois piilottaa merkin, Tiukka näyttää tasoa kovempana, Normaali palauttaa', `(async () => {
      const lv = async (s) => { await window.api.setSettings({ suspicionSensitivity: s }); const d = (await window.api.profileGet()).data; return d.ow.profile.suspicion ? d.ow.profile.suspicion.level : null; };
      const off = await lv('off'), strict = await lv('strict'), normal = await lv('normal');
      return off === null && strict === 'suspicious' && normal === 'suspicious';
    })()`);
    await check('Oma OW-profiili: Pois-herkkyydellä merkkiä ei piirretä', `(async () => {
      await window.api.setSettings({ suspicionSensitivity: 'off' });
      window.__t.nav('me'); await window.__t.wait(200); ${go('ow', 'Oma profiili')};
      await window.__t.wait(900);
      const none = !window.__t.vis().querySelector('.susp.suspicious') && !window.__t.vis().querySelector('.susp.watch');
      await window.api.setSettings({ suspicionSensitivity: 'normal' });
      return none;
    })()`);
    hooks.clearOwn();
  }

  // ======================= 7. OW-pelaajahaku =======================
  await check('OW-pelaajahaku: tyhjä haku antaa ilmoituksen', `(async () => {
    ${go('ow', 'Pelaajahaku')}; const v = window.__t.vis();
    v.querySelector('.search-form').requestSubmit();
    return await window.__t.until(() => window.__t.toast('Anna BattleTag', true));
  })()`);
  await check('OW-pelaajahaku #tagilla (keinotekoinen): profiili, merkki ja Tarkkuus-kortti', `(async () => {
    const v = window.__t.vis();
    window.__t.set(v.querySelector('.search-form input'), 'Synth#1111'); v.querySelector('.search-form').requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.profile-head h1') && v.querySelector('.profile-head h1').textContent === 'SynthHacker'))) return false;
    const d = v.querySelector('.profile-head .susp.suspicious');
    return !!d && d.textContent.includes('Mahdollinen hakkeri') && !!v.querySelector('.accuracy-card') && v.querySelectorAll('.tiles .tile').length === 9 && v.textContent.includes('Roolit') && v.textContent.includes('Parhaat hahmot');
  })()`);
  await check('OW-pelaajahaku: merkin perusteet aukeavat ja lauseke näkyy', `(async () => {
    const v = window.__t.vis(), d = v.querySelector('.profile-head .susp');
    d.querySelector('summary').click();
    return d.open && d.querySelectorAll('.susp-reasons li').length >= 4 && d.textContent.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.');
  })()`);
  await shot('ow-haku-hakkeri');
  await check('OW-pelaajahaku: Tarkkaile-taso (watch) ja puhdas profiili ilman merkkiä', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'Synth#2222'); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.profile-head h1') && v.querySelector('.profile-head h1').textContent === 'SynthWatcher'))) return false;
    const w = v.querySelector('.profile-head .susp.watch'); if (!w || !w.textContent.includes('Tarkkaile')) return false;
    window.__t.set(form.querySelector('input'), 'Synth#3333'); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.profile-head h1') && v.querySelector('.profile-head h1').textContent === 'SynthClean'))) return false;
    return !v.querySelector('.profile-head .susp') && v.querySelector('.profile-head').textContent.includes('Ei epätavallisia tilastoja');
  })()`);
  await check('OW-pelaajahaku: yksityinen profiili -ilmoitus', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'Priv#4444'); form.requestSubmit();
    return await window.__t.until(() => v.textContent.includes('Profiili on yksityinen') && !v.querySelector('.susp'));
  })()`);
  await check('OW-pelaajahaku: pelitila- ja alustavalinnat lataavat profiilin uudelleen', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'Synth#1111'); form.requestSubmit();
    await window.__t.until(() => v.querySelector('.profile-head h1') && v.querySelector('.profile-head h1').textContent === 'SynthHacker');
    window.__t.seg(form, 'Pikapeli');
    if (!(await window.__t.until(() => [...v.querySelectorAll('.profile-head .chip')].some((c) => c.textContent === 'Pikapeli')))) return false;
    window.__t.seg(form, 'Konsoli');
    if (!(await window.__t.until(() => [...v.querySelectorAll('.profile-head .chip')].some((c) => c.textContent === 'Konsoli')))) return false;
    window.__t.seg(form, 'Kilpailullinen'); window.__t.seg(form, 'PC');
    return await window.__t.until(() => [...v.querySelectorAll('.profile-head .chip')].some((c) => c.textContent === 'Kilpailullinen') && [...v.querySelectorAll('.profile-head .chip')].some((c) => c.textContent === 'PC'));
  })()`);
  await check('OW-pelaajahaku: viimeisimmät haut -chipit toimivat', `(async () => {
    const v = window.__t.vis();
    const chips = [...v.querySelectorAll('.card .row button.chip')];
    if (chips.length < 3 || !chips.some((c) => c.textContent === 'Synth#1111')) return false;
    window.__t.set(v.querySelector('.search-form input'), '');
    chips.find((c) => c.textContent === 'Synth#2222').click();
    return await window.__t.until(() => v.querySelector('.profile-head h1') && v.querySelector('.profile-head h1').textContent === 'SynthWatcher' && v.querySelector('.search-form input').value === 'Synth#2222');
  })()`);
  await check('OW-pelaajahaku: virheellinen nimi (väli) antaa virhekortin', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'a b'); form.requestSubmit();
    return await window.__t.until(() => v.querySelector('.errbox') && v.querySelector('.errbox').textContent.includes('Virheellinen nimi'));
  })()`);
  await check('OW-pelaajahaku: olematon tunniste ("nonsense") -> Pelaajaa ei löytynyt / verkkovirhe', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'Zzqxkv#99999'); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.errbox'), 25000))) return false;
    const t = v.querySelector('.errbox').textContent;
    return ${online} ? t.includes('Pelaajaa ei löytynyt') : (t.includes('Pelaajaa ei löytynyt') || t.includes('Verkkovirhe') || t.includes('Haku epäonnistui'));
  })()`);
  await check('OW-pelaajahaku: haku ilman tagia (ehdotukset tai virhe, ei kaadu); pelitilan vaihto ei palauta vanhaa profiilia', `(async () => {
    const v = window.__t.vis(), form = v.querySelector('.search-form');
    window.__t.set(form.querySelector('input'), 'TeKrop'); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelectorAll('.suggestion').length > 0 || v.querySelector('.errbox') || v.querySelector('.empty h3'), 25000))) return false;
    const ok = ${online} ? v.querySelectorAll('.suggestion').length > 0 : true;
    window.__t.seg(form, 'Pikapeli'); await window.__t.wait(500); window.__t.seg(form, 'Kilpailullinen');
    return ok && !v.querySelector('.profile-head h1') ;
  })()`);
  if (online) {
    await check('OW-pelaajahaku: ehdotuksen valinta avaa profiilin', `(async () => {
      const v = window.__t.vis();
      v.querySelector('.suggestion').click();
      return await window.__t.until(() => v.querySelector('.profile-head h1') || v.querySelector('.errbox'), 25000);
    })()`);
  }

  // ======================= 8. OW Live-lobby =======================
  await check('Lobby: tiimien paikat, Liitä nimet -> Täytä paikat täyttää kentät', `(async () => {
    ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
    if (v.querySelectorAll('.slot-input').length !== 10) return false;
    const area = v.querySelector('.team-col.ally textarea');
    area.value = 'Synth#1111, Synth#2222\\nSynth#3333'; window.__t.btn('Täytä paikat', v.querySelector('.team-col.ally')).click();
    const ins = v.querySelectorAll('.team-col.ally .slot-input');
    return ins[0].value === 'Synth#1111' && ins[1].value === 'Synth#2222' && ins[2].value === 'Synth#3333' && ins[3].value === '' && area.value === '';
  })()`);
  await check('Lobby: vihollispaikat (virheellinen nimi, yksityinen, tavallinen)', `(async () => {
    const v = window.__t.vis(), ins = v.querySelectorAll('.team-col.enemy .slot-input');
    window.__t.set(ins[0], 'bad name'); window.__t.set(ins[1], 'Priv#4444'); window.__t.set(ins[2], 'Synth#1111');
    return ins[0].value === 'bad name';
  })()`);
  await check('Lobby: Hae kaikki -> kortit, Tarkkaile / Mahdollinen hakkeri -merkit, puhtaalla ei merkkiä', `(async () => {
    const v = window.__t.vis();
    window.__t.btn('Hae kaikki', v).click();
    if (!(await window.__t.until(() => v.querySelectorAll('.pcard:not(.state)').length >= 5 && !v.querySelector('.pcard.state:not(.err)') ))) return false;
    const ally = v.querySelector('.team-col.ally'), enemy = v.querySelector('.team-col.enemy');
    const cards = [...ally.querySelectorAll('.pcard')];
    const byName = (n) => cards.find((c) => c.querySelector('.nm').textContent === n);
    const hacker = byName('SynthHacker'), watcher = byName('SynthWatcher'), clean = byName('SynthClean');
    if (!hacker || !watcher || !clean) return false;
    return hacker.querySelector('.susp.suspicious').textContent.includes('Mahdollinen hakkeri') && watcher.querySelector('.susp.watch').textContent.includes('Tarkkaile') && !clean.querySelector('.susp') &&
      enemy.textContent.includes('Anna BattleTag muodossa Nimi#1234.') && enemy.textContent.includes('Profiili on yksityinen') && ally.querySelector('.team-sum') !== null;
  })()`);
  await check('Lobby: merkin klikkaus avaa perusteet eikä profiilia; perusteissa lauseke', `(async () => {
    const v = window.__t.vis();
    const card = [...v.querySelectorAll('.team-col.ally .pcard')].find((c) => c.querySelector('.nm').textContent === 'SynthHacker');
    const d = card.querySelector('.susp'); d.querySelector('summary').click();
    await window.__t.wait(200);
    return d.open && d.querySelectorAll('.susp-reasons li').length >= 4 && d.textContent.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.') && document.querySelector('#tabs .tab.active').textContent === 'Live-lobby';
  })()`);
  await shot('ow-lobby-merkit');
  await check('Lobby: kortin klikkaus avaa pelaajan koko profiilin Pelaajahaku-välilehdelle', `(async () => {
    const v = window.__t.vis();
    const card = [...v.querySelectorAll('.team-col.ally .pcard')].find((c) => c.querySelector('.nm').textContent === 'SynthWatcher');
    card.querySelector('.nm').click();
    if (!(await window.__t.until(() => document.querySelector('#tabs .tab.active').textContent === 'Pelaajahaku'))) return false;
    return await window.__t.until(() => window.__t.vis().querySelector('.profile-head h1') && window.__t.vis().querySelector('.profile-head h1').textContent === 'SynthWatcher' && window.__t.vis().querySelector('.profile-head .susp.watch'));
  })()`);
  await check('OW profiili lobbysta: Takaisin lobbyyn -painike ja Kohtaamiset-osio (huomautus, kohtaamiset, kanssa/vastaan)', `(async () => {
    const v = window.__t.vis();
    const back = v.querySelector('.back-bar');
    if (!back || back.hidden || !window.__t.btn('Takaisin lobbyyn', back)) return false;
    if (!(await window.__t.until(() => v.querySelector('.enc-card .enc-table tbody tr'), 6000))) return false;
    const c = v.querySelector('.enc-card');
    return c.textContent.includes('Kohtaamiset') && c.textContent.includes('Overwatchin julkinen profiili ei sisällä otteluhistoriaa – näytetään uran tilastot ja omat kohtaamisesi.') &&
      c.querySelector('.enc-summary').textContent.includes('Kanssasi 1') && c.querySelector('.enc-summary').textContent.includes('Vastaan 0') && c.querySelectorAll('.enc-table tbody tr').length === 1 && !!v.querySelector('.profile-head h1');
  })()`);
  await shot('ow-kohtaamiset');
  await check('OW profiili: Takaisin lobbyyn palaa Live-lobby-välilehdelle; käsin haettu profiili ei näytä painiketta mutta näyttää kohtaamiset', `(async () => {
    window.__t.btn('Takaisin lobbyyn', window.__t.vis().querySelector('.back-bar')).click();
    if (!(await window.__t.until(() => document.querySelector('#tabs .tab.active').textContent === 'Live-lobby'))) return false;
    ${go('ow', 'Pelaajahaku')}; const v = window.__t.vis();
    if (!v.querySelector('.back-bar').hidden) return false; // käsin avattaessa takaisin-painiketta ei näytetä (uusi haku piilottaa sen)
    const f = v.querySelector('.search-form');
    window.__t.set(f.querySelector('input'), 'Synth#3333'); f.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.enc-card .enc-table tbody tr'), 8000))) return false;
    return v.querySelector('.back-bar').hidden && v.querySelector('.enc-card .enc-summary').textContent.includes('Kanssasi 1');
  })()`);
  await check('OW IPC: owLobbyRecord / owEncounters validoivat syötteet', `Promise.all([
    window.api.owLobbyRecord(null), window.api.owLobbyRecord({ mode: 'x', platform: 'pc', ally: ['A#1111'], enemy: [] }), window.api.owLobbyRecord({ mode: 'competitive', platform: 'pc', ally: [], enemy: [] }),
    window.api.owLobbyRecord({ mode: 'competitive', platform: 'pc', ally: ['A#1111'], enemy: [], evil: 1 }), window.api.owEncounters('roska'), window.api.owEncounters(5),
  ]).then((rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT'))`);
  await check('Lobby: nimen muokkaus poistaa vanhentuneen kortin; Tyhjennä tyhjentää kaiken', `(async () => {
    ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
    const ins = v.querySelectorAll('.team-col.ally .slot-input');
    window.__t.set(ins[1], 'Synth#9999');
    if (v.querySelectorAll('.team-col.ally .slot-card')[1].children.length !== 0) return false;
    window.__t.btn('Tyhjennä', v).click();
    return [...v.querySelectorAll('.slot-input')].every((i) => i.value === '') && v.querySelectorAll('.pcard').length === 0;
  })()`);
  await check('Lobby: tyhjällä Hae kaikki antaa ilmoituksen', `(async () => {
    const v = window.__t.vis(); window.__t.btn('Hae kaikki', v).click();
    return await window.__t.until(() => window.__t.toast('Syötä ainakin yksi BattleTag', true));
  })()`);
  // Edellinen-merkki: kaksi peräkkäistä "Hae kaikki" -hakua eri kokoonpanolla. Toisella kerralla edellisen lobbyn pelaajat saavat merkin.
  await check('Lobby: Hae kaikki kahdesti -> toisella kerralla "Edellinen: kanssa / vastaan" -merkit edellisen lobbyn pelaajille', `(async () => {
    ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
    window.__t.btn('Tyhjennä', v).click();
    const a = v.querySelectorAll('.team-col.ally .slot-input'), e = v.querySelectorAll('.team-col.enemy .slot-input');
    window.__t.set(a[0], 'Synth#1111'); window.__t.set(e[0], 'Synth#2222');
    window.__t.btn('Hae kaikki', v).click();
    if (!(await window.__t.until(() => v.querySelectorAll('.pcard:not(.state)').length === 2, 8000))) return false;
    await window.__t.wait(300);
    // 2. kerta: SynthWatcher (Synth#2222) siirtyy omaan tiimiin (edellisessä vastustaja), SynthHacker vastustajiin (edellisessä oma tiimi), SynthClean uusi
    window.__t.btn('Tyhjennä', v).click();
    window.__t.set(a[0], 'Synth#2222'); window.__t.set(e[0], 'Synth#1111'); window.__t.set(e[1], 'Synth#3333');
    window.__t.btn('Hae kaikki', v).click();
    if (!(await window.__t.until(() => v.querySelectorAll('.pcard:not(.state)').length === 3, 8000))) return false;
    const card = (col, n) => [...v.querySelectorAll('.team-col.' + col + ' .pcard')].find((c) => c.querySelector('.nm').textContent === n);
    const watcher = card('ally', 'SynthWatcher'), hacker = card('enemy', 'SynthHacker'), clean = card('enemy', 'SynthClean');
    const chip = (c) => c && c.querySelector('.prev-chip');
    return !!chip(watcher) && chip(watcher).textContent === 'Edellinen: vastaan' && chip(watcher).classList.contains('against') && chip(watcher).title.includes('Edellisessä lobbyssa') && chip(watcher).title.includes('vastustajana') &&
      !!chip(hacker) && chip(hacker).textContent === 'Edellinen: kanssa' && chip(hacker).classList.contains('with') && chip(hacker).title.includes('kanssasi') && !chip(clean) && v.querySelectorAll('.prev-chip').length === 2;
  })()`);
  await shot('ow-lobby-edellinen');
  // Täytä lobby uudelleen kuvia ja asettelutarkistusta varten
  await ev(`(async () => {
    ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
    const a = v.querySelectorAll('.team-col.ally .slot-input'), e = v.querySelectorAll('.team-col.enemy .slot-input');
    window.__t.set(a[0], 'Synth#1111'); window.__t.set(a[1], 'Synth#2222'); window.__t.set(a[2], 'Synth#3333'); window.__t.set(e[0], 'Synth#1111'); window.__t.set(e[1], 'Synth#3333');
    window.__t.btn('Hae kaikki', v).click();
    await window.__t.until(() => v.querySelectorAll('.pcard:not(.state)').length >= 5);
    return true;
  })()`);

  // ======================= 8b. R6 Pelaajan tarkistus =======================
  const R6_SINGLE = (vals, extra) => `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    const form = v.querySelector('.r6-single form');
    window.__t.set(form.querySelector('.r6-field.wide input'), 'R6Testaaja');
    window.__t.fill(form.querySelectorAll('.r6-fields input'), form.querySelector('.r6-fields select'), ${JSON.stringify(vals)});
    form.requestSubmit();
    ${extra}
  })()`;
  await check('R6 Pelaajan tarkistus: lomake (kentät, huomautus, Tarkista)', `(() => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    return v.textContent.includes('R6:lle ei ole julkista rajapintaa, joten syötä luvut käsin.') && v.querySelectorAll('.r6-single .r6-fields input').length === 7 && v.querySelectorAll('.r6-single select option').length === 9 && !!window.__t.btn('Tarkista', v.querySelector('.r6-single')) && v.querySelectorAll('.r6-row').length === 10;
  })()`);
  await check('R6 tarkistus: Mahdollinen hakkeri (perustelut avoinna, huomautus)', R6_SINGLE({ kd: 3.4, hsPercent: 80, winrate: 60, matches: 200, kills: 4000, killsPerRound: 1.5, level: 20, rank: 'Diamond' }, `
    if (!(await window.__t.until(() => v.querySelector('.r6-result .susp.suspicious')))) return false;
    const d = v.querySelector('.r6-result .susp');
    return d.open && d.textContent.includes('Mahdollinen hakkeri') && d.querySelectorAll('.susp-reasons li').length === 4 && d.textContent.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.') && d.textContent.includes('Headshot') && v.querySelector('.r6-result').textContent.includes('R6Testaaja');`));
  await shot('r6-tarkistus-hakkeri');
  await check('R6 tarkistus: Tarkkaile (watch)', R6_SINGLE({ kd: 2.1, hsPercent: 61, matches: 120, kills: 800 }, `
    return await window.__t.until(() => v.querySelector('.r6-result .susp.watch') && v.querySelector('.r6-result .susp.watch').textContent.includes('Tarkkaile'));`));
  await check('R6 tarkistus: ei epätavallisia tilastoja (none)', R6_SINGLE({ kd: 1.0, hsPercent: 40, matches: 120, kills: 800 }, `
    return await window.__t.until(() => v.querySelector('.r6-result').textContent.includes('Ei epätavallisia tilastoja') && !v.querySelector('.r6-result .susp'));`));
  await check('R6 tarkistus: liian pieni otos', R6_SINGLE({ kd: 9, hsPercent: 90, matches: 10, kills: 500 }, `
    return await window.__t.until(() => v.querySelector('.r6-result').textContent.includes('Liian vähän pelejä arvioon') && !v.querySelector('.r6-result .susp'));`));
  await check('R6 tarkistus: puuttuva / virheellinen ottelumäärä antaa virheilmoituksen', R6_SINGLE({ kd: 3 }, `
    if (!(await window.__t.until(() => v.querySelector('.r6-result .warn') && v.querySelector('.r6-result .warn').textContent.includes('Ottelut puuttuu')))) return false;
    window.__t.fill(form.querySelectorAll('.r6-fields input'), form.querySelector('.r6-fields select'), { matches: 'abc' });
    form.requestSubmit();
    return await window.__t.until(() => v.querySelector('.r6-result .warn') && v.querySelector('.r6-result .warn').textContent.includes('Ottelut'));`));
  await check('R6 tarkistus: herkkyys Tiukka / Pois / Normaali koskee myös R6:ta', R6_SINGLE({ kd: 3.2, hsPercent: 61, matches: 200, kills: 3000 }, `
    if (!(await window.__t.until(() => v.querySelector('.r6-result .susp.watch')))) return false;
    await window.api.setSettings({ suspicionSensitivity: 'strict' }); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.r6-result .susp.suspicious')))) return false;
    await window.api.setSettings({ suspicionSensitivity: 'off' }); form.requestSubmit();
    if (!(await window.__t.until(() => v.querySelector('.r6-result').textContent.includes('pois päältä') && !v.querySelector('.r6-result .susp')))) return false;
    await window.api.setSettings({ suspicionSensitivity: 'normal' }); form.requestSubmit();
    return await window.__t.until(() => v.querySelector('.r6-result .susp.watch'));`));
  await check('R6 lobby (5 + 5): Arvioi kaikki näyttää merkit riveittäin', `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    const row = (team, i) => v.querySelectorAll('.r6-team.' + team + ' .r6-row')[i];
    const put = (team, i, name, vals) => { const r = row(team, i); window.__t.set(r.querySelector('.r6-name'), name); window.__t.fill(r.querySelectorAll('.r6-num'), r.querySelector('.r6-rank'), vals); };
    put('ally', 0, 'Hakkeri1', { kd: 3.4, hsPercent: 80, winrate: 60, matches: 200, kills: 4000, killsPerRound: 1.5, level: 20, rank: 'Diamond' });
    put('ally', 1, 'Epailtava', { kd: 2.1, hsPercent: 61, matches: 120, kills: 800 });
    put('ally', 2, 'Tavallinen', { kd: 1.0, hsPercent: 40, matches: 100, kills: 500 });
    put('enemy', 0, 'Uusi', { kd: 5, matches: 10, kills: 50 });
    put('enemy', 1, 'Virhe', { kd: 1 });
    window.__t.btn('Arvioi kaikki', v).click();
    const res = (team, i) => row(team, i).querySelector('.r6-row-res');
    if (!(await window.__t.until(() => res('ally', 0).querySelector('.susp.suspicious') && res('ally', 1).querySelector('.susp.watch') && res('enemy', 1).querySelector('.warn'), 8000))) return false;
    return res('ally', 0).textContent.includes('Mahdollinen hakkeri') && res('ally', 1).textContent.includes('Tarkkaile') && res('ally', 2).textContent.includes('Ei epätavallisia tilastoja') &&
      res('enemy', 0).textContent.includes('Liian vähän pelejä arvioon') && res('ally', 3).children.length === 0 && res('enemy', 1).textContent.includes('Ottelut puuttuu');
  })()`);
  await check('R6 lobby: merkin perustelut aukeavat rivillä ja huomautus näkyy', `(async () => {
    const v = window.__t.vis(); const d = v.querySelector('.r6-team.ally .r6-row .susp.suspicious');
    d.querySelector('summary').click();
    return d.open && d.querySelectorAll('.susp-reasons li').length === 4 && d.textContent.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.');
  })()`);
  await shot('r6-lobby');

  // ======================= 9. Asetukset =======================
  await check('Asetukset: kaikki osiot ja kentät (profiilit, oletusalusta/-pelitila, herkkyys, portti, Stats API, ylläpito, versio)', `(async () => {
    ${nav('settings')}; await window.__t.wait(800);
    const t = window.__t.vis().textContent;
    return ['Omat profiilit', 'Overwatch: oletusalusta', 'Overwatch: oletuspelitila', 'Epätavalliset tilastot: herkkyys', 'Stats API: WebSocket-portti', 'Rocket League Stats API', 'Etsi Rocket League', 'Valitse kansio',
      'Tyhjennä välimuisti', 'Nollaa OW-profiilin historia', 'Tyhjennä RL-otteluhistoria', 'Versio'].every((x) => t.includes(x)) && /Statsikka \\d+\\.\\d+\\.\\d+ \\(Electron/.test(t) && !t.toLowerCase().includes('avaa kansio');
  })()`);
  await check('Asetukset: herkkyys-, alusta- ja pelitilavalinnat tallentuvat (IPC lukee takaisin)', `(async () => {
    const v = window.__t.vis(), g = v.querySelectorAll('.card')[0];
    window.__t.seg(g, 'Tiukka'); await window.__t.wait(300);
    window.__t.seg(g, 'Pikapeli'); await window.__t.wait(300);
    window.__t.seg(g, 'Konsoli'); await window.__t.wait(300);
    const s = (await window.api.getSettings()).data;
    return s.suspicionSensitivity === 'strict' && s.owGamemode === 'quickplay' && s.owPlatform === 'console';
  })()`);
  info('ladataan renderöijä uudelleen (asetusten pysyvyys)');
  const reloaded = await new Promise((r) => {
    const t = setTimeout(() => r(false), 20000);
    if (process.env.ST_DBG) for (const n of ['did-start-loading', 'did-stop-loading', 'did-finish-load', 'did-fail-load', 'did-navigate', 'dom-ready']) win.webContents.on(n, () => log('  dbg ' + n));
    win.webContents.once('did-finish-load', () => { clearTimeout(t); r(true); });
    win.webContents.reload();
  });
  if (!reloaded) fail('Renderöijän uudelleenlataus', 'did-finish-load ei tullut 20 s kuluessa');
  await sleep(700);
  info('reload valmis, injektoidaan apurit');
  await inject();
  info('apurit injektoitu: ' + JSON.stringify(await ev("({ vis: document.visibilityState, t: typeof window.__t, nav: document.querySelectorAll('.nav-item').length })")));
  await check('Asetukset säilyvät uudelleenlatauksen yli (Asetukset-näkymä, OW-haku ja lobby käyttävät oletuksia)', `(async () => {
    ${nav('settings')}; await window.__t.wait(800);
    const g = window.__t.vis().querySelectorAll('.card')[0];
    const on = window.__t.on(g);
    if (!(on.includes('Tiukka') && on.includes('Pikapeli') && on.includes('Konsoli'))) return false;
    ${go('ow', 'Pelaajahaku')}; const f = window.__t.vis().querySelector('.search-form');
    const o1 = window.__t.on(f); if (!(o1.includes('Pikapeli') && o1.includes('Konsoli'))) return false;
    ${go('ow', 'Live-lobby')}; const o2 = window.__t.on(window.__t.vis());
    return o2.includes('Pikapeli') && o2.includes('Konsoli');
  })()`);
  await check('R6 tarkistus: viimeisimmät syötteet (lomake ja lobby) muistetaan uudelleenlatauksen jälkeen', `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    const f = v.querySelector('.r6-single form');
    const vals = [...f.querySelectorAll('.r6-fields input')].map((i) => i.value);
    const row0 = v.querySelectorAll('.r6-team.ally .r6-row')[0];
    return f.querySelector('.r6-field.wide input').value === 'R6Testaaja' && vals[0] === '3.2' && vals[3] === '200' && row0.querySelector('.r6-name').value === 'Hakkeri1' &&
      row0.querySelector('.r6-rank').value === 'Diamond' && row0.querySelectorAll('.r6-num')[0].value === '3.4' && v.querySelectorAll('.r6-team.ally .r6-row')[1].querySelector('.r6-name').value === 'Epailtava';
  })()`);
  await check('Asetukset: omat profiilit ja RL-nimi säilyvät uudelleenlatauksen yli', `(async () => {
    const s = (await window.api.getSettings()).data;
    ${nav('settings')}; await window.__t.wait(600);
    const vals = [...window.__t.vis().querySelectorAll('input')].map((i) => i.value);
    return s.owProfile.battletag === 'TeKrop#2217' && s.rlOwnName === 'Akseli' && s.r6Name === 'SmokeR6' && vals.includes('TeKrop#2217') && vals.includes('Akseli') && vals.includes('SmokeR6');
  })()`);
  await check('Asetukset: valintojen palautus oletuksiin (Normaali, Kilpailullinen, PC)', `(async () => {
    const g = window.__t.vis().querySelectorAll('.card')[0];
    window.__t.seg(g, 'Normaali'); await window.__t.wait(300); window.__t.seg(g, 'Kilpailullinen'); await window.__t.wait(300); window.__t.seg(g, 'PC'); await window.__t.wait(300);
    const s = (await window.api.getSettings()).data;
    return s.suspicionSensitivity === 'normal' && s.owGamemode === 'competitive' && s.owPlatform === 'pc';
  })()`);
  await check('Asetukset: virheellinen portti hylätään (ilmoitus, kenttä palautuu), kelvollinen tallentuu', `(async () => {
    const g = window.__t.vis().querySelectorAll('.card')[0];
    const port = g.querySelector('input[type=number]');
    const was = port.value;
    window.__t.set(port, '80');
    if (!(await window.__t.until(() => window.__t.toast('Portin pitää olla', true)))) return false;
    if (port.value !== was || (await window.api.getSettings()).data.rlWebPort !== Number(was)) return false;
    window.__t.set(port, '49300');
    if (!(await window.__t.until(() => window.__t.toast('Tallennettu')))) return false;
    if ((await window.api.getSettings()).data.rlWebPort !== 49300) return false;
    window.__t.set(port, was);
    await window.__t.wait(500);
    return (await window.api.getSettings()).data.rlWebPort === Number(was);
  })()`);
  await check('Asetukset: Omat profiilit -kentät hylkäävät virheellisen BattleTagin ja tallentavat RL/R6-nimet', `(async () => {
    const v = window.__t.vis();
    const tag = [...v.querySelectorAll('input')].find((i) => i.value === 'TeKrop#2217');
    window.__t.set(tag, 'roska');
    if (!(await window.__t.until(() => window.__t.toast('Virheellinen BattleTag', true)))) return false;
    if ((await window.api.getSettings()).data.owProfile.battletag !== 'TeKrop#2217') return false;
    const rl = [...v.querySelectorAll('input')].find((i) => i.value === 'Akseli'); window.__t.set(rl, 'Akseli2'); await window.__t.wait(400);
    const ok1 = (await window.api.getSettings()).data.rlOwnName === 'Akseli2';
    window.__t.set([...window.__t.vis().querySelectorAll('input')].find((i) => i.value === 'Akseli2'), 'Akseli'); await window.__t.wait(400);
    return ok1 && (await window.api.getSettings()).data.rlOwnName === 'Akseli';
  })()`);
  await check('Stats API: Etsi Rocket League (tässä koneessa ei löydy), kansiota ei valittu', `(async () => {
    const v = window.__t.vis();
    const d = (await window.api.rlDetect()).data;
    if (d.installs.length > 0) { return true; }
    window.__t.btn('Etsi Rocket League', v).click();
    if (!(await window.__t.until(() => window.__t.toast('ei löytynyt', true)))) return false;
    return v.textContent.includes('Ei vielä valittua asennusta') && !window.__t.btn('Ota käyttöön', v);
  })()`);
  await check('Stats API: asetussnippet avautuu ja Kopioi kopioi sen leikepöydälle', `(async () => {
    const v = window.__t.vis();
    const det = [...v.querySelectorAll('details')].find((d) => d.textContent.includes('asetussnippet'));
    if (!det) return false;
    det.querySelector('summary').click();
    const pre = det.querySelector('pre.snippet');
    if (!pre || !pre.textContent.includes('[TAGame.MatchStatsExporter_TA]') || !pre.textContent.includes('WebPort=')) return false;
    window.__t.btn('Kopioi', det).click();
    return await window.__t.until(() => window.__t.toast('Kopioitu leikepöydälle'));
  })()`);
  const clip = (hooks && hooks.copied && hooks.copied()) || '';
  if (clip.includes('[TAGame.MatchStatsExporter_TA]') && clip.includes('WebPort=')) pass('Stats API: kopioitu teksti on snippet (savutestissä oikeaan leikepöytään ei kirjoiteta)'); else fail('Stats API: kopioitu teksti on snippet');
  await check('Asetukset: Tyhjennä välimuisti toimii', `(async () => {
    window.__t.btn('Tyhjennä välimuisti', window.__t.vis()).click();
    return await window.__t.until(() => window.__t.toast('Välimuisti tyhjennetty'));
  })()`);
  await shot('settings');

  // ======================= 10. Rocket League =======================
  const rlOn = probe && probe().rlStatus === 'connected';
  info(`mock-RL yhteys: ${rlOn ? 'kyllä' : 'ei'}`);
  if (rlOn) {
    await ev(`window.api.setSettings({ rlOwnName: 'Akseli' })`);
    await waitCheck('RL Live-peli: tulostaulu, oma rivi, tapahtumasyöte (mock)', `(async () => {
      ${go('rl', 'Live-peli')}; const v = window.__t.vis();
      return !!v.querySelector('.scorebar') && v.querySelectorAll('tr.own').length >= 1 && v.querySelectorAll('.team-table').length === 2 && !v.querySelector('.susp');
    })()`, 20000);
    await shot('rl-live');
    await waitCheck('RL Historia: ottelu tallentuu, laajennus näyttää tulostaulut (mock)', `(async () => {
      ${go('rl', 'Historia')}; await window.__t.wait(500);
      const v = window.__t.vis();
      const m = v.querySelector('.match-head'); if (!m) return false;
      if (m.getAttribute('aria-expanded') !== 'true') m.click();
      await window.__t.wait(200);
      return !!v.querySelector('.match-body') && v.querySelectorAll('.tile').length === 9 && !v.querySelector('.susp');
    })()`, 80000); // mock-ottelu kestää 60 s + 4 s tauko
    await shot('rl-history');
    await check('RL IPC: rl:players / rl:player (indeksi, profiili, ottelulista) ja virheelliset pyynnöt hylätään', `(async () => {
      const l = (await window.api.rlPlayers({ sort: 'games' })).data;
      if (l.total !== 5 || l.players.length !== 5 || l.players.some((p) => p.name === 'Akseli') || !l.players[0].key) return false;
      const p = (await window.api.rlPlayer(l.players[0].key)).data;
      if (!(p.games >= 1) || p.matchList.length < 1 || !p.matchList[0].match || !p.averages || typeof p.averages.goals !== 'number') return false;
      const bad = await Promise.all([window.api.rlPlayer(5), window.api.rlPlayer(''), window.api.rlPlayers({ sort: 'x' }), window.api.rlPlayers({ evil: 1 }), window.api.rlPlayers({ pageSize: 1000 })]);
      const nf = await window.api.rlPlayer('Steam|ei|ole');
      return bad.every((r) => !r.ok && r.error.code === 'BAD_INPUT') && !nf.ok && nf.error.code === 'NOT_FOUND';
    })()`);
    await check('RL > Pelaajat: mock-pelaajat listassa (5), haku ja lajittelu', `(async () => {
      ${go('rl', 'Pelaajat')}; const v = window.__t.vis();
      const rows = () => [...v.querySelectorAll('.rl-players-table tbody tr[data-player]')];
      if (!(await window.__t.until(() => rows().length === 5, 8000))) return false;
      if (!v.textContent.includes('Kanssa') || !v.textContent.includes('Vastaan') || rows().some((r) => r.textContent.includes('Akseli'))) return false;
      const inp = v.querySelector('.players-bar input');
      window.__t.set(inp, 'blue');
      if (!(await window.__t.until(() => rows().length === 1 && rows()[0].textContent.includes('BlueBolt'), 4000))) return false;
      window.__t.set(inp, '');
      const sel = v.querySelector('.players-bar select'); sel.value = 'name'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      return await window.__t.until(() => rows().length === 5 && rows()[0].querySelector('.pname').textContent === 'BlueBolt', 4000);
    })()`);
    await shot('rl-pelaajat');
    await check('RL Pelaajat: rivin klikkaus avaa pelaajapaneelin (tiilet, ottelulista), ottelu laajenee tulostauluksi', `(async () => {
      const v = window.__t.vis();
      const row = v.querySelector('.rl-players-table tbody tr[data-player]'); const name = row.querySelector('.pname').textContent;
      row.click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.tiles .tile').length >= 9 && dr().querySelectorAll('.match-head').length >= 1, 8000))) return false;
      if (dr().querySelector('.drawer-title').textContent !== name) return false;
      const t = dr().textContent;
      if (!t.includes('Kanssasi') || !t.includes('Vastaan') || !t.includes('Maalit / peli') || !t.includes('Ottelut (') || !t.includes('Rocket League ei tarjoa muiden pelaajien otteluhistoriaa')) return false;
      dr().querySelector('.match-head').click();
      return await window.__t.until(() => dr().querySelectorAll('.match-body .team-table').length === 2, 6000);
    })()`);
    await shot('rl-pelaaja-paneeli');
    await check('RL pelaajapaneeli: Sulje sulkee', `(async () => {
      window.__t.btn('Sulje', document.querySelector('.drawer-back:not([hidden]) .drawer')).click();
      return !document.querySelector('.drawer-back:not([hidden])');
    })()`);
    await waitCheck('RL Live-peli: seuraavassa ottelussa Edellinen-merkit (5), yhteenveto ja pelaajan klikkaus avaa paneelin', `(async () => {
      ${go('rl', 'Live-peli')}; const v = window.__t.vis();
      if (v.querySelectorAll('tr.clickable').length < 5 || v.querySelectorAll('tr.own.clickable').length !== 0) return false;
      const chips = [...v.querySelectorAll('.prev-chip')];
      if (chips.length !== 5 || !chips.every((c) => /^Edellinen: (kanssa|vastaan)$/.test(c.textContent) && c.title.startsWith('Edellinen ottelu (')) || !v.querySelector('.live-summary').textContent.includes('Edellisessä ottelussa mukana 5')) return false;
      const withN = chips.filter((c) => c.classList.contains('with')).length;
      if (withN !== 2 || chips.filter((c) => c.classList.contains('against')).length !== 3) return false; // mock: 2 tiimikaveria, 3 vastustajaa
      // Aiemmin-sarake: kanssa/vastaan + pelaajan keskiarvot omasta historiasta (edellinen mock-ottelu on jo tallennettu)
      if (![...v.querySelectorAll('th')].some((t) => t.textContent === 'Aiemmin')) return false;
      const cells = [...v.querySelectorAll('td.rl-hist')];
      if (cells.length !== 6 || cells.filter((c) => c.textContent === 'Sinä').length !== 1) return false;
      const others = cells.filter((c) => c.textContent !== 'Sinä');
      return others.length === 5 && others.every((c) => /Kanssa|Vastaan/.test(c.textContent) && c.querySelector('.sub') && /\\d+ peliä · Pisteet .*\\/peli · Maalit .* · Torjunnat .* · Voitto-% /.test(c.querySelector('.sub').textContent));
    })()`, 100000);
    await shot('rl-live-edellinen');
    await check('RL Live-peli: pelaajan klikkaus avaa pelaajapaneelin, Sulje sulkee', `(async () => {
      const v = window.__t.vis();
      const row = v.querySelector('tr.clickable'); const name = row.querySelector('.pname').textContent;
      row.click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelector('.drawer-title').textContent === name && dr().querySelectorAll('.tiles .tile').length >= 9, 8000))) return false;
      window.__t.btn('Sulje', dr()).click();
      return !document.querySelector('.drawer-back:not([hidden])');
    })()`);
    await check('Oma profiili / RL-osio käyttää samaa historiaa (7 ruutua, kaaviot)', `(async () => {
      ${nav('me')}; await window.__t.until(() => window.__t.vis().querySelectorAll('.rl-section .tiles .tile').length === 7, 6000); const s = window.__t.vis().querySelector('.rl-section');
      return !!s && s.querySelectorAll('.tiles .tile').length === 7 && s.querySelectorAll('.chart-svg, .chart-empty').length >= 2; // kaavio tai tyhjä tila (liukuva keskiarvo vaatii 3 peliä)
    })()`, "(() => { const s = window.__t.vis().querySelector('.rl-section'); return s ? { tiles: s.querySelectorAll('.tiles .tile').length, charts: s.querySelectorAll('.chart-svg').length, text: s.textContent.slice(0, 160) } : 'ei osiota'; })()");
  } else {
    info('mock-RL ei käynnissä: RL live / historia -tarkistukset ohitettu');
  }
  await check('RL Live-peli ilman yhteyttä/peliä: tilakortti renderöityy, pelaajia ei merkitä', `(() => { ${go('rl', 'Live-peli')}; const t = window.__t.vis().textContent; return t.length > 20 && !window.__t.vis().querySelector('.susp'); })()`);
  await check('RL Historia: tyhjennä-nappi kysyy vahvistuksen; Peruuta ei poista mitään', `(async () => {
    ${go('rl', 'Historia')}; await window.__t.wait(600);
    const v = window.__t.vis(); const b = window.__t.btn('Tyhjennä historia', v);
    if (!b) return false;
    if (b.disabled) return true;
    const before = (await window.api.rlHistory()).data.matches.length;
    b.click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta')))) return false;
    window.__t.modalBtn('Peruuta').click(); await window.__t.wait(300);
    return (await window.api.rlHistory()).data.matches.length === before;
  })()`);

  // ======================= 10b. R6 ottelutallenteet (kopioidut oikeat tallenteet, live-simulaatio) =======================
  let r6On = false;
  let r6Smoke = null;
  try { r6Smoke = await prepareR6Smoke(); } catch (e) { info(`R6-tallenteiden valmistelu epäonnistui: ${e.message}`); }
  if (!r6Smoke || !hooks || !hooks.startR6) {
    info('R6: tallenteita ei löytynyt tältä koneelta, replay-tarkistukset ohitettu');
  } else {
    r6On = true;
    const fs = require('fs');
    const path = require('path');
    process.env.R6_REPLAY_DIR = r6Smoke.dir;
    hooks.startR6();
    await hooks.r6Ready();
    await check('R6 IPC: r6:status ja r6:own (3 kopioitua ottelua, oma pelaaja tunnistettu)', `(async () => {
      const s = (await window.api.r6Status()).data, o = (await window.api.r6Own({ matchType: 'all' })).data;
      return s.dirFound && s.matchCount === 3 && !s.scanning && s.dir.includes('statsikka-r6-smoke') && s.watcher === 'watching' && o.hasOwn && o.matches === 3 &&
        o.wins + o.losses + o.draws + o.unknown === 3 && o.series.kd.length === 3 && o.operators.length > 0 && o.maps.length > 0;
    })()`);
    await check('R6 IPC: virheelliset pyynnöt hylätään (BAD_INPUT)', `Promise.all([
      window.api.r6Match('../x'), window.api.r6Match(5), window.api.r6Player(5), window.api.r6Player('a b/c'), window.api.r6Players({ sort: 'x' }),
      window.api.r6Players({ search: 'x'.repeat(41) }), window.api.r6Players({ evil: 1 }), window.api.r6Matches({ page: 0 }), window.api.r6Matches({ pageSize: 1000 }),
      window.api.r6Own({ matchType: 'zzz' }), window.api.r6Own(5),
    ]).then((rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT'))`);
    await check('R6 IPC: r6:matches / r6:match / r6:players / r6:live (pelaajat, kierrokset, 10 pelaajaa)', `(async () => {
      const m = (await window.api.r6Matches({ page: 1, pageSize: 25, matchType: 'all' })).data;
      if (m.total !== 3 || m.items.length !== 3 || m.items[0].ts < m.items[2].ts) return false;
      const full = (await window.api.r6Match(m.items[0].name)).data;
      if (full.players.length !== 10 || !full.rounds.length || full.players.filter((p) => p.isOwn).length !== 1) return false;
      const pl = (await window.api.r6Players({})).data;
      if (pl.total < 20 || pl.players.some((p) => p.isOwn)) return false;
      const one = (await window.api.r6Player(pl.players[0].profileID)).data;
      const lv = (await window.api.r6Live()).data;
      return one.matchList.length >= 1 && lv.hasData && !lv.active && lv.match.players.length === 10;
    })()`);

    await check('R6 > Oma profiili: ruudut, kaaviot, kartat, operaattorit ja ottelutyyppisuodatin', `(async () => {
      ${go('r6', 'Oma profiili')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-own .tiles .tile').length === 10, 8000))) return false;
      const t = v.querySelector('.r6-own').textContent;
      if (!t.includes('Kartat') || !t.includes('Operaattorit') || !t.includes('Paras ottelu') || v.querySelectorAll('.r6-own .chart-svg').length < 1 || !v.querySelector('.account-bar')) return false;
      const btns = [...v.querySelectorAll('.r6-filter .seg button')];
      if (btns.length !== 4) return false;
      btns.find((b) => b.textContent.startsWith('Ranked')).click();
      return await window.__t.until(() => [...v.querySelectorAll('.r6-filter .seg button.on')].every((b) => b.textContent.startsWith('Ranked')) && v.querySelectorAll('.r6-own .tiles .tile').length === 10, 6000);
    })()`);
    await ev(`(async () => { ${go('r6', 'Oma profiili')}; const b = [...window.__t.vis().querySelectorAll('.r6-filter .seg button')].find((x) => x.textContent.startsWith('Kaikki')); if (b) b.click(); return true; })()`);
    await check('R6 > Oma profiili: edistyneet ruudut (KOST, Entry, Tradet, Clutchit, Multikillit, Plantit / Purut) oikeilla arvoilla, KOST-kaavio, clutch-taulukko, tooltipit, ottelutyyppisuodatin', `(async () => {
      ${go('r6', 'Oma profiili')}; const v = window.__t.vis();
      const fi = (n) => n.toFixed(1).replace('.', ',') + ' %';
      const own = async (t) => (await window.api.r6Own({ matchType: t })).data;
      const o = await own('all');
      if (!o.adv || !(o.adv.rounds > 0) || o.advMatches < 1 || o.adv.kost < 0 || o.adv.kost > 100 || !(o.series.kost.length >= 1)) return false; // kopioiduilla oikeilla otteluilla on kierrosdataa
      const tiles = () => [...v.querySelectorAll('.r6-own .adv-tiles .tile')];
      const tv = (i) => tiles()[i].querySelector('.tv').textContent;
      if (!(await window.__t.until(() => tiles().length === 6 && tv(0) !== '–', 8000))) return false;
      if (tiles().map((t) => t.querySelector('.tl').textContent).join('|') !== 'KOST %|Entry|Tradet|Clutchit|Multikillit|Plantit / Purut') return false;
      const c = o.adv.clutch, m = o.adv.multi;
      if (tv(0) !== fi(o.adv.kost) || tv(1) !== o.adv.entryKills + '–' + o.adv.entryDeaths || tv(2) !== o.adv.tradeKills + ' / ' + o.adv.tradedDeaths ||
        tv(3) !== c.winsTotal + ' / ' + c.attemptsTotal || tv(4) !== m.k2 + ' / ' + m.k3 + ' / ' + m.k4 + ' / ' + m.ace) return false;
      if (!tiles().every((t) => t.title.length > 30) || !tiles()[0].title.startsWith('KOST =') || !tiles()[2].title.includes('10 sekunnin') || !tiles()[3].title.startsWith('1vX-clutch')) return false;
      if (!v.querySelector('.r6-own .r6-kost-chart .chart') || !v.querySelector('.r6-own .r6-clutch')) return false;
      if (c.attemptsTotal > 0 && v.querySelectorAll('.r6-own .r6-clutch tbody tr').length !== 2) return false;
      if (c.attemptsTotal > 0 && [...v.querySelectorAll('.r6-own .r6-clutch th')].map((t) => t.textContent).join('|') !== '|1v1|1v2|1v3|1v4|1v5') return false;
      const btns = [...v.querySelectorAll('.r6-filter .seg button')];
      btns.find((b) => b.textContent.startsWith('Ranked')).click();
      const r = await own('ranked');
      return await window.__t.until(() => [...v.querySelectorAll('.r6-filter .seg button.on')].every((b) => b.textContent.startsWith('Ranked')) && tiles().length === 6 && tv(0) === (r.adv ? fi(r.adv.kost) : '–') && v.querySelectorAll('.r6-own .tiles .tile').length === 10, 6000);
    })()`, `(async () => { const v = window.__t.vis(); const o = (await window.api.r6Own({ matchType: 'all' })).data; return { adv: o.adv && { rounds: o.adv.rounds, kost: o.adv.kost }, advMatches: o.advMatches, tiles: [...v.querySelectorAll('.r6-own .adv-tiles .tile')].map((t) => t.textContent) }; })()`);
    await ev(`(async () => { ${go('r6', 'Oma profiili')}; const v = window.__t.vis(); const b = [...v.querySelectorAll('.r6-filter .seg button')].find((x) => x.textContent.startsWith('Kaikki')); if (b) b.click(); await window.__t.until(() => [...v.querySelectorAll('.r6-filter .seg button.on')].every((x) => x.textContent.startsWith('Kaikki')) && v.querySelectorAll('.r6-own .adv-tiles .tile').length === 6, 6000); const t = v.querySelector('.r6-adv-title'); if (t) t.scrollIntoView(); return true; })()`);
    await shot('r6-oma-kost');
    await check('R6 > Live-peli: viimeisin ottelu, 10 pelaajaa, oma rivi, Aiemmin-sarake', `(async () => {
      ${go('r6', 'Live-peli')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-team-table').length === 2 && v.querySelectorAll('tr[data-player]').length === 10, 8000))) return false;
      const t = v.textContent;
      return t.includes('Viimeisin ottelu') && !t.includes('Käynnissä') && t.includes('Aiemmin') && t.includes('Oma tiimi') && t.includes('Vastustaja') && !!v.querySelector('.r6-scorebar') &&
        v.querySelectorAll('tr.own').length === 1 && v.querySelectorAll('td.r6-hist').length === 10 && v.querySelectorAll('tr.own .badge').length === 1 && t.includes('Ottelu päättyi');
    })()`);
    await check('R6 IPC: edistyneet tilastot (r6:match pelaajat ja invariantit, r6:matches own.kost, r6:players KOST-lajittelu, r6:player adv ja ottelulista)', `(async () => {
      const m = (await window.api.r6Matches({ page: 1, pageSize: 25, matchType: 'all' })).data;
      const fulls = [];
      for (const it of m.items) fulls.push((await window.api.r6Match(it.name)).data);
      const f = fulls.find((x) => x.hasAdv);
      if (!f || !m.items.some((i) => i.own && i.own.kost != null)) return false;
      const ps = f.players.filter((p) => p.adv);
      if (ps.length < 6) return false;
      let ek = 0, ed = 0;
      for (const p of ps) {
        const a = p.adv;
        if (!(a.rounds > 0 && a.kost >= 0 && a.kost <= 100 && a.kostRounds <= a.rounds && a.clutch.attemptsTotal <= a.rounds && a.tradeKills <= a.kills && a.tradedDeaths <= a.deaths && a.survived + a.deaths === a.rounds && a.clutch.winsTotal <= a.clutch.attemptsTotal)) return false;
        ek += a.entryKills; ed += a.entryDeaths;
      }
      if (ek !== ed) return false; // jokaisella kierroksella yksi entry-tappo ja yksi entry-kuolema
      const pl = (await window.api.r6Players({ sort: 'kost', pageSize: 100 })).data;
      const ks = pl.players.map((p) => (p.kost == null ? -1 : p.kost));
      if (!pl.players.length || !ks.every((k, i) => i === 0 || ks[i - 1] >= k) || ks[0] < 0) return false;
      const one = pl.players.find((p) => p.kost != null);
      const pd = (await window.api.r6Player(one.profileID)).data;
      return pd.adv && pd.adv.rounds === one.advRounds && pd.adv.kost === one.kost && pd.matchList.some((x) => x.kost != null && x.adv) && (await window.api.r6Players({ sort: 'kost2' })).ok === false;
    })()`);
    await check('R6 > Live-peli: tallenteen pistetaulussa KOST-, Entry-, Trade- ja Clutch-sarakkeet (vain kun kierrosdataa on)', `(async () => {
      ${go('r6', 'Live-peli')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-team-table').length === 2 && v.querySelectorAll('tr[data-player]').length === 10, 8000))) return false;
      const lv = (await window.api.r6Live()).data;
      const ths = [...v.querySelectorAll('.r6-team-table')[0].querySelectorAll('th')].map((t) => t.textContent);
      const has = ['KOST', 'Entry', 'Trade', 'Clutch'].every((c) => ths.includes(c));
      if (!lv.match.hasAdv) return !has;
      return has && v.querySelectorAll('tr[data-player] td.adv-cell').length === 40 && [...v.querySelectorAll('tr.own td.adv-cell')].some((c) => c.textContent !== '–');
    })()`);
    await check('R6 IPC: r6:player (tiilet, operaattorit, kartat, ottelulista pelaajan näkökulmasta) ja r6:live (prev-kentät)', `(async () => {
      const pl = (await window.api.r6Players({})).data;
      const p = (await window.api.r6Player(pl.players[0].profileID)).data;
      if (!p.key || !(p.operators.length > 0) || !(p.maps.length > 0) || p.matchList.length < 1 || p.matchTotal < 1 || typeof p.assists !== 'number') return false;
      const m = p.matchList[0];
      if (!['win', 'loss', 'draw', 'unknown'].includes(m.playerResult) || m.teamScore.length !== 2 || !Array.isArray(m.operators) || !m.name) return false;
      const lv = (await window.api.r6Live()).data;
      return lv.match.players.every((x) => 'prev' in x && x.key) && 'prevMatch' in lv.match && (await window.api.r6Match(m.name)).data.prevMatch === null;
    })()`);
    await check('R6 > Live-peli: pelaajan klikkaus avaa pelaajapaneelin (tiilet, operaattorit, kartat, ottelulista) ja ottelu laajenee pistetauluksi', `(async () => {
      ${go('r6', 'Live-peli')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('tr[data-player].clickable').length === 9 && v.querySelector('.live-summary'), 8000))) return false;
      if (v.querySelectorAll('tr.own.clickable').length !== 0 || !v.querySelector('.live-summary').textContent.includes('Tuttuja pelaajia') || !v.querySelector('.live-summary').textContent.includes('Merkittyjä')) return false;
      const rows = [...v.querySelectorAll('tr[data-player].clickable')];
      const name = rows[0].querySelector('.pname').textContent;
      rows[0].click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.tiles .tile').length >= 7 && dr().querySelectorAll('.match-head').length >= 1, 8000))) return false;
      if (dr().querySelector('.drawer-title').textContent !== name) return false;
      const t = dr().textContent;
      if (!t.includes('Parhaat operaattorit') || !t.includes('Kartat') || !t.includes('Kanssasi') || !t.includes('Vastaan') || !t.includes('Ottelut (') || !t.includes('Ubisoft ei tarjoa muiden pelaajien otteluhistoriaa')) return false;
      const head = dr().querySelector('.match-head');
      if (!head.textContent.includes('–') || !/Voitto|Tappio|Tasapeli|Ei tulosta/.test(head.textContent) || !/\\d+-\\d+-\\d+/.test(head.textContent)) return false;
      head.click();
      return await window.__t.until(() => dr().querySelectorAll('.r6-match-body .r6-team-table').length === 2 && dr().querySelectorAll('.r6-match-body tr[data-player]').length >= 2 && dr().querySelector('.match-head').getAttribute('aria-expanded') === 'true', 8000); // paneeli piirtää ottelulistan uudelleen: haetaan otsikko tuoreena
    })()`, "(() => { const v = window.__t.vis(); const dr = document.querySelector('.drawer-back:not([hidden]) .drawer'); const h = dr && dr.querySelector('.match-head'); return { rows: v.querySelectorAll('tr[data-player].clickable').length, own: v.querySelectorAll('tr.own.clickable').length, summary: !!v.querySelector('.live-summary'), drawer: !!dr, title: dr && dr.querySelector('.drawer-title').textContent, tiles: dr && dr.querySelectorAll('.tiles .tile').length, heads: dr && dr.querySelectorAll('.match-head').length, head: h && h.textContent, exp: h && h.getAttribute('aria-expanded'), tables: dr && dr.querySelectorAll('.r6-match-body .r6-team-table').length, clickable: dr && dr.querySelectorAll('.r6-match-body tr.clickable').length, tail: dr && dr.textContent.slice(-120) }; })()");
    await shot('r6-pelaaja-paneeli');
    await check('R6 pelaajapaneeli: toinen pelaaja pinoon, Takaisin palaa edelliseen, Sulje ja Esc sulkevat', `(async () => {
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      const title0 = dr().querySelector('.drawer-title').textContent;
      const other = [...dr().querySelectorAll('.r6-match-body tr.clickable')].find((r) => r.querySelector('.pname').textContent !== title0);
      if (!other) return false;
      const name2 = other.querySelector('.pname').textContent;
      other.click();
      if (!(await window.__t.until(() => dr() && dr().querySelector('.drawer-title').textContent === name2 && dr().querySelectorAll('.tiles .tile').length >= 7, 8000))) return false;
      const back = window.__t.btn('Takaisin', dr());
      if (!back || back.hidden) return false;
      back.click();
      if (!(await window.__t.until(() => dr().querySelector('.drawer-title').textContent === title0 && dr().querySelectorAll('.tiles .tile').length >= 7, 8000))) return false;
      if (!window.__t.btn('Takaisin', dr()).hidden) return false;
      window.__t.btn('Sulje', dr()).click();
      if (document.querySelector('.drawer-back:not([hidden])')) return false;
      window.__t.vis().querySelector('tr[data-player].clickable').click();
      if (!(await window.__t.until(() => dr(), 4000))) return false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !document.querySelector('.drawer-back:not([hidden])') && document.querySelector('#tabs .tab.active').textContent === 'Live-peli';
    })()`, "(() => { const v = window.__t.vis(); const dr = document.querySelector('.drawer-back:not([hidden]) .drawer'); const h = dr && dr.querySelector('.match-head'); return { rows: v.querySelectorAll('tr[data-player].clickable').length, own: v.querySelectorAll('tr.own.clickable').length, summary: !!v.querySelector('.live-summary'), drawer: !!dr, title: dr && dr.querySelector('.drawer-title').textContent, tiles: dr && dr.querySelectorAll('.tiles .tile').length, heads: dr && dr.querySelectorAll('.match-head').length, head: h && h.textContent, exp: h && h.getAttribute('aria-expanded'), tables: dr && dr.querySelectorAll('.r6-match-body .r6-team-table').length, clickable: dr && dr.querySelectorAll('.r6-match-body tr.clickable').length, tail: dr && dr.textContent.slice(-120) }; })()");
    // Peli käynnissä, mutta uutta ottelua ei vielä ole: R6 kirjoittaa tallenteen vasta 1. kierroksen jälkeen.
    hooks.injectGame({ r6: true });
    await check('R6 > Live-peli: peli käynnissä -> "ottelun tiedot näkyvät 1. kierroksen jälkeen" -ilmoitus, sivupalkin piste keltainen', `(async () => {
      PlayerPanel.close();
      ${go('r6', 'Live-peli')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelector('.r6-waiting'), 6000))) return false;
      const d = document.getElementById('r6-dot');
      return v.querySelector('.r6-waiting').textContent.includes('Peli käynnissä – ottelun tiedot näkyvät 1. kierroksen jälkeen.') && v.querySelector('.r6-waiting').textContent.includes('noin 3–4 min') &&
        !!v.querySelector('.r6-scorebar') && d.classList.contains('waiting') && !d.classList.contains('connected') && d.title.includes('ei ottelua');
    })()`);
    await shot('r6-odottaa-kierrosta');
    await check('R6 > Ottelut: ottelukortit (tulosluokka ja vasen palkki, kartta, "Tulos a–b", K/D- ja HS-teksti, operaattorit) sekä yhteenvetorivi (V–H, voitto-%, K/D)', `(async () => {
      ${go('r6', 'Ottelut')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-match-card').length === 3 && v.querySelector('.r6-match-summary'), 8000))) return false;
      const items = (await window.api.r6Matches({})).data.items;
      const cards = [...v.querySelectorAll('.r6-match-card')];
      const want = { win: 'm-win', loss: 'm-loss', live: 'm-live' };
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i], m = items[i];
        const cls = want[m.result] || 'm-na';
        if (!c.classList.contains(cls) || c.querySelector('.match-head').dataset.name !== m.name) return false;
        if (getComputedStyle(c).borderLeftWidth !== '5px') return false;
        const res = c.querySelector('.rmc-result').textContent;
        if (!new RegExp('^(Voitto|Tappio|Tasapeli|Käynnissä|Ei tulosta) ' + m.score[0] + '–' + m.score[1] + '$').test(res)) return false;
        if (!c.querySelector('.rmc-mapname').textContent.trim()) return false;
        const st = c.querySelector('.rmc-stats').textContent;
        if (m.own ? !(st.includes('K/D') && st.includes('HS') && st.includes(m.own.kills + ' / ' + m.own.deaths)) : !st.includes('Et ollut mukana')) return false;
        if (m.own && m.own.operators.length && !c.querySelector('.rmc-ops').textContent.trim()) return false;
      }
      const sum = v.querySelector('.r6-match-summary').textContent;
      const mine = items.filter((m) => m.own && m.result !== 'live');
      return ['Ottelut', 'V–H', 'Voitto-%', 'K/D'].every((t) => sum.includes(t)) && sum.includes(mine.filter((m) => m.result === 'win').length + '–' + mine.filter((m) => m.result === 'loss').length);
    })()`);
    await shot('r6-ottelut-kortit');
    await check('R6 > Ottelut: lista (3), rivin avaus näyttää pistetaulun ja kierrokset', `(async () => {
      ${go('r6', 'Ottelut')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.match-head').length === 3, 8000))) return false;
      const hd = v.querySelector('.match-head'); hd.click();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-match-body .r6-team-table').length === 2 && v.querySelectorAll('.r6-rounds tbody tr').length > 0 && v.querySelectorAll('.r6-match-body tr[data-player]').length === 10, 8000))) return false;
      const rt = v.querySelector('.r6-rounds').textContent;
      return v.querySelector('.match-head').getAttribute('aria-expanded') === 'true' && (rt.includes('Hyökkäys') || rt.includes('Puolustus'));
    })()`);
    await check('R6 > Ottelut: pistetaulussa KOST-, Entry-, Trade- ja Clutch-sarakkeet (tooltipit, arvot)', `(async () => {
      ${go('r6', 'Ottelut')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.match-head').length === 3, 8000))) return false;
      const items = (await window.api.r6Matches({})).data.items;
      let idx = -1;
      for (let i = 0; i < items.length; i++) if ((await window.api.r6Match(items[i].name)).data.hasAdv) { idx = i; break; }
      if (idx < 0) return false;
      const heads = () => [...v.querySelectorAll('.match-head')];
      if (heads()[idx].getAttribute('aria-expanded') !== 'true') heads()[idx].click();
      if (!(await window.__t.until(() => v.querySelectorAll('.match')[idx].querySelectorAll('.r6-team-table').length === 2, 8000))) return false;
      const body = v.querySelectorAll('.match')[idx];
      const ths = [...body.querySelector('.r6-team-table').querySelectorAll('th')];
      const names = ths.map((t) => t.textContent);
      if (!['KOST', 'Entry', 'Trade', 'Clutch'].every((c) => names.includes(c))) return false;
      if (!ths.find((t) => t.textContent === 'KOST').title.startsWith('KOST =') || !ths.find((t) => t.textContent === 'Trade').title.includes('Tradattu kuolema')) return false;
      const cells = [...body.querySelectorAll('tr[data-player] td.adv-cell')];
      if (cells.length !== 40 || !cells.some((c) => c.textContent !== '–')) return false;
      const kosts = [...body.querySelectorAll('tr[data-player]')].map((r) => r.querySelectorAll('td.adv-cell')[0].textContent);
      return kosts.every((t) => t === '–' || (parseFloat(t.replace(',', '.')) >= 0 && parseFloat(t.replace(',', '.')) <= 100 && t.endsWith(' %'))) && body.querySelector('.match-head').textContent.includes('KOST');
    })()`);
    await ev(`(async () => { const v = window.__t.vis(); const m = [...v.querySelectorAll('.match')].find((x) => x.querySelector('td.adv-cell')); if (m) m.querySelector('.r6-team-table').scrollIntoView(); return true; })()`);
    await shot('r6-ottelu-kost');
    await ev(`(async () => { const v = window.__t.vis(); const hs = [...v.querySelectorAll('.match-head')]; hs.forEach((h, i) => { if (i > 0 && h.getAttribute('aria-expanded') === 'true') h.click(); }); if (hs[0].getAttribute('aria-expanded') !== 'true') hs[0].click(); await window.__t.wait(300); return true; })()`);
    await check('R6 > Ottelut: suodatin (Ranked/Unranked/Quick) ja sulkeminen', `(async () => {
      const v = window.__t.vis();
      const all = v.querySelectorAll('.match-head').length;
      window.__t.seg(v, 'Quick'); await window.__t.wait(400);
      const quick = v.querySelectorAll('.match-head').length;
      window.__t.seg(v, 'Kaikki'); await window.__t.until(() => v.querySelectorAll('.match-head').length === all, 4000);
      const hd = v.querySelector('.match-head'); if (hd.getAttribute('aria-expanded') === 'true') hd.click();
      return all === 3 && quick <= all && v.querySelector('.match-head').getAttribute('aria-expanded') === 'false' && !v.querySelector('.r6-match-body');
    })()`);
    await check('R6 > Pelaajat: lista, haku, rivin klikkaus avaa pelaajapaneelin ja Sulje', `(async () => {
      ${go('r6', 'Pelaajat')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-players-table tbody tr[data-player]').length >= 20, 8000))) return false;
      const rows = () => [...v.querySelectorAll('.r6-players-table tbody tr[data-player]')];
      const name = rows()[0].querySelector('.pname').textContent;
      const inp = v.querySelector('.players-bar input');
      window.__t.set(inp, 'zzzzqqqq9');
      if (!(await window.__t.until(() => v.textContent.includes('Ei hakua vastaavia pelaajia'), 5000))) return false;
      const before = rows().length || 20;
      window.__t.set(inp, name.slice(0, 4));
      if (!(await window.__t.until(() => rows().length >= 1 && rows().length < before && rows().every((r) => r.textContent.toLowerCase().includes(name.slice(0, 4).toLowerCase())), 5000))) return false;
      rows()[0].click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.tiles .tile').length >= 7 && dr().querySelectorAll('.match-head').length >= 1, 6000))) return false;
      if (v.querySelector('.r6-player-list').hidden) return false; // lista pysyy näkyvissä paneelin takana
      window.__t.btn('Sulje', dr()).click();
      window.__t.set(inp, '');
      return !document.querySelector('.drawer-back:not([hidden])') && await window.__t.until(() => rows().length >= 20, 6000);
    })()`);
    await check('R6 > Pelaajat: KOST-sarake, lajittelu otsikosta (dataton viimeisenä) ja valitsimesta', `(async () => {
      ${go('r6', 'Pelaajat')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-players-table tbody tr[data-player]').length >= 20, 8000))) return false;
      const th = () => [...v.querySelectorAll('.r6-players-table th')].find((t) => t.textContent.startsWith('KOST'));
      if (!th() || !th().title.startsWith('KOST =') || v.querySelectorAll('.r6-players-table tbody tr[data-player] td.kost-cell').length < 20) return false;
      const sel = v.querySelector('.players-bar select');
      if (![...sel.options].some((o) => o.value === 'kost')) return false;
      th().click();
      if (!(await window.__t.until(() => sel.value === 'kost' && th().textContent === 'KOST % ▼' && th().classList.contains('on'), 6000))) return false;
      const vals = () => [...v.querySelectorAll('.r6-players-table tbody td.kost-cell')].map((c) => (c.textContent === '–' ? -1 : parseFloat(c.textContent.replace(',', '.'))));
      if (!(await window.__t.until(() => vals().length >= 20 && vals()[0] >= 0, 6000))) return false;
      const a = vals();
      if (!a.every((x, i) => i === 0 || a[i - 1] >= x)) return false;
      sel.value = 'matches'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (!(await window.__t.until(() => th() && th().textContent === 'KOST %', 6000))) return false;
      sel.value = 'kost'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const ok = await window.__t.until(() => { const b = vals(); return th().textContent === 'KOST % ▼' && b.length >= 20 && b.every((x, i) => i === 0 || b[i - 1] >= x); }, 6000);
      sel.value = 'last'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await window.__t.until(() => th().textContent === 'KOST %', 6000);
      return ok;
    })()`);
    await check('R6 pelaajapaneeli: KOST-, Entry-, Tradet-, Clutchit-, Multikillit- ja Plantit / Purut -ruudut sekä ottelun KOST', `(async () => {
      ${go('r6', 'Pelaajat')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.r6-players-table tbody tr[data-player]').length >= 20, 8000))) return false;
      const row = [...v.querySelectorAll('.r6-players-table tbody tr[data-player]')].find((r) => r.querySelector('.kost-cell').textContent !== '–');
      if (!row) return false;
      const kost = row.querySelector('.kost-cell').textContent;
      row.click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.tiles .tile').length >= 13 && dr().querySelector('.match-head'), 8000))) return false;
      const labs = [...dr().querySelectorAll('.tiles .tile .tl')].map((t) => t.textContent);
      if (!['KOST %', 'Entry', 'Tradet', 'Clutchit', 'Multikillit', 'Plantit / Purut'].every((l) => labs.includes(l))) return false;
      const tile = [...dr().querySelectorAll('.tiles .tile')].find((t) => t.querySelector('.tl').textContent === 'KOST %');
      return tile.querySelector('.tv').textContent === kost && tile.title.startsWith('KOST =') && [...dr().querySelectorAll('.match-head')].some((h) => h.textContent.includes('KOST'));
    })()`, `(() => { const dr = document.querySelector('.drawer-back:not([hidden]) .drawer'); return dr && { labs: [...dr.querySelectorAll('.tiles .tile .tl')].map((t) => t.textContent), head: dr.querySelector('.match-head') && dr.querySelector('.match-head').textContent }; })()`);
    await shot('r6-pelaaja-kost');
    await ev('(() => { PlayerPanel.close(); return true; })()');
    await check('Asetukset: R6-kortti näyttää kansion, tilan ja napit; Skannaa uudelleen toimii', `(async () => {
      ${nav('settings')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelector('.r6-dir') && v.querySelector('.r6-dir').textContent.includes('statsikka-r6-smoke') && v.querySelector('.r6-status-line').textContent.includes('3 ottelua'), 6000))) return false;
      const c = v.querySelector('.r6-settings');
      if (!window.__t.btn('Valitse kansio', c) || !window.__t.btn('Skannaa uudelleen', c) || !c.textContent.includes('Ota pelissä käyttöön Match Replay (Options → General → Match Replay)')) return false;
      window.__t.btn('Skannaa uudelleen', c).click();
      if (!(await window.__t.until(() => window.__t.toast('Skannataan'), 4000))) return false;
      const end = Date.now() + 40000;
      while (Date.now() < end) {
        const s = (await window.api.r6Status()).data;
        if (!s.scanning && s.matchCount === 3 && s.watcher === 'watching') return v.querySelector('.r6-status-line').textContent.includes('3 ottelua') || await window.__t.until(() => v.querySelector('.r6-status-line').textContent.includes('3 ottelua'), 4000);
        await window.__t.wait(300);
      }
      return false;
    })()`);

    // ---- Overwolf GEP -simulaatio R6:lle: rosteri näkyy heti ottelun alussa, ennen kuin yhtään kierrostallennetta on olemassa.
    if (hasGep) {
      hooks.gepReset('r6');
      const { players: gp, knownCount } = await gepR6Players();
      await ev(nav('settings'));
      await ev(`window.api.setSettings({ autoLive: true })`);
      await sleep(400);
      SIM.play(gepFeed, SIM.r6Start(gp));
      await waitCheck('R6 GEP: match_start vaihtaa näkymäksi R6 Live-pelin (toast, ei ikkunan esiintuontia)', `document.body.dataset.game === 'r6' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli' && window.__t.toast('Ottelu alkoi (Rainbow Six Siege)')`, 8000);
      await ev(`window.api.setSettings({ autoLive: false })`);
      await waitCheck('R6 GEP: Live-peli näyttää 10 pelaajaa heti (ei kierrostallennetta), oma rivi, operaattorit, HP, Kierros 1, ei odotusilmoitusta', `(() => {
        const v = window.__t.vis();
        const rows = v.querySelectorAll('tr[data-player]');
        return rows.length === 10 && v.querySelectorAll('tr.own').length === 1 && v.querySelector('.status-pill').textContent.includes('Live: Overwolf GEP') && !v.querySelector('.r6-waiting') &&
          v.textContent.includes('Kierros 1') && [...v.querySelectorAll('th')].some((t) => t.textContent === 'HP') && v.querySelector('tr.own .badge').textContent === 'sinä' &&
          [...v.querySelectorAll('td.ops-cell')].every((c) => c.textContent !== '–') && v.textContent.includes('Kafe Dostoyevsky') && v.textContent.includes('Ranked');
      })()`, 8000);
      await check('R6 GEP: kun GEP seuraa ottelua, "Overwolf-kehittäjäavain" -vihje on piilossa', `(() => { const x = window.__t.vis().querySelector('.gep-hint'); return !!x && x.hidden; })()`);
      await check('R6 GEP: live-pistetaulussa ei KOST-sarakkeita (kierrosdataa ei tule GEP:ltä)', `(() => { const v = window.__t.vis(); return v.querySelectorAll('.r6-team-table').length === 2 && ![...v.querySelectorAll('th')].some((t) => ['KOST', 'Entry', 'Trade', 'Clutch'].includes(t.textContent)) && v.querySelectorAll('td.adv-cell').length === 0; })()`);
      await check('R6 GEP: historia player_id:llä (tutut pelaajat saavat Aiemmin-tiedot, uudet "Ensimmäinen kerta"), tapot/kuolemat/pisteet GEP:ltä', `(() => {
        const v = window.__t.vis();
        const cells = [...v.querySelectorAll('tr[data-player]:not(.own) td.r6-hist')].map((c) => c.textContent);
        const fresh = cells.filter((t) => t.includes('Ensimmäinen kerta')).length;
        const gs = [...v.querySelectorAll('tr.own td')].map((t) => t.textContent);
        return cells.length === 9 && fresh === ${10 - knownCount} && cells.length - fresh === ${knownCount - 1} && gs.length >= 8;
      })()`, `(() => { const v = window.__t.vis(); return [...v.querySelectorAll('tr[data-player]:not(.own) td.r6-hist')].map((c) => c.textContent.slice(0, 40)); })()`);
      await check('R6 GEP: tutun pelaajan klikkaus avaa pelaajapaneelin, tuntematon näyttää "Ei aiempia tallenteita"', `(async () => {
        const v = window.__t.vis();
        const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
        const rows = [...v.querySelectorAll('tr[data-player]:not(.own)')];
        const knownRow = rows.find((r) => !r.querySelector('td.r6-hist').textContent.includes('Ensimmäinen kerta'));
        const freshRow = rows.find((r) => r.querySelector('td.r6-hist').textContent.includes('Ensimmäinen kerta') && r.classList.contains('clickable'));
        if (!knownRow || !freshRow) return false;
        knownRow.click();
        if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.tiles .tile').length >= 7, 6000))) return false;
        PlayerPanel.close();
        freshRow.click();
        if (!(await window.__t.until(() => dr() && dr().querySelector('.r6-unseen'), 6000))) return false;
        const ok = dr().textContent.includes('Ei aiempia tallenteita');
        PlayerPanel.close();
        return ok;
      })()`);
      await shot('r6-live-gep');
      SIM.play(gepFeed, SIM.r6Progress(gp));
      await waitCheck('R6 GEP: live-päivitys (Kierros 2, pisteet 1 – 0, omat tapot, tappofeed)', `(() => {
        const v = window.__t.vis();
        return v.textContent.includes('Kierros 2') && v.querySelector('.r6-scorebar .side.blue .sc').textContent === '1' && v.querySelector('.r6-feed') !== null && v.querySelector('tr.own').textContent.includes('640');
      })()`, 6000);
      await check('R6 GEP IPC: gep:state (rosteri 10, rikastettu avain, status ei virheellinen) ja gep:diag', `(async () => {
        const s = (await window.api.gepState()).data, d = (await window.api.gepDiag()).data;
        return s.r6.live && s.r6.roster.length === 10 && s.r6.roster.every((p) => typeof p.key === 'string') && ['inactive', 'waiting-credentials', 'ready', 'game-running'].includes(s.status.state) && d.length > 10;
      })()`);
      SIM.play(gepFeed, SIM.r6End());
      await waitCheck('R6 GEP: ottelun loppu palauttaa tallennenäkymän (ei GEP-merkintää)', `(() => { const v = window.__t.vis(); return !v.textContent.includes('Live: Overwolf GEP') && !v.querySelector('.r6-feed'); })()`, 6000);
      hooks.gepReset('r6');
    }

    // Live-simulaatio: uusi ottelukansio ja kierrostiedosto kerrallaan kopioidaan väliaikaiseen kansioon (ei pelikansioon).
    if (r6Smoke.spare.length >= 2) {
      const { players1, players2 } = r6Smoke;
      if (players1 !== 10 || players2 !== 10) info(`R6 live: odotetut pelaajamäärät kierros 1 = ${players1}, kierros 2 = ${players2} (ei 10)`);
      const liveDir = path.join(r6Smoke.dir, liveFolderName());
      fs.mkdirSync(liveDir);
      await ev(nav('settings')); // pois Live-näkymästä: uuden ottelukansion pitää siirtää näkymä itse
      await ev(`window.api.setSettings({ autoLive: true })`);
      await sleep(600);
      const copyRound = (src, n) => { const dst = path.join(liveDir, `${path.basename(liveDir)}-R0${n}.rec`); fs.copyFileSync(src, dst); const t = new Date(); fs.utimesSync(dst, t, t); }; // Windows säilyttää kopion muokkausajan: asetetaan "peli kirjoitti juuri"
      copyRound(r6Smoke.spare[0], 1);
      await waitCheck('R6: uusi ottelukansio (1. kierros) vaihtaa näkymäksi R6 Live-pelin automaattisesti (toast, ei ikkunan esiintuontia)', `document.body.dataset.game === 'r6' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli' && window.__t.toast('Ottelu alkoi (Rainbow Six Siege)')`, 40000);
      await ev(`window.api.setSettings({ autoLive: false })`);
      await waitCheck('R6 Live-peli päivittyy itsestään: ensimmäinen kierros uudessa ottelussa (Käynnissä, Kierros 1)', `(() => {
        const v = window.__t.vis();
        return v.textContent.includes('Käynnissä') && v.textContent.includes('Kierros 1') && v.querySelectorAll('tr[data-player]').length === ${players1} && !v.textContent.includes('Viimeisin ottelu');
      })()`, 40000);
      if (r6Smoke.overlap) {
        await waitCheck('R6 live: Edellinen-merkit pelaajille, jotka olivat edellisessä ottelussa (kanssa / vastaan, tooltip, yhteenveto); odotusilmoitus poistuu', `(() => {
          const v = window.__t.vis();
          const chips = [...v.querySelectorAll('tr[data-player] .prev-chip')];
          return chips.length >= ${Math.min(5, players1 - 1)} && chips.every((c) => /^Edellinen: (kanssa|vastaan)$/.test(c.textContent) && c.title.startsWith('Edellinen ottelu (') && c.title.includes('·')) &&
            v.querySelector('.live-summary').textContent.includes('Edellisessä ottelussa mukana') && v.querySelectorAll('td.r6-hist').length === ${players1} && !v.querySelector('.r6-waiting') &&
            document.getElementById('r6-dot').classList.contains('connected');
        })()`, 20000);
        await shot('r6-live-edellinen');
      } else {
        info('R6: live-ottelu ei jaa pelaajia edellisen kanssa (uusimmassa ottelussa < 2 kierrosta), Edellinen-merkin tarkistus ohitettu');
      }
      copyRound(r6Smoke.spare[1], 2);
      await waitCheck('R6 Live-peli päivittyy: toinen kierros (Kierros 2)', `(() => {
        const v = window.__t.vis();
        return v.textContent.includes('Käynnissä') && v.textContent.includes('Kierros 2') && v.querySelectorAll('tr[data-player]').length === ${players2};
      })()`, 40000);
      await shot('r6-live-kaynnissa');
      await check('R6 live: IPC (aktiivinen ottelu, 4 ottelua), sivupalkin piste palaa, Ottelut-listassa "Käynnissä"', `(async () => {
        const lv = (await window.api.r6Live()).data, st = (await window.api.r6Status()).data;
        if (!lv.active || lv.match.result !== 'live' || lv.match.roundsParsed !== 2 || st.matchCount !== 4 || !st.active) return false;
        if (!document.getElementById('r6-dot').classList.contains('connected')) return false;
        const m = (await window.api.r6Matches({})).data;
        const own = (await window.api.r6Own({})).data;
        return m.items.some((x) => x.result === 'live') && own.matches === 3 && own.active;
      })()`);
      // GEP + tallenne yhdessä: kun käynnissä olevan GEP-ottelun kierrokset on tallennettu, HS-% täydentyy tallenteesta; GEP pysyy live-lähteenä.
      if (hasGep) {
        hooks.gepReset('r6');
        const { players: gp2 } = await gepR6Players();
        hooks.gepClock(Date.now() - 10 * 60 * 1000); // GEP-ottelu alkoi ennen tallennetta
        SIM.play(gepFeed, SIM.r6Start(gp2));
        hooks.gepClock(null);
        await ev(go('r6', 'Live-peli'));
        await waitCheck('R6 GEP + tallenne: HS-% täydentyy tallenteesta ja tapot ovat GEP:ltä (oma rivi: 0 tappoa GEP:n mukaan)', `(() => {
          const v = window.__t.vis();
          const ths = [...v.querySelectorAll('.r6-team-table')[0].querySelectorAll('th')].map((t) => t.textContent);
          const hi = ths.indexOf('HS %');
          const own = v.querySelector('tr.own');
          const hs = [...v.querySelectorAll('tr[data-player]')].map((r) => r.children[hi].textContent);
          return hi > 0 && v.querySelectorAll('tr[data-player]').length === 10 && v.querySelector('.status-pill').textContent.includes('Live: Overwolf GEP') &&
            hs.filter((t) => t !== '–').length >= 8 && own.children[2].textContent === '0';
        })()`, 10000);
        if (process.env.ST_DEBUG_GEP) {
          const st = hooks.gepState();
          info(`GEP-diag: startedAt=${st.r6.startedAt} now=${Date.now()} live=${st.r6.live} replay=${st.r6.roster.filter((p) => p.replay).length}/${st.r6.roster.length} hist=${st.r6.roster.filter((p) => p.hist).length} ${JSON.stringify(await ev(`window.api.r6Live().then((r) => ({ active: r.data.active, name: r.data.match && r.data.match.name }))`))}`);
        }
        SIM.play(gepFeed, SIM.r6End());
        hooks.gepReset('r6');
      }
    } else {
      info('R6: 4. ottelua ei ole, live-simulaatio ohitettu');
    }
    hooks.injectGame({ r6: false });
  }

  // ======================= 10c. Pelien tila ja automaattinen siirtyminen live-näkymään =======================
  // Pelin tila injektoidaan koukulla (oikeita pelejä ei käynnistetä). Siirtyminen on vain sovelluksen sisäinen näkymänvaihto:
  // ikkunaa ei tuoda eteen eikä järjestelmäilmoituksia näytetä (pääprosessi ei kutsu focus/show/flash/Notification).
  if (hooks && hooks.injectGame && hooks.startMatch) {
    hooks.injectGame({ ow: true });
    await check('Overwatch käynnissä: lobbyn yläreunassa vihje "liitä pelaajien nimet" ja sivupalkin OW-piste keltainen', `(async () => {
      ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelector('.ow-hint') && !v.querySelector('.ow-hint').hidden, 6000))) return false;
      const d = document.getElementById('ow-dot');
      return v.querySelector('.ow-hint').textContent === 'Overwatch käynnissä – liitä pelaajien nimet' && d.classList.contains('waiting') && !d.classList.contains('connected');
    })()`);
    hooks.injectGame({ ow: false });
    await check('Overwatch suljettu: vihje piiloutuu ja OW-piste sammuu', `(async () => {
      const v = window.__t.vis();
      return await window.__t.until(() => v.querySelector('.ow-hint').hidden && !document.getElementById('ow-dot').classList.contains('waiting'), 6000);
    })()`);

    await ev(`window.api.setSettings({ autoLive: true })`);
    await ev(`(() => { ${nav('settings')}; return true; })()`);
    await sleep(300);
    hooks.injectGame({ rl: true });
    hooks.startMatch('rl', 'SMOKE-RL-1');
    await waitCheck('RL: ottelun alku vaihtaa näkymäksi RL Live-pelin (toast, sivupalkin piste vihreä)', `document.body.dataset.game === 'rl' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli' &&
      window.__t.toast('Ottelu alkoi (Rocket League)') && document.getElementById('rl-dot').classList.contains('connected')`, 8000);
    await shot('auto-siirtyma-rl');
    hooks.startMatch('rl', 'SMOKE-RL-1');
    await sleep(500);
    await check('RL: sama ottelu (MatchCreated + MatchInitialized) ei siirrä uudelleen', `(async () => { ${nav('settings')}; await window.__t.wait(800); return document.body.dataset.game === 'settings'; })()`);

    await ev(`window.api.setSettings({ autoLive: false })`); // ensin pois: mock-RL:n UpdateState ei saa käynnistää uutta siirtymää ottelun päättymisen jälkeen
    hooks.endMatch('rl');
    hooks.startMatch('rl', 'SMOKE-RL-2');
    await sleep(1500);
    await check('Asetus "Siirry live-näkymään automaattisesti" pois: ottelun alku ei vaihda näkymää (piste silti vihreä)', `document.body.dataset.game === 'settings' && document.getElementById('rl-dot').classList.contains('connected')`);
    hooks.endMatch('rl');

    await ev(`window.api.setSettings({ autoLive: true })`);
    await ev(`(() => { ${go('ow', 'Pelaajahaku')}; const i = window.__t.vis().querySelector('.search-form input'); i.focus(); return document.activeElement === i; })()`);
    await sleep(300);
    hooks.startMatch('rl', 'SMOKE-RL-3');
    await sleep(1500);
    await check('Lomaketta täytettäessä ottelun alku ei vaihda näkymää eikä vie kohdistusta', `document.body.dataset.game === 'ow' && document.activeElement.tagName === 'INPUT' && document.activeElement.closest('.search-form') !== null`);
    await ev(`window.api.setSettings({ autoLive: false })`);
    hooks.endMatch('rl');
    await ev(`(() => { document.activeElement.blur(); return true; })()`);
    hooks.injectGame({ rl: false });
  }

  // ======================= 10c2. Pelin käynnistyminen: ikkuna avataan ilman kohdistusta (showInactive) ja siirrytään live-näkymään =======================
  // Ikkunan näyttö on kirjaava tekaistu toteutus (hooks.bg): showInactive-kutsut lasketaan, kohdistuskutsuja (focused) ei saa tulla, ikkuna ei oikeasti näy.
  if (hooks && hooks.bg && hooks.injectGame) {
    const bg = hooks.bg;
    const launches = () => bg.state().launches;
    const reset = () => { bg.reset(); };
    for (const g of ['r6', 'ow', 'rl']) hooks.injectGame({ [g]: false });
    await ev(`window.api.setSettings({ openOnGameLaunch: true })`);
    await ev(nav('settings'));
    bg.setVisible(false); reset();
    hooks.injectGame({ r6: true });
    await waitCheck('Pelin käynnistys, ikkuna piilossa: R6 -> näytetään showInactive:lla ja siirrytään R6 Live-peliin (toast)', `document.body.dataset.game === 'r6' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli' && window.__t.toast('Peli käynnistyi (Rainbow Six Siege)')`, 6000);
    {
      const s = bg.state();
      if (s.inactive === 1 && s.focused.length === 0 && launches().length === 1 && launches()[0].game === 'r6' && launches()[0].action === 'show') pass('Pelin käynnistys: täsmälleen yksi showInactive, ei kohdistusta (focus/restore/show), päätös "show"'); else fail('Pelin käynnistys: showInactive-kutsut', JSON.stringify(s));
    }
    hooks.injectGame({ r6: true }); hooks.injectGame({ r6: true }); hooks.injectGame({ r6: true }); // tunnistin kysyy 5 s välein: sama tila ei ole uusi käynnistys
    await sleep(600);
    {
      const s = bg.state();
      if (s.inactive === 1 && launches().length === 1) pass('Pelin käynnistys: vain kerran per prosessin alku (toistuvat kyselyt eivät avaa uudelleen)'); else fail('Pelin käynnistys: kerran per alku', JSON.stringify(s));
    }
    // Ikkuna on nyt näkyvissä (tekaistu tila): uusi peli -> vain siirtymä, ei uutta showInactive:a
    await ev(nav('settings')); reset();
    hooks.injectGame({ r6: false }); hooks.injectGame({ ow: true });
    await waitCheck('Pelin käynnistys, ikkuna näkyvissä: Overwatch -> vain siirtymä OW Live-lobbyyn (ei showInactive:a)', `document.body.dataset.game === 'ow' && document.querySelector('#tabs .tab.active').textContent === 'Live-lobby' && window.__t.toast('Peli käynnistyi (Overwatch 2)')`, 6000);
    {
      const s = bg.state();
      if (s.inactive === 0 && s.focused.length === 0 && launches().length === 1 && launches()[0].action === 'navigate') pass('Pelin käynnistys, näkyvä ikkuna: päätös "navigate", ei showInactive:a eikä kohdistusta'); else fail('Pelin käynnistys: näkyvä ikkuna', JSON.stringify(s));
    }
    // Sama peli sulkeutuu ja käynnistyy uudelleen -> uusi tapahtuma
    await ev(nav('settings')); reset();
    hooks.injectGame({ ow: false }); hooks.injectGame({ ow: true });
    await waitCheck('Pelin sulkeutuminen ja uusi käynnistys: uusi siirtymä (uusi käynnistystapahtuma)', `document.body.dataset.game === 'ow' && document.querySelector('#tabs .tab.active').textContent === 'Live-lobby'`, 6000);
    if (launches().length === 1) pass('Pelin käynnistys: sulkeutuminen + uusi käynnistys antaa uuden tapahtuman'); else fail('Uusi käynnistystapahtuma', JSON.stringify(launches()));
    // Suojat näkyvässä ikkunassa: kirjoitus kentässä, vahvistusikkuna auki
    await ev(`(() => { ${go('ow', 'Pelaajahaku')}; const i = window.__t.vis().querySelector('.search-form input'); i.focus(); return document.activeElement === i; })()`);
    reset();
    hooks.injectGame({ ow: false }); hooks.injectGame({ rl: true });
    await sleep(1200);
    await check('Pelin käynnistys, ikkuna näkyvissä: kirjoitettaessa ei siirrytä eikä viedä kohdistusta', `document.body.dataset.game === 'ow' && document.activeElement.closest('.search-form') !== null`);
    if (launches().length === 1 && launches()[0].action === 'navigate' && bg.state().inactive === 0) pass('Kirjoitussuoja: pääprosessi päätti "navigate", renderer esti siirtymän'); else fail('Kirjoitussuoja', JSON.stringify(bg.state()));
    await ev(`(() => { document.activeElement.blur(); return true; })()`);
    await ev(`(() => { window.__t.go('ow', 'Pelaajahaku'); U.confirmDialog('Testi', 'Vahvistusikkuna auki', 'Poista'); return true; })()`);
    hooks.injectGame({ rl: false }); hooks.injectGame({ rl: true });
    await sleep(1200);
    await check('Pelin käynnistys, ikkuna näkyvissä: vahvistusikkunan ollessa auki ei siirrytä', `document.body.dataset.game === 'ow' && !!document.querySelector('#modal-root .modal')`);
    await ev(`(() => { window.__t.modalBtn('Peruuta').click(); return true; })()`);
    // Piilossa oleva ikkuna: vanha kohdistus ei estä siirtymää (käyttäjä ei kirjoita)
    await ev(`(() => { ${go('ow', 'Pelaajahaku')}; const i = window.__t.vis().querySelector('.search-form input'); i.focus(); return document.activeElement === i; })()`);
    bg.setVisible(false); reset();
    hooks.injectGame({ rl: false }); hooks.injectGame({ rl: true });
    await waitCheck('Pelin käynnistys, ikkuna piilossa (vanha kohdistus kentässä): RL -> showInactive ja siirtymä RL Live-peliin', `document.body.dataset.game === 'rl' && document.querySelector('#tabs .tab.active').textContent === 'Live-peli'`, 6000);
    if (bg.state().inactive === 1 && bg.state().focused.length === 0) pass('Piilotettu ikkuna: showInactive kerran, ei kohdistusta'); else fail('Piilotettu ikkuna', JSON.stringify(bg.state()));
    // Asetus pois: ei avausta eikä siirtymää
    await ev(`window.api.setSettings({ openOnGameLaunch: false })`);
    await ev(nav('settings')); bg.setVisible(false); reset();
    hooks.injectGame({ rl: false }); hooks.injectGame({ r6: false }); hooks.injectGame({ rl: true }); hooks.injectGame({ r6: true });
    await sleep(1500);
    await check('Asetus "Avaa pelin käynnistyessä" pois: ei siirtymää', `document.body.dataset.game === 'settings'`);
    if (launches().length === 2 && launches().every((l) => l.action === 'none') && bg.state().inactive === 0 && bg.state().focused.length === 0) pass('Asetus pois: pelin käynnistys ei näytä ikkunaa (päätös "none", ei showInactive:a)'); else fail('Asetus pois', JSON.stringify(bg.state()));
    for (const g of ['r6', 'ow', 'rl']) hooks.injectGame({ [g]: false });
    bg.setVisible(null); reset();

    // Overwolf-vihjeet: ilman GEP:iä R6 Live-peli ja OW Live-lobby kertovat, milloin pelaajat näkyvät, ja ohjaavat Asetuksiin
    const HINT = 'Pelaajat näkyvät heti ottelun alussa, kun Overwolf-kehittäjäavain on asetettu (Asetukset → Overwolf). Ilman sitä R6-pelaajat näkyvät 1. kierroksen jälkeen.';
    await check('R6 > Live-peli: ilman Overwolf GEP:iä näkyy vihje (teksti, Avaa asetukset -nappi)', `(async () => {
      ${go('r6', 'Live-peli')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => { const x = v.querySelector('.gep-hint'); return x && !x.hidden; }, 6000))) return false;
      const x = v.querySelector('.gep-hint');
      return x.textContent.startsWith(${JSON.stringify(HINT)}) && !!window.__t.btn('Avaa asetukset', x);
    })()`);
    await shot('r6-live-gep-vihje');
    await check('OW > Live-lobby: ilman Overwolf GEP:iä näkyy vihje; nappi avaa Asetusten Overwolf-kortin', `(async () => {
      ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => { const x = v.querySelector('.gep-hint'); return x && !x.hidden; }, 6000))) return false;
      const x = v.querySelector('.gep-hint');
      if (!x.textContent.includes('Overwolf-kehittäjäavain') || !x.textContent.includes('liitä pelaajien nimet käsin')) return false;
      window.__t.btn('Avaa asetukset', x).click();
      return document.body.dataset.game === 'settings' && !!window.__t.vis().querySelector('.ow-settings');
    })()`);
  }

  // ======================= 10d. Overwolf GEP: asetuskortti, tunnukset (vain savutestin tietokansiossa) ja OW2-lobby =======================
  await check('Overwolf: tila (ow-electron: odottaa tunnusta / tavallinen Electron: ei käytössä), ei virhettä ilman tunnusta', `(async () => {
    const s = (await window.api.overwolfStatus()).data;
    return ['inactive', 'waiting-credentials'].includes(s.status.state) && s.smoke === true && s.startup === 'smoke' && !s.status.lastError && s.envActive === false && s.channelArg === false;
  })()`);
  info(`Overwolf: ajoympäristö ${hooks && hooks.gepStatus ? JSON.stringify({ state: hooks.gepStatus().state, attached: hooks.gepStatus().attached }) : '?'}`);
  await check('Asetukset: Overwolf-kortti (tila, ohjeet, linkit https, salasanakentät, dev-kanava, napit)', `(async () => {
    ${nav('settings')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.ow-settings .ow-state'), 6000))) return false;
    const c = window.__t.vis().querySelector('.ow-settings');
    const links = [...c.querySelectorAll('a')].map((a) => a.href);
    return c.textContent.includes('Overwolf (live-pelitiedot)') && ['Ei käytössä', 'Odotetaan tunnuksia'].includes(c.querySelector('.ow-state').textContent) &&
      c.textContent.includes('Developer Key') && c.textContent.includes('Approved') && links.includes('https://dev.overwolf.com/') && links.every((l) => l.startsWith('https://')) &&
      c.querySelectorAll('input[type=password]').length === 2 && !!window.__t.btn('Ota käyttöön ja käynnistä uudelleen', c) && !!window.__t.btn('Poista tunnukset', c) &&
      c.querySelector('input.ow-dev-channel').checked === true && c.textContent.includes('Yksityisyys');
  })()`);
  await check('Overwolf: virheelliset tunnukset hylätään (IPC) eikä mitään tallennu', `Promise.all([
    window.api.overwolfEnable({ mode: 'dev', devKey: 'x' }), window.api.overwolfEnable({ mode: 'dev' }), window.api.overwolfEnable({ mode: 'console', email: 'ei', apiKey: 'abcdefgh12345678' }),
    window.api.overwolfEnable({ mode: 'dev', devKey: 'abcdefgh12345678', evil: 1 }), window.api.overwolfEnable(5), window.api.overwolfEnable({ mode: 'dev', devKey: 'abcdefgh12345678', devChannel: 'x' }),
  ]).then(async (rs) => rs.every((r) => !r.ok) && (await window.api.overwolfStatus()).data.stored === false)`);
  const storageOk = await ev(`window.api.overwolfStatus().then((r) => r.data.storageAvailable)`);
  if (!storageOk) {
    info('Overwolf: safeStorage ei ole käytettävissä, tunnusten tallennustarkistukset ohitettu');
    await check('Overwolf: ilman salausta tallennus kielletään ja selitetään', `(async () => { const r = await window.api.overwolfEnable({ mode: 'dev', devKey: 'smoke-fake-devkey-000000' }); return !r.ok && r.error.message.includes('Salausta ei ole saatavilla'); })()`);
  } else {
    await check('Overwolf: kehittäjäavaimen tallennus (salattu, kentät tyhjenevät, ei uudelleenkäynnistystä savutestissä, dev-kanava-valinta tallentuu)', `(async () => {
      const c = window.__t.vis().querySelector('.ow-settings');
      const key = 'smoke-fake-devkey-000000';
      const inp = c.querySelector('input[type=password]'); window.__t.set(inp, key);
      const cb = c.querySelector('input.ow-dev-channel'); cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      window.__t.btn('Ota käyttöön ja käynnistä uudelleen', c).click();
      if (!(await window.__t.until(() => window.__t.toast('Tunnukset tallennettu'), 5000))) return false;
      if (inp.value !== '') return false;
      if (!(await window.__t.until(() => c.querySelector('.ow-cred-line').textContent.includes('Tallennettu salattuna: kehittäjäavain'), 5000))) return false;
      const st = (await window.api.overwolfStatus()).data, s = (await window.api.getSettings()).data;
      const wasSent = JSON.stringify(st) + JSON.stringify(s);
      return st.stored && st.storedMode === 'dev' && s.gepDevChannel === false && !wasSent.includes(key) && !c.textContent.includes(key) && !JSON.stringify(await window.api.gepDiag()).includes(key);
    })()`);
    await ev(nav('settings'));
    await ev(`(() => { const c = window.__t.vis().querySelector('.ow-settings'); c.scrollIntoView(); return true; })()`);
    await shot('asetukset-overwolf');
    await check('Overwolf: tallennettu tiedosto on salattu (ei selkotekstiä) tietokansiossa', `(async () => { const i = (await window.api.appInfo()).data; return i.dataDir.toLowerCase().includes('statsikka-smoke'); })()`);
    const credFile = require('path').join(require('os').tmpdir(), 'statsikka-smoke', 'ow-credentials.bin');
    const raw = require('fs').existsSync(credFile) ? require('fs').readFileSync(credFile) : null;
    if (raw && raw.length > 10 && !raw.toString('latin1').includes('smoke-fake-devkey') && !raw.toString('utf8').includes('smoke-fake-devkey')) pass('Overwolf: ow-credentials.bin on olemassa ja salattu'); else fail('Overwolf: ow-credentials.bin on olemassa ja salattu', raw ? 'sisältää selkotekstiä tai on tyhjä' : 'puuttuu');
    await check('Overwolf: Console-tunnukset (sähköposti + API-avain) tallentuvat; Poista tunnukset (vahvistus) tyhjentää ja palauttaa dev-kanavan oletuksen käsin', `(async () => {
      const c = window.__t.vis().querySelector('.ow-settings');
      window.__t.seg(c, 'Console-tunnukset');
      const mail = c.querySelector('input[type=email]'), pw = c.querySelectorAll('input[type=password]')[1];
      if (mail.closest('.ow-fields').hidden) return false;
      window.__t.set(mail, 'smoke@example.com'); window.__t.set(pw, 'smoke-fake-apikey-000000');
      window.__t.btn('Ota käyttöön ja käynnistä uudelleen', c).click();
      if (!(await window.__t.until(() => c.querySelector('.ow-cred-line').textContent.includes('Console-tunnukset'), 5000))) return false;
      if (mail.value !== '' || pw.value !== '') return false;
      window.__t.btn('Poista tunnukset', c).click();
      if (!(await window.__t.until(() => window.__t.modalBtn('Poista'), 4000))) return false;
      window.__t.modalBtn('Poista').click();
      if (!(await window.__t.until(() => window.__t.toast('Tunnukset poistettu'), 5000))) return false;
      await window.__t.until(() => c.querySelector('.ow-cred-line').textContent.includes('Ei tallennettu'), 4000);
      const st = (await window.api.overwolfStatus()).data;
      await window.api.setSettings({ gepDevChannel: true });
      return !st.stored && c.querySelector('.ow-cred-line').textContent.includes('Ei tallennettu');
    })()`);
    if (require('fs').existsSync(credFile)) fail('Overwolf: ow-credentials.bin poistuu', 'tiedosto on yhä olemassa'); else pass('Overwolf: ow-credentials.bin poistuu');
  }

  // ======================= 10e. Arenyze (R6-tilastot): keinotekoinen fetch (fixture-JSON), ei oikeaa verkkoa =======================
  try { await require('./smoke-arenyze').run({ win, ev, check, waitCheck, pass, fail, info, nav, go, shot, hooks, SIM, gepFeed, hasGep, r6On }); } catch (e) { fail('Arenyze-savutesti kaatui', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }

  // OW2 GEP: rosteri täyttää lobbyn, "Hae kaikki" ajetaan automaattisesti kerran, live-luvut korteille, ottelun alku siirtää näkymän.
  if (hasGep) {
    hooks.gepReset('ow');
    await ev(`(() => { ${nav('settings')}; return true; })()`);
    await ev(`window.api.setSettings({ autoLive: true })`);
    await sleep(400);
    const enc0 = await ev(`window.api.owEncounters('Synth#1111').then((r) => r.data.total)`);
    SIM.play(gepFeed, SIM.owStart());
    await waitCheck('OW GEP: match_start siirtää Live-lobbyyn (toast), sivupalkin OW-piste vihreä', `document.body.dataset.game === 'ow' && document.querySelector('#tabs .tab.active').textContent === 'Live-lobby' && window.__t.toast('Ottelu alkoi (Overwatch 2)') && document.getElementById('ow-dot').classList.contains('connected')`, 8000);
    await ev(`window.api.setSettings({ autoLive: false })`);
    await check('OW GEP: lobby täyttyi rosterista (Oma tiimi = tiimikaverit, Viholliset = muut, oma BattleTag pois), Live: Overwolf GEP -rivi ja oma hero', `(() => {
      const v = window.__t.vis();
      const val = (t) => [...v.querySelectorAll('.team-col.' + t + ' .slot-input')].map((i) => i.value).filter(Boolean).join(',');
      const g = v.querySelector('.gep-live');
      return val('ally') === 'Synth#1111,Synth#2222,Synth#3333,TeKrop#2217' && val('enemy') === 'Priv#4444,Zzqxkv#99999' && !g.hidden && g.textContent.includes('Live: Overwolf GEP') &&
        g.textContent.includes('Sinä: Ana') && g.textContent.includes('1 pelaajan BattleTag ei välity') && v.querySelector('.ow-hint').hidden;
    })()`);
    await waitCheck('OW GEP: "Hae kaikki" ajettiin automaattisesti (kortit, yksityinen profiili, tuntematon tunnus -> virhe), live-liuskat (hero, K/D/A, vahinko)', `(() => {
      const v = window.__t.vis();
      const ally = v.querySelector('.team-col.ally'), enemy = v.querySelector('.team-col.enemy');
      if (v.querySelector('.pcard.state:not(.err)')) return false;
      const strips = [...v.querySelectorAll('.live-strip')];
      const widow = strips.find((s) => s.textContent.includes('Widowmaker'));
      return ally.querySelectorAll('.pcard:not(.state)').length >= 3 && enemy.textContent.includes('Profiili on yksityinen') && enemy.querySelectorAll('.pcard.state.err').length >= 1 &&
        strips.length === 6 && !!widow && widow.textContent.includes('K/D/A 9 / 4 / 2') && widow.textContent.includes('Vahinko');
    })()`, 45000);
    await shot('ow-lobby-gep');
    await check('OW GEP: automaattinen haku kirjasi lobbyn täsmälleen kerran', `(async () => (await window.api.owEncounters('Synth#1111')).data.total === ${enc0} + 1)()`);
    SIM.play(gepFeed, SIM.owProgress());
    await sleep(2500);
    await check('OW GEP: rosterin live-päivitys näkyy (Sinä: K/D/A 15 / 3 / 9), uutta automaattihakua ei tule samassa ottelussa', `(async () => {
      const v = window.__t.vis();
      const ok = await window.__t.until(() => v.querySelector('.gep-live').textContent.includes('K/D/A 15 / 3 / 9'), 4000);
      await window.__t.wait(2200);
      return ok && (await window.api.owEncounters('Synth#1111')).data.total === ${enc0} + 1;
    })()`);
    // Pidetään molemmat GEP-ottelut käynnissä asettelutarkistuksia varten (R6 Live-peli ja OW Live-lobby GEP-tilassa).
    const lay = await gepR6Players().catch(() => null);
    SIM.play(gepFeed, SIM.r6Start(lay ? lay.players : SIM.r6Players([])));
  }

  // ======================= 11. Asettelu, tilat ja kuvat molemmissa ikkunakooissa =======================
  const VIEWS = [
    ['oma-profiili', 'me', null], ['ow-oma-profiili', 'ow', 'Oma profiili'], ['ow-pelaajahaku', 'ow', 'Pelaajahaku'], ['ow-lobby', 'ow', 'Live-lobby'],
    ['rl-oma-profiili', 'rl', 'Oma profiili'], ['rl-live', 'rl', 'Live-peli'], ['rl-historia', 'rl', 'Historia'], ['rl-pelaajat', 'rl', 'Pelaajat'],
    ['r6-oma-profiili', 'r6', 'Oma profiili'], ['r6-live', 'r6', 'Live-peli'], ['r6-ottelut', 'r6', 'Ottelut'], ['r6-pelaajat', 'r6', 'Pelaajat'],
    ['r6-pelaajan-tarkistus', 'r6', 'Pelaajan tarkistus'], ['asetukset', 'settings', null],
  ];
  if (hooks && hooks.setOwnProfile) hooks.setOwnProfile(synthProfile('suspicious', 'SynthHacker', 'Synth-1111'));
  await ev(`(async () => {
    ${go('ow', 'Pelaajahaku')}; const v = window.__t.vis(), f = v.querySelector('.search-form');
    window.__t.set(f.querySelector('input'), 'Synth#1111'); f.requestSubmit();
    await window.__t.until(() => v.querySelector('.profile-head h1'));
    const d = v.querySelector('.profile-head .susp'); if (d && !d.open) d.querySelector('summary').click();
    return true;
  })()`);
  await ev(`(async () => {
    ${go('ow', 'Live-lobby')}; const v = window.__t.vis();
    window.__t.btn('Hae kaikki', v).click();
    await window.__t.until(() => v.querySelectorAll('.pcard:not(.state)').length >= 5);
    const d = v.querySelector('.pcard .susp.suspicious'); if (d && !d.open) d.querySelector('summary').click();
    return true;
  })()`);
  await ev(`(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    window.__t.btn('Arvioi kaikki', v).click();
    await window.__t.until(() => v.querySelector('.r6-team.ally .r6-row .susp.suspicious'));
    const d = v.querySelector('.r6-team.ally .r6-row .susp.suspicious'); if (d && !d.open) d.querySelector('summary').click();
    return true;
  })()`);
  for (const [w, h] of [[1280, 800], [1000, 680]]) {
    win.setContentSize(w, h);
    await sleep(500);
    await check(`Ikkunakoko ${w}x${h} käytössä`, `Math.abs(window.innerWidth - ${w}) <= 2 && Math.abs(window.innerHeight - ${h}) <= 2`);
    for (const [name, g, tab] of VIEWS) {
      try {
        await ev(`(() => { ${go(g, tab)}; document.getElementById('view').scrollTop = 0; return true; })()`);
        await sleep(450);
        const r = await ev('window.__t.overflow()');
        if (r.bad.length) fail(`Asettelu ${w}x${h}: ${name}`, r.bad.slice(0, 4).join(' | ')); else pass(`Asettelu ${w}x${h}: ${name}${r.info.length ? ` (sisäisiä vierityspalkkeja: ${r.info.length})` : ''}`);
        await shot(`${name}-${w}x${h}`);
      } catch (e) { fail(`Asettelu ${w}x${h}: ${name}`, e.message); }
    }
    // R6: avattu ottelu, pelaajan tiedot ja asetusten R6-kortti
    if (r6On) {
      const R6_STATES = [
        ['r6-ottelu-auki', `${go('r6', 'Ottelut')}; const v = window.__t.vis(); await window.__t.until(() => v.querySelector('.match-head'), 8000);
          const hd = v.querySelector('.match-head'); if (hd.getAttribute('aria-expanded') !== 'true') hd.click();
          await window.__t.until(() => v.querySelector('.r6-match-body .r6-rounds tbody tr'), 8000);`],
        ['r6-pelaaja', `${go('r6', 'Pelaajat')}; const v = window.__t.vis();
          await window.__t.until(() => v.querySelector('.r6-players-table tbody tr[data-player]'), 8000); v.querySelector('.r6-players-table tbody tr[data-player]').click();
          await window.__t.until(() => document.querySelector('.drawer-back:not([hidden]) .tiles') && document.querySelector('.drawer-back:not([hidden]) .match-head'), 8000);
          document.querySelector('.drawer-back:not([hidden]) .match-head').click();
          await window.__t.until(() => document.querySelector('.drawer-back:not([hidden]) .r6-match-body .r6-team-table'), 8000);`],
        ['asetukset-r6', `${nav('settings')}; await window.__t.wait(500); document.querySelector('.r6-settings').scrollIntoView(); await window.__t.wait(200);`],
      ];
      for (const [name, code] of R6_STATES) {
        try {
          await ev(`(async () => { ${code} return true; })()`);
          await sleep(450);
          const r = await ev('window.__t.overflow()');
          // Pelaajapaneeli on sivun päällä: sen sisältö ei saa vierittyä vaakasuunnassa
          const dw = await ev("(() => { const b = document.querySelector('.drawer-back:not([hidden]) .drawer-body'); const d = document.querySelector('.drawer-back:not([hidden]) .drawer'); return b ? Math.max(b.scrollWidth - b.clientWidth, d.getBoundingClientRect().right - window.innerWidth) : 0; })()");
          if (dw > 1) r.bad.push(`pelaajapaneeli ylittää leveyden ${dw} px`);
          if (r.bad.length) fail(`Asettelu ${w}x${h}: ${name}`, r.bad.slice(0, 4).join(' | ')); else pass(`Asettelu ${w}x${h}: ${name}${r.info.length ? ` (sisäisiä vierityspalkkeja: ${r.info.length})` : ''}`);
          await shot(`${name}-${w}x${h}`);
          await ev('(() => { PlayerPanel.close(); return true; })()');
        } catch (e) { fail(`Asettelu ${w}x${h}: ${name}`, e.message); }
      }
    }
    // Hakkerimerkki auki / lobbyn merkit näkyvät kuvissa
    await ev(`(() => { ${go('ow', 'Live-lobby')}; return true; })()`);
    await shot(`ow-lobby-merkit-${w}x${h}`);
  }
  win.setContentSize(1280, 800);
  await sleep(400);
  if (hooks && hooks.clearOwn) hooks.clearOwn();
  if (hasGep) hooks.gepReset();

  // ======================= 12. Tuhoavat toiminnot (viimeiseksi) =======================
  await check('Asetukset: Nollaa OW-profiilin historia kysyy vahvistuksen; Peruuta säilyttää, vahvistus tyhjentää', `(async () => {
    ${nav('settings')}; await window.__t.wait(700);
    const v = window.__t.vis();
    const hist = async () => (await window.api.profileGet()).data.ow.snapshots.length;
    const before = await hist();
    window.__t.btn('Nollaa OW-profiilin historia', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta')))) return false;
    window.__t.modalBtn('Peruuta').click(); await window.__t.wait(300);
    if ((await hist()) !== before) return false;
    window.__t.btn('Nollaa OW-profiilin historia', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Nollaa')))) return false;
    window.__t.modalBtn('Nollaa').click();
    if (!(await window.__t.until(() => window.__t.toast('OW-historia nollattu')))) return false;
    await window.__t.wait(500);
    return (await hist()) <= 1;
  })()`);
  await check('Asetukset: Tyhjennä RL-otteluhistoria kysyy vahvistuksen; vahvistus tyhjentää', `(async () => {
    const v = window.__t.vis();
    window.__t.btn('Tyhjennä RL-otteluhistoria', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta')))) return false;
    window.__t.modalBtn('Peruuta').click(); await window.__t.wait(200);
    window.__t.btn('Tyhjennä RL-otteluhistoria', v).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Tyhjennä')))) return false;
    window.__t.modalBtn('Tyhjennä').click();
    if (!(await window.__t.until(() => window.__t.toast('RL-historia tyhjennetty')))) return false;
    return (await window.api.rlHistory()).data.matches.length === 0;
  })()`);
  await check('R6 lobby: Tyhjennä tyhjentää rivit ja muistin; lomake Tyhjennä lomake', `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    window.__t.btn('Tyhjennä', v.querySelector('.r6-lobby')).click();
    const emptyRows = [...v.querySelectorAll('.r6-row')].every((r) => r.querySelector('.r6-name').value === '' && [...r.querySelectorAll('.r6-num')].every((i) => i.value === '') && r.querySelector('.r6-row-res').children.length === 0);
    window.__t.btn('Tyhjennä lomake', v.querySelector('.r6-single')).click();
    const f = v.querySelector('.r6-single form');
    const mem = JSON.parse(localStorage.getItem('statsikka.r6lobby'));
    return emptyRows && [...f.querySelectorAll('.r6-fields input')].every((i) => i.value === '') && mem.ally.every((e) => e.name === '' && e.kd === '');
  })()`);
  await check('RL Historia: tyhjä tila näkyy tyhjennyksen jälkeen; Tyhjennä-nappi pois käytöstä', `(async () => {
    ${go('rl', 'Historia')}; await window.__t.wait(700);
    const v = window.__t.vis();
    return v.textContent.includes('Ei vielä otteluita') && window.__t.btn('Tyhjennä historia', v).disabled;
  })()`);
  await shot('rl-historia-tyhja');
  if (rlOn) {
    await waitCheck('RL Historia: uusi mock-ottelu tallentuu tyhjennyksen jälkeen ja Tyhjennä historia -vahvistus toimii', `(async () => {
      ${go('rl', 'Historia')}; await window.__t.wait(300);
      const v = window.__t.vis(); const b = window.__t.btn('Tyhjennä historia', v);
      window.__t.nav('rl'); window.__t.tab('Oma profiili'); window.__t.tab('Historia'); await window.__t.wait(500);
      const n = (await window.api.rlHistory()).data.matches.length;
      if (n < 1) return false;
      const b2 = window.__t.btn('Tyhjennä historia', window.__t.vis());
      if (b2.disabled) return false;
      b2.click();
      if (!(await window.__t.until(() => window.__t.modalBtn('Tyhjennä')))) return false;
      window.__t.modalBtn('Tyhjennä').click();
      return await window.__t.until(() => window.__t.vis().textContent.includes('Ei vielä otteluita'));
    })()`, 80000); // odottaa kokonaista mock-ottelua (60 s + 4 s tauko)
  }

  await sleep(300);
  if (errors.length) { log(`SMOKE VIRHEET (${errors.length}, ok: ${okCount}):`); errors.forEach((e) => log(`  - ${e}`)); app.exit(1); }
  else { log(`SMOKE OK (${okCount} tarkistusta)`); app.quit(); }
};
