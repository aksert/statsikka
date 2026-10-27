'use strict';
// Savutesti: Arenyze (R6-tilastot). Ajetaan smoke.js:stä. Oikeaa verkkoa Arenyzeen EI käytetä: pääprosessin fetch korvataan tässä tiedostossa olevalla
// stubilla, joka palauttaa test/arenyze/-fixturejen JSON:ia (rakennettu r6.arenyze.com/api-docs -esimerkeistä). Ikkunaa ei näytetä.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FX_DIR = path.join(__dirname, '..', '..', 'test', 'arenyze');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FX_DIR, n), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SMOKE_KEY = 'smoke-fake-arz-key-000000';
const WRONG_KEY = 'wrong-smoke-key-111111';

// Nimestä johdetut keinotekoiset pelaajat: *Hacker* = selvästi epätavalliset luvut, *Unranked* = ei rankattuja tietoja, *Missing* = 404,
// muut: RP = 3000 + 100 × nimen loppunumero (esim. ArzPlayer3 = 3 300 RP = Platinum II).
function fullstatsFor(name) {
  const j = fixture('fullstats.json');
  j.player.nameOnPlatform = name;
  const fp = j.fullStats.platform_families_full_profiles[0].board_ids_full_profiles[0].full_profiles[0];
  if (/hacker/i.test(name)) {
    Object.assign(fp.profile, { rank: 30, rank_points: 4200, max_rank_points: 4300, kills: 4000, deaths: 1176, wins: 150, losses: 50, abandon: 0 });
    Object.assign(fp.season_statistics, { kills: 4000, deaths: 1176, match_outcomes: { wins: 150, losses: 50, abandons: 0 } });
    j.fullStats.operators = [{ operator: 'Ash', side: 'Attacker', roundsPlayed: 900, kd: 3.4, kills: 4000, deaths: 1176, headshots: 3200 }];
    j.fullStats.data.metadata.clearanceLevel = 20;
  } else if (/unranked/i.test(name)) {
    j.fullStats.platform_families_full_profiles = [];
    j.fullStats.data.segments = [];
  } else {
    const m = /(\d+)$/.exec(name);
    fp.profile.rank_points = 3000 + (m ? Number(m[1]) : 3) * 100;
  }
  return j;
}
// rpHistory: [{ ts, rp }] korvaa fixturen rank-historian (fixturen ajat ovat 2025-10, eivät osu testiotteluihin): RP-chip-tarkistus rakentaa sen otteluista.
let rpHistory = null;
function profileFor(name) {
  const j = fixture('profile.json');
  j.player.nameOnPlatform = name;
  if (rpHistory) j.history.data.history.data = rpHistory.map((p) => [new Date(p.ts).toISOString(), { displayName: 'Rank Points', metadata: { rank: 'EMERALD IV' }, value: p.rp, displayValue: String(p.rp), displayType: 'Number' }]);
  return j;
}
// Feikki fetch: kirjaa kutsut (path, name, platform, key) ja vastaa kuin Arenyze (401 väärällä avaimella).
function createStub() {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    const key = init && init.headers ? init.headers['api-key'] : undefined;
    const call = { path: u.pathname.replace('/r6/api', ''), name: u.searchParams.get('nameOnPlatform') || '', platform: u.searchParams.get('platformType') || '', key, host: u.host };
    calls.push(call);
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
    await sleep(40);
    if (key !== SMOKE_KEY) return reply(401, { error: 'Invalid api-key' });
    if (call.path === '/me/usage') { const j = fixture('usage.json'); j.usage.total_calls = 40; return reply(200, j); }
    if (/missing/i.test(call.name)) return reply(404, { error: 'Player not found' });
    if (call.path === '/v2/fullstats') return reply(200, fullstatsFor(call.name));
    if (call.path === '/v2/profile') return reply(200, profileFor(call.name));
    if (call.path === '/v2/operators') return reply(200, fixture('operators.json'));
    return reply(404, {});
  };
  impl.calls = calls;
  return impl;
}

// h: { ev, check, waitCheck, pass, fail, info, nav, go, shot, hooks, SIM, gepFeed, hasGep, r6On }
exports.run = async function run(h) {
  const { win, ev, check, waitCheck, pass, fail, info, nav, go, shot, hooks, SIM, gepFeed, hasGep, r6On } = h;
  if (!hooks || !hooks.arzSetFetch) { info('Arenyze: koukkuja ei ole, tarkistukset ohitettu'); return; }
  const stub = createStub();
  hooks.arzSetFetch(stub);
  // Ilmoitukset pois ennen kuvakaappausta (ne kertyvät testin aikana ja peittäisivät kuvan).
  const snap = async (name) => { await ev("(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); return true; })()"); await shot(name); };
  // Asettelutarkistus molemmissa ikkunakooissa (sama vaakavierityksen / reunan ylityksen tarkistus kuin smoke.js:n osiossa 11); setup = sivun koodi, joka avaa tarkistettavan näkymän.
  const layoutAt = async (name, setup, drawer) => {
    for (const [w, hh] of [[1280, 800], [1000, 680]]) {
      try {
        win.setContentSize(w, hh);
        await sleep(500);
        await ev('(async () => { ' + setup + ' return true; })()');
        await sleep(450);
        const r = await ev('window.__t.overflow()');
        if (drawer) { const dw = await ev("(() => { const b = document.querySelector('.drawer-back:not([hidden]) .drawer-body'); const d = document.querySelector('.drawer-back:not([hidden]) .drawer'); return b ? Math.max(b.scrollWidth - b.clientWidth, d.getBoundingClientRect().right - window.innerWidth) : 0; })()"); if (dw > 1) r.bad.push('pelaajapaneeli ylittää leveyden ' + dw + ' px'); await ev('(() => { PlayerPanel.close(); return true; })()'); }
        if (r.bad.length) fail('Asettelu ' + w + 'x' + hh + ': ' + name, r.bad.slice(0, 4).join(' | ')); else pass('Asettelu ' + w + 'x' + hh + ': ' + name + (r.info.length ? ' (sisäisiä vierityspalkkeja: ' + r.info.length + ')' : ''));
      } catch (e) { fail('Asettelu ' + w + 'x' + hh + ': ' + name, e.message); }
    }
    try { win.setContentSize(1280, 800); } catch (_) { /* ei väliä */ }
    await sleep(300);
  };
  const mainCheck = (name, ok, why) => (ok ? pass(name) : fail(name, why));
  // Lasketaan vain tämän testin keinotekoiset pelaajat (Arz*, SmokeR6) ja käyttökutsut: oikeiden ottelutallenteiden nimiä voidaan hakea stubista taustalla.
  const mine = (c) => c.path === '/me/usage' || /^(Arz|SmokeR6$)/.test(c.name);
  const nCalls = (pth, pred) => stub.calls.filter((c) => mine(c) && (!pth || c.path === pth) && (!pred || pred(c))).length;
  const NORM = "const nz = (s) => s.replace(/[\\s\\u00a0\\u202f]+/g, ' ');" // lukujen tuhaterotin (NBSP) -> tavallinen väli
    + " const settle = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await window.__t.wait(80); } return false; };";
  const players = (prefix, hackerLast) => Array.from({ length: 10 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000008${String(10 + i)}`, name: hackerLast && i === 9 ? 'ArzHacker9' : `${prefix}${i}`, local: i === 0, team: i < 5 ? 'Blue' : 'Orange',
    kills: i, deaths: 1, assists: 0, score: 100 + i,
  }));
  const startMatch = async (list) => {
    hooks.gepReset('r6');
    SIM.play(gepFeed, SIM.r6Start(list));
    await ev(`${go('r6', 'Live-peli')}; true`);
  };
  await ev(`window.api.setSettings({ autoLive: false, arenyzeAuto: true, arenyzeSoftLimit: 1800 })`);
  const storageOk = await ev(`window.api.arenyzeStatus().then((r) => r.data.storageAvailable)`);

  // ---------- A. Ilman avainta: ohjeet näkyvät, mitään ei haeta ----------
  await check('Arenyze (ei avainta): Asetukset-kortti (tila, avainkenttä, ohjeet, https-linkki, yksityisyys, pehmeä raja 1 800, kytkin pois käytöstä)', `(async () => {
    ${nav('settings')};
    if (!(await window.__t.until(() => window.__t.vis().querySelector('.arz-settings .arz-state'), 6000))) return false;
    const c = window.__t.vis().querySelector('.arz-settings');
    const links = [...c.querySelectorAll('a')].map((a) => a.href);
    return c.textContent.includes('R6-tilastot (Arenyze API)') && c.querySelector('.arz-state').textContent === 'Ei avainta' && links.includes('https://r6.arenyze.com/') && links.every((l) => l.startsWith('https://')) &&
      c.querySelectorAll('input[type=password]').length === 1 && !!window.__t.btn('Testaa avain', c) && window.__t.btn('Poista avain', c).disabled && window.__t.btn('Päivitä käyttö', c).disabled && c.querySelector('input.arz-auto').disabled &&
      c.textContent.includes('Luo ilmainen tili') && c.textContent.includes('Dashboard → API key') && c.textContent.includes('Yksityisyys') && c.textContent.includes('arenyze-key.bin') && c.textContent.includes('2 000 kutsua') && c.querySelector('input.arz-limit').value === '1800';
  })()`);
  await check('Arenyze (ei avainta): pelaajapaneeli näyttää ohjeen ja Avaa asetukset -napin', `(async () => {
    R6Player.open('u:arzplayer3', 'ArzPlayer3');
    const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
    if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-section .arz-nokey'), 6000))) return false;
    const t = dr().querySelector('.arz-section').textContent;
    const ok = t.includes('Ubisoftin tilastot (Arenyze)') && t.includes('r6.arenyze.com') && t.includes('API key') && !!window.__t.btn('Avaa asetukset', dr()) && !dr().querySelector('.arz-section .arz-tiles');
    PlayerPanel.close(); return ok;
  })()`);
  if (hasGep) {
    await startMatch(players('ArzNoKey', false));
    await waitCheck('Arenyze (ei avainta): GEP-pistetaulu näyttää 10 pelaajaa ilman Ranked (Arenyze) -saraketta', `(() => { const v = window.__t.vis(); return v.querySelectorAll('tr[data-player]').length === 10 && ![...v.querySelectorAll('th')].some((t) => t.textContent === 'Ranked (Arenyze)'); })()`, 8000);
    hooks.gepReset('r6'); // keskeneräinen GEP-ottelu ei saa laukaista hakuja, kun avain lisätään
  }
  await check('Arenyze (ei avainta): Pelaajan tarkistus -> Hae Arenyzestä kertoo avaimen puuttumisesta', `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    const form = v.querySelector('.r6-single form');
    window.__t.set(form.querySelector('.r6-field.wide input'), 'ArzHacker1');
    window.__t.btn('Hae Arenyzestä', form).click();
    return await window.__t.until(() => form.querySelector('.arz-check-msg').textContent.includes('Arenyze-avainta ei ole asetettu'), 5000);
  })()`);
  await check('Arenyze (ei avainta): Oma profiili (R6) näyttää ohjeen', `(async () => {
    ${go('r6', 'Oma profiili')}; const v = window.__t.vis();
    return await window.__t.until(() => v.querySelector('.arz-section .arz-nokey') && v.querySelector('.arz-section').textContent.includes('Ubisoftin tilastot (Arenyze)'), 6000);
  })()`);
  mainCheck('Arenyze (ei avainta): mitään ei haettu Arenyzestä', stub.calls.length === 0, `kutsuja ${stub.calls.length}`);

  if (!storageOk) {
    info('Arenyze: safeStorage ei ole käytettävissä, avaintarkistukset ohitettu');
    await check('Arenyze: ilman salausta avainta ei tallenneta ja syy selitetään', `(async () => { const r = await window.api.arenyzeTest({ key: '${SMOKE_KEY}' }); return !r.ok && r.error.message.includes('Salausta'); })()`);
    return;
  }

  // ---------- B. IPC-validointi ja avain ----------
  await check('Arenyze IPC: virheelliset pyynnöt hylätään (BAD_INPUT), tuntematon asetus ja virheellinen raja hylätään', `Promise.all([
    window.api.arenyzeLookup(5), window.api.arenyzeLookup({}), window.api.arenyzeLookup({ name: '' }), window.api.arenyzeLookup({ name: 'a', platform: 'steam' }), window.api.arenyzeLookup({ name: 'a', kind: 'x' }),
    window.api.arenyzeLookup({ name: 'a', mode: 'auto' }), window.api.arenyzeLookup({ name: 'a', evil: 1 }), window.api.arenyzeLookup({ name: 'x'.repeat(41) }),
    window.api.arenyzeTest({ key: 'short' }), window.api.arenyzeTest({ key: 'has space in it' }), window.api.arenyzeTest({ key: '${SMOKE_KEY}', evil: 1 }), window.api.arenyzeTest(5),
  ]).then(async (rs) => rs.every((r) => !r.ok && r.error.code === 'BAD_INPUT') &&
    (await window.api.setSettings({ arenyzeSoftLimit: -1 })).ok === false && (await window.api.setSettings({ arenyzeSoftLimit: '5' })).ok === false && (await window.api.setSettings({ arenyzeAuto: 'x' })).ok === false && (await window.api.setSettings({ arenyzeKey: 'x' })).ok === false)`);
  mainCheck('Arenyze (virheelliset pyynnöt): ei verkkokutsuja', stub.calls.length === 0, `kutsuja ${stub.calls.length}`);
  await check('Arenyze: väärä avain hylätään (virheilmoitus, ei tallennu, tila "Ei avainta")', `(async () => {
    ${nav('settings')}; const c = window.__t.vis().querySelector('.arz-settings');
    window.__t.set(c.querySelector('input[type=password]'), '${WRONG_KEY}'); window.__t.btn('Testaa avain', c).click();
    if (!(await window.__t.until(() => window.__t.toast('hylkäsi', true), 6000))) return false;
    await window.__t.wait(300);
    const st = (await window.api.arenyzeStatus()).data;
    return !st.configured && st.lastTest && st.lastTest.ok === false && c.querySelector('.arz-state').textContent === 'Ei avainta' && c.textContent.includes('Testi epäonnistui');
  })()`);
  mainCheck('Arenyze (väärä avain): vain /me/usage-testikutsu, avainta ei tallennettu', nCalls('/me/usage') === 1 && nCalls() === 1 && !fs.existsSync(hooks.arzKeyFile()), `kutsuja ${nCalls()}`);
  await check('Arenyze: oikea avain testataan (/me/usage), tallentuu salattuna, kenttä tyhjenee, käyttö ja palvelimen lukema näkyvät', `(async () => {
    ${NORM}
    const c = window.__t.vis().querySelector('.arz-settings');
    const inp = c.querySelector('input[type=password]'); window.__t.set(inp, '${SMOKE_KEY}');
    window.__t.btn('Testaa avain', c).click();
    if (!(await window.__t.until(() => window.__t.toast('Avain toimii ja on tallennettu'), 6000))) return false;
    if (inp.value !== '') return false;
    if (!(await window.__t.until(() => c.querySelector('.arz-state').textContent === 'Avain tallennettu salattuna', 4000))) return false;
    const t = nz(c.textContent), st = (await window.api.arenyzeStatus()).data, s = (await window.api.getSettings()).data;
    const leak = JSON.stringify(st) + JSON.stringify(s) + c.textContent + document.body.textContent;
    return t.includes('Testi onnistui') && t.includes('40 / 2 000 kutsua') && nz(c.querySelector('.arz-usage').textContent).includes('pehmeä raja 1 800') && !c.querySelector('input.arz-auto').disabled && !window.__t.btn('Poista avain', c).disabled &&
      st.configured && st.usage.used === 40 && st.server.limit === 2000 && st.server.plan === 'free' && !leak.includes('${SMOKE_KEY}');
  })()`);
  {
    const keyFile = hooks.arzKeyFile();
    const raw = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null;
    const settingsTxt = fs.readFileSync(path.join(os.tmpdir(), 'statsikka-smoke', 'settings.json'), 'utf8');
    mainCheck('Arenyze: arenyze-key.bin on olemassa ja salattu; avain ei ole asetuksissa eikä välimuistissa', !!raw && raw.length > 10 && !raw.toString('latin1').includes(SMOKE_KEY) && !raw.toString('utf8').includes(SMOKE_KEY) && !settingsTxt.includes(SMOKE_KEY) && path.basename(keyFile) === 'arenyze-key.bin', raw ? 'sisältää selkotekstiä tai on tyhjä' : 'puuttuu');
    hooks.arzFlush();
    const cacheFile = hooks.arzCacheFile();
    mainCheck('Arenyze: välimuistitiedosto ei sisällä avainta', !fs.existsSync(cacheFile) || !fs.readFileSync(cacheFile, 'utf8').includes(SMOKE_KEY), 'avain vuoti välimuistiin');
  }
  mainCheck('Arenyze: testikutsut kulkivat api-key-otsakkeella osoitteeseen public-api.arenyze.com (fetch oli stub)', stub.calls.length === 2 && stub.calls.every((c) => c.host === 'public-api.arenyze.com' && c.path === '/me/usage') && stub.calls[1].key === SMOKE_KEY, JSON.stringify(stub.calls));
  await check('Arenyze: Päivitä käyttö hakee palvelimen lukeman; pehmeä raja ja automaattihaun kytkin tallentuvat (virheellinen raja hylätään)', `(async () => {
    ${NORM}
    ${nav('settings')}; const c = window.__t.vis().querySelector('.arz-settings');
    window.__t.btn('Päivitä käyttö', c).click();
    if (!(await window.__t.until(() => window.__t.toast('Käyttö päivitetty'), 5000))) return false;
    const lim = c.querySelector('input.arz-limit');
    window.__t.set(lim, '1200');
    if (!(await settle(async () => (await window.api.getSettings()).data.arenyzeSoftLimit === 1200, 4000))) return false;
    window.__t.set(lim, '-3');
    if (!(await window.__t.until(() => window.__t.toast('Pehmeän rajan pitää olla', true), 4000)) || lim.value !== '1200') return false;
    window.__t.set(lim, '1800');
    if (!(await settle(async () => (await window.api.getSettings()).data.arenyzeSoftLimit === 1800, 4000))) return false;
    const auto = c.querySelector('input.arz-auto');
    auto.checked = false; auto.dispatchEvent(new Event('change', { bubbles: true }));
    if (!(await settle(async () => (await window.api.getSettings()).data.arenyzeAuto === false, 4000))) return false;
    auto.checked = true; auto.dispatchEvent(new Event('change', { bubbles: true }));
    return await settle(async () => (await window.api.getSettings()).data.arenyzeAuto === true, 4000);
  })()`);

  // ---------- C. Pelaajapaneeli: tuntematon pelaaja (ei ole omissa tallenteissa) ----------
  const panelJs = (name, extra) => `(async () => {
    ${NORM}
    R6Player.open('u:${name.toLowerCase()}', '${name}');
    const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
    if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-section .arz-history .chart-svg path.ch-line, .arz-section .arz-err, .arz-section .arz-history .chart-empty'), 8000))) return false;
    const sec = dr().querySelector('.arz-section');
    ${extra}
  })()`;
  await check('Arenyze-paneeli: rank, RP, huipparank, K/D, V-H, ottelut, HS-%, taso, rank-historia (kaavio), operaattorit, kaudet, ikä ja Päivitä', panelJs('ArzPlayer3', `
    const t = nz(sec.textContent), tiles = [...sec.querySelectorAll('.arz-tiles .tile')].map((x) => nz(x.textContent));
    const hist = sec.querySelectorAll('.arz-history .chart-svg path.ch-line').length === 1 && sec.querySelectorAll('.arz-history circle.ch-dot').length === 4;
    const ok = tiles.length === 7 && tiles[0].includes('Platinum II') && tiles[0].includes('3 300 RP') && tiles[0].includes('Y10S4') && tiles[1].includes('Platinum I') && tiles[1].includes('3 450 RP') &&
      tiles[2].includes('1,05') && tiles[2].includes('1 240 / 1 180') && tiles[3].includes('64 - 51') && tiles[3].includes('55,7') && tiles[4].includes('117') && tiles[4].includes('2 keskeytystä') && tiles[5].includes('44,2 %') && tiles[6].includes('312') &&
      hist && t.includes('Parhaat operaattorit') && t.includes('Ash') && t.includes('Twitch') && t.includes('Y10S3') && t.includes('3 150') && t.includes('haettu juuri nyt') && !!window.__t.btn('Päivitä', sec) &&
      t.includes('Ubisoftin kausitilastoista (Arenyze):') && t.includes('Ei epätavallisia tilastoja') && nz(dr().textContent).includes('Ei aiempia tallenteita') && t.includes('Muiden pelaajien ottelukohtaista historiaa ei ole saatavilla') && dr().querySelector('.drawer-title').textContent === 'ArzPlayer3';
    return ok;`), `(() => { const sec = document.querySelector('.drawer-back:not([hidden]) .arz-section'); return sec && sec.textContent.slice(0, 400); })()`);
  mainCheck('Arenyze-paneeli: yksi fullstats- ja yksi profile-kutsu pelaajalle, ranked-suodatin ja platform=uplay', nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer3') === 1 && nCalls('/v2/profile', (c) => c.name === 'ArzPlayer3') === 1 && stub.calls.filter((c) => c.name === 'ArzPlayer3').every((c) => c.platform === 'uplay'), JSON.stringify(stub.calls.slice(-3)));
  const callsBefore = nCalls();
  await check('Arenyze-paneeli: Päivitä alle 30 s vanhalle tulokselle ja paneelin uudelleenavaus eivät hae uudelleen (TTL)', `(async () => {
    const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
    window.__t.btn('Päivitä', dr().querySelector('.arz-section')).click();
    await window.__t.wait(500);
    PlayerPanel.close();
    R6Player.open('u:arzplayer3', 'ArzPlayer3');
    if (!(await window.__t.until(() => dr() && dr().querySelectorAll('.arz-tiles .tile').length === 7 && dr().querySelector('.arz-history .chart-svg'), 6000))) return false;
    PlayerPanel.close(); return true;
  })()`);
  mainCheck('Arenyze-paneeli: ei uusia kutsuja (välimuisti)', nCalls() === callsBefore, `uusia kutsuja ${nCalls() - callsBefore}`);
  await check('Arenyze-paneeli: epätavalliset tilastot (Mahdollinen hakkeri, perusteet auki, Arenyze-huomautus)', panelJs('ArzHacker1', `
    const d = sec.querySelector('.susp.suspicious'); const t = nz(sec.textContent), tiles = [...sec.querySelectorAll('.arz-tiles .tile')].map((x) => nz(x.textContent));
    return !!d && d.open && d.textContent.includes('Mahdollinen hakkeri') && d.querySelectorAll('.susp-reasons li').length === 4 && d.textContent.includes('Perustuu Ubisoftin kausitilastoihin (Arenyze), ei todiste huijaamisesta.') &&
      t.includes('Headshot') && t.includes('Diamond III') && tiles[0].includes('4 200 RP') && tiles[5].includes('80,0 %') && tiles[6].includes('20');`));
  await ev(`(() => { const sec = document.querySelector('.drawer-back:not([hidden]) .arz-section'); if (sec) sec.scrollIntoView(); return true; })()`);
  await snap('r6-arenyze-paneeli');
  await ev('(() => { PlayerPanel.close(); return true; })()');
  await check('Arenyze-paneeli: pelaajaa ei löydy (404) -> selkeä virhe; rankittomalle pelaajalle viesti', panelJs('ArzMissing1', `
    const miss = sec.querySelector('.arz-err') && nz(sec.querySelector('.arz-err').textContent).includes('Pelaajaa ei löytynyt Arenyzestä');
    PlayerPanel.close();
    R6Player.open('u:arzunranked1', 'ArzUnranked1');
    if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-section') && dr().querySelector('.arz-section').textContent.includes('rankattuja tilastoja ei ole'), 6000))) return false;
    PlayerPanel.close(); return miss;`));
  await check('Arenyze-paneeli: alustan vaihto (PlayStation) hakee uudelleen psn-alustalla', `(async () => {
    R6Player.open('u:arzplayer5', 'ArzPlayer5');
    const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
    if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-tiles .tile') && dr().querySelector('.arz-history .chart-svg'), 8000))) return false;
    [...dr().querySelectorAll('.arz-section .seg button')].find((b) => b.textContent === 'PlayStation').click();
    await window.__t.wait(900);
    PlayerPanel.close(); return true;
  })()`);
  mainCheck('Arenyze-paneeli: psn-haku tehtiin (alusta välitetään rajapinnalle)', nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer5' && c.platform === 'psn') === 1 && nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer5' && c.platform === 'uplay') === 1, JSON.stringify(stub.calls.filter((c) => c.name === 'ArzPlayer5')));
  if (r6On) {
    await check('Arenyze-paneeli: tallenteista tuttu pelaaja (Pelaajat-lista): Arenyze-osio ja ottelutallenteiden osio rinnakkain', `(async () => {
      ${go('r6', 'Pelaajat')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelector('.r6-players-table tbody tr[data-player]'), 8000))) return false;
      v.querySelector('.r6-players-table tbody tr[data-player]').click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-section .arz-history .chart-svg') && dr().querySelector('.match-head'), 10000))) return false;
      const t = dr().textContent;
      const ok = t.includes('Ubisoftin tilastot (Arenyze)') && t.includes('Parhaat operaattorit') && t.includes('Ubisoft ei tarjoa muiden pelaajien otteluhistoriaa');
      PlayerPanel.close(); return ok;
    })()`);
  }

  // ---------- D. Live-pelin rivit (GEP-rosteri): haetaan kerran per pelaaja, ei uudelleen TTL:n sisällä ----------
  if (hasGep) {
    const list1 = players('ArzPlayer', true);               // ArzPlayer0..8 + ArzHacker9; ArzPlayer3 on jo välimuistissa (paneeli)
    const fsBefore = nCalls('/v2/fullstats');
    await startMatch(list1);
    await waitCheck('Arenyze live: Ranked (Arenyze) -sarake, kaikilla 10 pelaajalla rank-merkki; rank + RP, K/D ja V-H riveillä; epäilyn merkki hakkeririvillä', `(() => {
      const nz = (s) => s.replace(/[\\s\\u00a0\\u202f]+/g, ' ');
      const v = window.__t.vis(); const rows = [...v.querySelectorAll('tr[data-player]')];
      if (rows.length !== 10 || ![...v.querySelectorAll('th')].some((t) => t.textContent === 'Ranked (Arenyze)')) return false;
      const cells = rows.map((r) => r.querySelector('td.arz-cell'));
      if (cells.some((c) => !c || !c.querySelector('.arz-rank'))) return false;
      const by = (n) => rows.find((r) => r.querySelector('.pname').textContent === n);
      const p3 = nz(by('ArzPlayer3').querySelector('td.arz-cell').textContent), hk = by('ArzHacker9').querySelector('td.arz-cell');
      return p3.includes('Platinum II') && p3.includes('3 300 RP') && p3.includes('K/D 1,05') && p3.includes('V-H 64-51') && nz(by('ArzPlayer0').querySelector('td.arz-cell').textContent).includes('Platinum V') &&
        !!hk.querySelector('.susp.suspicious.compact') && hk.textContent.includes('Diamond III') && rows.filter((r) => r.querySelector('td.arz-cell .susp')).length === 1 &&
        v.querySelector('.arz-note') && v.querySelector('.arz-note').textContent.includes('kausitilastoista');
    })()`, 15000);
    await ev(`(() => { const v = window.__t.vis(); const t = v.querySelector('.r6-team-table'); if (t) t.scrollIntoView(); return true; })()`);
    await snap('r6-live-arenyze');
    mainCheck('Arenyze live: täsmälleen yksi fullstats-haku jokaista uutta pelaajaa kohden (ArzPlayer3 ja ArzPlayer5 olivat jo välimuistissa -> 8 uutta)', nCalls('/v2/fullstats') - fsBefore === 8 && nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer3') === 1 && nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer5' && c.platform === 'uplay') === 1, `uusia fullstats-hakuja ${nCalls('/v2/fullstats') - fsBefore}`);
    SIM.play(gepFeed, SIM.r6Progress(list1));
    await sleep(1500);
    mainCheck('Arenyze live: rosterin live-päivitys (GEP) ei laukaise uusia hakuja', nCalls('/v2/fullstats') - fsBefore === 8, `fullstats-hakuja ${nCalls('/v2/fullstats') - fsBefore}`);
    await layoutAt('arenyze-live-pistetaulu', `${go('r6', 'Live-peli')}; document.getElementById('view').scrollTop = 0; await window.__t.wait(300);`);
    await layoutAt('arenyze-live-pelaajapaneeli', `R6Player.open('u:arzhacker9', 'ArzHacker9'); await window.__t.until(() => document.querySelector('.drawer-back:not([hidden]) .arz-history .chart-svg'), 8000);`, true);
    await check('Arenyze live: rivin klikkaus avaa paneelin; yhteenveto tulee välimuistista (ei uutta fullstats-kutsua), profiili haetaan kerran', `(async () => {
      const v = window.__t.vis(); const row = [...v.querySelectorAll('tr[data-player].clickable')].find((r) => r.querySelector('.pname').textContent === 'ArzHacker9');
      if (!row) return false;
      row.click();
      const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
      if (!(await window.__t.until(() => dr() && dr().querySelector('.arz-tiles .tile') && dr().querySelector('.arz-history .chart-svg') && dr().querySelector('.susp.suspicious'), 8000))) return false;
      const ok = dr().querySelector('.drawer-title').textContent === 'ArzHacker9';
      PlayerPanel.close(); return ok;
    })()`);
    mainCheck('Arenyze live: paneelin avaus ei hakenut yhteenvetoa uudelleen (TTL)', nCalls('/v2/fullstats', (c) => c.name === 'ArzHacker9') === 1 && nCalls('/v2/profile', (c) => c.name === 'ArzHacker9') === 1, JSON.stringify(stub.calls.filter((c) => c.name === 'ArzHacker9').map((c) => c.path)));

    // Budjetti: pehmeä raja = nykyinen käyttö + 3 -> vain 3 uutta hakua, loput "Raja täynnä"; rajan nosto hakee loput itsestään
    const used = hooks.arzUsage().used;
    await ev(`window.api.setSettings({ arenyzeSoftLimit: ${used + 3} })`);
    const bBefore = nCalls('/v2/fullstats');
    await startMatch(players('ArzBud', false));
    await waitCheck('Arenyze live: pehmeä raja täynnä -> vain 3 uutta hakua, loput rivit "Raja täynnä"', `(() => {
      const v = window.__t.vis(); const cells = [...v.querySelectorAll('tr[data-player] td.arz-cell')];
      return cells.length === 10 && cells.filter((c) => c.querySelector('.arz-rank')).length === 3 && cells.filter((c) => c.textContent.includes('Raja täynnä')).length === 7;
    })()`, 12000);
    mainCheck('Arenyze live: budjetti katkaisi haut (kutsuja täsmälleen 3), oma rivi haetaan viimeisenä', nCalls('/v2/fullstats') - bBefore === 3 && !stub.calls.some((c) => c.name === 'ArzBud0'), `hakuja ${nCalls('/v2/fullstats') - bBefore}`);
    await ev(`window.api.setSettings({ arenyzeSoftLimit: 1800 })`);
    await waitCheck('Arenyze live: pehmeän rajan nosto hakee loput pelaajat itsestään (10 / 10, ei kaksoishakuja)', `(() => { const cells = [...window.__t.vis().querySelectorAll('tr[data-player] td.arz-cell')]; return cells.length === 10 && cells.every((c) => c.querySelector('.arz-rank')); })()`, 12000);
    mainCheck('Arenyze live: jokainen ArzBud-pelaaja haettu täsmälleen kerran', nCalls('/v2/fullstats', (c) => /^ArzBud/.test(c.name)) === 10 && new Set(stub.calls.filter((c) => /^ArzBud/.test(c.name) && c.path === '/v2/fullstats').map((c) => c.name)).size === 10, JSON.stringify(stub.calls.filter((c) => /^ArzBud/.test(c.name)).map((c) => c.name)));
    // Automaattihaku pois: ei saraketta eikä hakuja
    await ev(`window.api.setSettings({ arenyzeAuto: false })`);
    const oBefore = nCalls();
    await startMatch(players('ArzOff', false));
    await waitCheck('Arenyze live: automaattihaku pois -> ei Arenyze-saraketta eikä hakuja', `(() => { const v = window.__t.vis(); return v.querySelectorAll('tr[data-player]').length === 10 && ![...v.querySelectorAll('th')].some((t) => t.textContent === 'Ranked (Arenyze)'); })()`, 8000);
    await sleep(500);
    mainCheck('Arenyze live: automaattihaku pois -> ei verkkokutsuja', nCalls() === oBefore, `kutsuja ${nCalls() - oBefore}`);
    await ev(`window.api.setSettings({ arenyzeAuto: true })`);
    hooks.gepReset('r6');
  }

  // ---------- E. Pelaajan tarkistus: Hae Arenyzestä ----------
  await check('Arenyze: Pelaajan tarkistus täyttää kentät kausitilastoista ja arvioi (Mahdollinen hakkeri, Arenyze-huomautus, 4 perustetta)', `(async () => {
    ${go('r6', 'Pelaajan tarkistus')}; const v = window.__t.vis();
    const form = v.querySelector('.r6-single form');
    window.__t.set(form.querySelector('.r6-field.wide input'), 'ArzHacker1');
    window.__t.btn('Hae Arenyzestä', form).click();
    if (!(await window.__t.until(() => v.querySelector('.r6-result .susp.suspicious'), 6000))) return false;
    const vals = [...form.querySelectorAll('.r6-fields input')].map((i) => i.value), rank = form.querySelector('.r6-fields select').value;
    const d = v.querySelector('.r6-result .susp');
    const mem = JSON.parse(localStorage.getItem('statsikka.r6check'));
    return vals.join('|') === '3.4|80|75|200|4000||20' && rank === 'Diamond' && d.open && d.querySelectorAll('.susp-reasons li').length === 4 && d.textContent.includes('Perustuu Ubisoftin kausitilastoihin (Arenyze), ei todiste huijaamisesta.') &&
      form.querySelector('.arz-check-msg').textContent.includes('Diamond III') && form.querySelector('.arz-check-msg').textContent.includes('Kentät täytetty') && mem.kd === '3.4' && mem.rank === 'Diamond';
  })()`, `(() => { const f = window.__t.vis().querySelector('.r6-single form'); return { vals: [...f.querySelectorAll('.r6-fields input')].map((i) => i.value), msg: f.querySelector('.arz-check-msg').textContent, res: window.__t.vis().querySelector('.r6-result').textContent.slice(0, 200) }; })()`);
  await check('Arenyze: täytetyillä kentillä myös normaali Tarkista toimii (sama normalisoitu data, yleinen huomautus)', `(async () => {
    const v = window.__t.vis(); const form = v.querySelector('.r6-single form');
    window.__t.btn('Tarkista', form).click();
    return await window.__t.until(() => { const d = v.querySelector('.r6-result .susp.suspicious'); return d && d.textContent.includes('Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.') && d.querySelectorAll('.susp-reasons li').length === 4; }, 5000);
  })()`);
  await check('Arenyze: Pelaajan tarkistus: puhdas pelaaja (ei epätavallisia tilastoja), tuntematon pelaaja antaa virheen, alustavalinta toimii', `(async () => {
    const v = window.__t.vis(); const form = v.querySelector('.r6-single form');
    window.__t.set(form.querySelector('.r6-field.wide input'), 'ArzPlayer2');
    window.__t.btn('Hae Arenyzestä', form).click();
    if (!(await window.__t.until(() => v.querySelector('.r6-result').textContent.includes('Ei epätavallisia tilastoja') && form.querySelector('.r6-fields input').value === '1.05', 6000))) return false;
    window.__t.set(form.querySelector('.r6-field.wide input'), 'ArzMissing1');
    window.__t.btn('Hae Arenyzestä', form).click();
    if (!(await window.__t.until(() => form.querySelector('.arz-check-msg').textContent.includes('Pelaajaa ei löytynyt Arenyzestä'), 6000))) return false;
    [...form.querySelectorAll('.r6-arz-row .seg button')].find((b) => b.textContent === 'Xbox').click();
    window.__t.set(form.querySelector('.r6-field.wide input'), 'ArzPlayer4');
    window.__t.btn('Hae Arenyzestä', form).click();
    return await window.__t.until(() => form.querySelector('.arz-check-msg').textContent.includes('Haettu Arenyzestä'), 6000);
  })()`);
  mainCheck('Arenyze: Pelaajan tarkistus haki xbl-alustalla', nCalls('/v2/fullstats', (c) => c.name === 'ArzPlayer4' && c.platform === 'xbl') === 1, JSON.stringify(stub.calls.filter((c) => c.name === 'ArzPlayer4')));
  await layoutAt('arenyze-pelaajan-tarkistus', `${go('r6', 'Pelaajan tarkistus')}; document.getElementById('view').scrollTop = 0;`);
  await ev(`(() => { const f = window.__t.vis().querySelector('.r6-single'); window.__t.btn('Tyhjennä lomake', f).click(); return true; })()`);

  // ---------- F. Oma profiili (R6) ----------
  await check('Arenyze: Oma profiili (R6) näyttää oman rankin, RP:n ja rank-historian (nimi asetuksista), tallennetun tilastojen osion rinnalla', `(async () => {
    ${go('r6', 'Oma profiili')}; const v = window.__t.vis();
    if (!(await window.__t.until(() => v.querySelector('.arz-section .arz-history .chart-svg path.ch-line'), 8000))) return false;
    const sec = v.querySelector('.arz-section');
    return sec.textContent.includes('Emerald IV') && sec.querySelectorAll('.arz-tiles .tile').length === 7 && !!v.querySelector('.account-bar') && sec.dataset.name === (await window.api.getSettings()).data.r6Name && !!v.querySelector('.r6-own');
  })()`);
  mainCheck('Arenyze: oma haku käyttää asetusten Ubisoft-nimeä', stub.calls.some((c) => c.path === '/v2/fullstats' && c.name === 'SmokeR6'), JSON.stringify(stub.calls.slice(-3)));
  await layoutAt('arenyze-oma-profiili', `${go('r6', 'Oma profiili')}; document.getElementById('view').scrollTop = 0; await window.__t.until(() => window.__t.vis().querySelector('.arz-section .arz-history .chart-svg'), 8000);`);
  await layoutAt('arenyze-asetuskortti', `${nav('settings')}; await window.__t.wait(500); document.querySelector('.arz-settings').scrollIntoView();`);

  // ---------- F2. R6 > Ottelut: RP-muutos-chip omasta rank-historiasta ----------
  // Fixturehistorian ajat (2025-10) eivät osu testiotteluihin, joten historia rakennetaan: yksi ranked-ottelu (tallenteista) + piste 10 min ennen sen loppua ja 5 min sen jälkeen.
  if (r6On) {
    const list = await ev('(async () => (await window.api.r6Matches({})).data.items.map((x) => ({ name: x.name, own: !!x.own, result: x.result, type: x.matchType, endTs: x.endTs })))()');
    const target = (list || []).find((x) => x.own && x.type === 'Ranked' && x.result !== 'live' && x.endTs > 0);
    if (!target) {
      info('Arenyze: RP-chip-tarkistus ohitettu (koneen kolmen uusimman tallenteen joukossa ei ole omaa ranked-ottelua)');
    } else {
      rpHistory = [{ ts: target.endTs - 10 * 60000, rp: 3000 }, { ts: target.endTs + 5 * 60000, rp: 3023 }];
      await ev('window.api.arenyzeClearCache()');
      const before = nCalls('/v2/profile', (c) => c.name === 'SmokeR6');
      await check('R6 > Ottelut: RP-muutos-chip (+23 RP, tooltip ennen → jälkeen) ja yhteenvedon RP yhteensä oman rank-historian perusteella', `(async () => {
        ${NORM}
        ${go('r6', 'Ottelut')}; const v = window.__t.vis();
        if (!(await window.__t.until(() => v.querySelectorAll('.match-head').length >= 1, 8000))) return false;
        if (!(await window.__t.until(() => v.querySelectorAll('.rp-chip').length === 1, 10000))) return false;
        const chip = v.querySelector('.rp-chip'), card = chip.closest('.r6-match-card');
        const sum = v.querySelector('.r6-match-summary');
        return nz(chip.textContent) === '+23 RP' && chip.classList.contains('up') && card.querySelector('.match-head').dataset.name === ${JSON.stringify(target.name)} &&
          /Arenyze/.test(chip.title) && /3\\s?000.*3\\s?023/.test(chip.title) && !!sum && nz(sum.textContent).includes('RP yhteensä') && nz(sum.textContent).includes('+23 RP');
      })()`);
      await snap('r6-ottelut-rp');
      mainCheck('Arenyze: Ottelut haki oman rank-historian (profiili) kerran ja vain omalla nimellä', nCalls('/v2/profile', (c) => c.name === 'SmokeR6') === before + 1, `kutsuja ${nCalls('/v2/profile', (c) => c.name === 'SmokeR6') - before}`);
      await ev('(async () => { await window.api.r6Matches({}); await window.api.r6Matches({ matchType: "ranked" }); return true; })()');
      mainCheck('Arenyze: Ottelut-listan uudet kutsut käyttävät välimuistia (ei uutta profiilihakua)', nCalls('/v2/profile', (c) => c.name === 'SmokeR6') === before + 1, 'uusi profiilikutsu');
      rpHistory = null;
    }
  }

  // ---------- G. Asetuskortti avaimen kanssa (kuvakaappaus), avaimen poisto ----------
  await ev(`(async () => { ${nav('settings')}; await window.__t.wait(500); const c = document.querySelector('.arz-settings'); c.scrollIntoView(); await window.__t.wait(200); return true; })()`);
  await snap('asetukset-arenyze');
  await check('Arenyze: Tyhjennä välimuisti tyhjentää tulokset (laskuri säilyy); Poista avain kysyy vahvistuksen (Peruuta säilyttää, vahvistus poistaa)', `(async () => {
    ${nav('settings')}; const c = window.__t.vis().querySelector('.arz-settings');
    const used0 = (await window.api.arenyzeStatus()).data.usage.calls;
    window.__t.btn('Tyhjennä Arenyze-välimuisti', c).click();
    if (!(await window.__t.until(() => window.__t.toast('Arenyze-välimuisti tyhjennetty'), 4000))) return false;
    const st = (await window.api.arenyzeStatus()).data;
    if (st.cacheEntries !== 0 || st.usage.calls !== used0) return false;
    window.__t.btn('Poista avain', c).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Peruuta'), 4000))) return false;
    window.__t.modalBtn('Peruuta').click(); await window.__t.wait(300);
    if (!(await window.api.arenyzeStatus()).data.configured) return false;
    window.__t.btn('Poista avain', c).click();
    if (!(await window.__t.until(() => window.__t.modalBtn('Poista'), 4000))) return false;
    window.__t.modalBtn('Poista').click();
    if (!(await window.__t.until(() => window.__t.toast('Avain poistettu'), 5000))) return false;
    await window.__t.until(() => c.querySelector('.arz-state').textContent === 'Ei avainta', 4000);
    return !(await window.api.arenyzeStatus()).data.configured && c.querySelector('input.arz-auto').disabled && window.__t.btn('Poista avain', c).disabled;
  })()`);
  mainCheck('Arenyze: arenyze-key.bin poistui avaimen poiston jälkeen', !fs.existsSync(hooks.arzKeyFile()), 'tiedosto on yhä olemassa');
  const afterClear = stub.calls.length;
  await check('Arenyze: avaimen poiston jälkeen paneeli näyttää ohjeen eikä hae mitään', `(async () => {
    R6Player.open('u:arzplayer7', 'ArzPlayer7');
    const dr = () => document.querySelector('.drawer-back:not([hidden]) .drawer');
    const ok = await window.__t.until(() => dr() && dr().querySelector('.arz-section .arz-nokey'), 6000);
    PlayerPanel.close(); return ok;
  })()`);
  mainCheck('Arenyze: avaimen poiston jälkeen ei verkkokutsuja', stub.calls.length === afterClear, `uusia kutsuja ${stub.calls.length - afterClear}`);
  if (r6On) {
    await check('R6 > Ottelut: ilman Arenyze-avainta ei RP-chipejä eikä RP-yhteenvetoa (ei virheitä, ei hakuja)', `(async () => {
      ${go('r6', 'Ottelut')}; const v = window.__t.vis();
      if (!(await window.__t.until(() => v.querySelectorAll('.match-head').length >= 1, 8000))) return false;
      await window.__t.wait(600);
      const items = (await window.api.r6Matches({})).data.items;
      return v.querySelectorAll('.rp-chip').length === 0 && !v.querySelector('.r6-match-summary').textContent.includes('RP yhteensä') && items.every((x) => x.rp === null) && !v.querySelector('.errbox');
    })()`);
    mainCheck('Arenyze: Ottelut-näkymä ei hakenut mitään ilman avainta', stub.calls.length === afterClear, `uusia kutsuja ${stub.calls.length - afterClear}`);
  }
  await ev(`window.api.setSettings({ arenyzeAuto: true, arenyzeSoftLimit: 1800 })`);
  hooks.gepReset('r6');
  hooks.arzSetFetch(() => Promise.reject(new Error('savutesti: ei verkkokutsuja Arenyzeen')));
};
