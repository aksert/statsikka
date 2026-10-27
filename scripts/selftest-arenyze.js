'use strict';
// Arenyze (R6-tilastot) -testit: ajetaan scripts/selftest.js:stä (register(ctx)). Ei verkkoa: fetch on feikki, fixturet ovat test/arenyze/ (rakennettu
// r6.arenyze.com/api-docs -sivun esimerkkivastauksista), safeStorage on feikki ja kello sekä sleep ovat hallittuja.
const fixtureDir = require('path').join(__dirname, '..', 'test', 'arenyze');

module.exports = function register({ test, assert, fs, os, path, ApiError, createSettings, sanitize, validate, S }) {
  const ARZ = require('../src/main/providers/arenyze');
  const arzFx = (n) => JSON.parse(fs.readFileSync(path.join(fixtureDir, n), 'utf8'));
  const FAKE_KEY = 'arz-test-key-0123456789';
  // Feikki safeStorage: ei oikeaa salausta, mutta selkotekstiä ei voi lukea suoraan tiedostosta.
  const fakeSafe = (on = true) => ({
    isEncryptionAvailable: () => on,
    encryptString: (s) => Buffer.from(`ENC1:${Buffer.from(s, 'utf8').toString('base64').split('').reverse().join('')}`),
    decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith('ENC1:')) throw new Error('bad'); return Buffer.from(t.slice(5).split('').reverse().join(''), 'base64').toString('utf8'); },
  });
  const arzTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-arz-'));
  // Feikki fetch: router(url, init) -> { status, body, headers } | Error. Kirjaa kutsut.
  function arzFetch(router) {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url: String(url), headers: (init && init.headers) || {} });
      const r = await router(String(url), init, calls.length);
      if (r instanceof Error) throw r;
      const status = r.status || 200, hdr = r.headers || {};
      return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (hdr[String(k).toLowerCase()] !== undefined ? hdr[String(k).toLowerCase()] : null) }, json: async () => r.body };
    };
    f.calls = calls;
    return f;
  }
  const arzRoute = (url) => {
    if (url.includes('/v2/fullstats')) return { body: arzFx('fullstats.json') };
    if (url.includes('/v2/profile')) return { body: arzFx('profile.json') };
    if (url.includes('/v2/operators')) return { body: arzFx('operators.json') };
    if (url.includes('/me/usage')) return { body: arzFx('usage.json') };
    return { status: 404, body: {} };
  };
  // Luo asiakkaan avain tallennettuna, hallittu kello ja sleep. opts: { settings, route, now0, key }
  function arzMake(opts = {}) {
    const dir = opts.dir || arzTmp();
    const clock = { t: opts.now0 || Date.UTC(2026, 9, 15, 12, 0, 0) };
    const sleeps = [];
    const fetchImpl = arzFetch(opts.route || arzRoute);
    const settings = { arenyzeAuto: true, arenyzeSoftLimit: 1800, suspicionSensitivity: 'normal', ...(opts.settings || {}) };
    let updates = 0;
    const a = ARZ.createArenyze({ dir, safeStorage: fakeSafe(), fetchImpl, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, getSettings: () => settings, onUpdate: () => { updates++; }, saveDelayMs: 5 });
    if (opts.key !== false) a.keys.save(FAKE_KEY);
    return { a, dir, clock, sleeps, fetchImpl, settings, updates: () => updates, reopen: () => ARZ.createArenyze({ dir, safeStorage: fakeSafe(), fetchImpl, now: () => clock.t, sleep: async () => {}, getSettings: () => settings }) };
  }
  const HOUR_MS = 3600 * 1000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('Arenyze: fullstats-fixture normalisoituu (rank, RP, K/D, V-H, HS-%, taso, operaattorit, kaudet)', () => {
    const s = ARZ.normalizeFullStats(arzFx('fullstats.json'), { name: 'PlayerName', platform: 'uplay' });
    assert.strictEqual(s.hasData, true);
    assert.strictEqual(s.name, 'PlayerName'); assert.strictEqual(s.platform, 'uplay');
    assert.strictEqual(s.rank, 18); assert.strictEqual(s.rankPoints, 3300); assert.strictEqual(s.rankName, 'Platinum II'); assert.strictEqual(s.rankTier, 'Platinum');
    assert.strictEqual(s.maxRankPoints, 3450); assert.strictEqual(s.maxRankName, 'Platinum I');
    assert.strictEqual(s.kills, 1240); assert.strictEqual(s.deaths, 1180); assert.strictEqual(s.kd, 1.05);
    assert.strictEqual(s.wins, 64); assert.strictEqual(s.losses, 51); assert.strictEqual(s.abandons, 2); assert.strictEqual(s.matches, 117); assert.strictEqual(s.winrate, 55.7);
    assert.strictEqual(s.hsPercent, 44.2); // (11 + 66 + 41) / (19 + 150 + 98)
    assert.strictEqual(s.level, 312); assert.strictEqual(s.hoursPlayed, 124); assert.strictEqual(s.seasonCode, 'Y10S4'); assert.strictEqual(s.seasonNumber, 40);
    assert.deepStrictEqual(s.operators.map((o) => o.name), ['Ash', 'Jager', 'Twitch']); // kierrosten mukaan
    assert.strictEqual(s.operators[2].hsPercent, 57.89);
    assert.deepStrictEqual(s.seasons.map((x) => [x.code, x.rankPoints, x.kd, x.matches]), [['Y10S3', 3150, 1.01, 98], ['Y10S4', 3300, 1.05, 117]]);
    // pelkkä sisempi fullStats-olio ilman käärettä normalisoituu samoin
    assert.strictEqual(ARZ.normalizeFullStats(arzFx('fullstats.json').fullStats, { name: 'PlayerName' }).rankPoints, 3300);
  });
  test('Arenyze: profiili-fixture normalisoituu (taso, porttikielto, rank-pisteiden historia nousevassa järjestyksessä, kaudet)', () => {
    const p = ARZ.normalizeProfile(arzFx('profile.json'), { name: 'PlayerName', platform: 'uplay' });
    assert.strictEqual(p.level, 312); assert.deepStrictEqual(p.banned, { isBanned: false, alerts: 0 });
    assert.strictEqual(p.rankName, 'Platinum II'); assert.strictEqual(p.rankPoints, 3300);
    assert.deepStrictEqual(p.history.map((x) => x.rp), [3180, 3245, 3310, 3300]);
    assert.ok(p.history.every((x, i, a) => i === 0 || x.ts > a[i - 1].ts));
    assert.strictEqual(p.history[0].rank, 'PLATINUM III'); assert.strictEqual(p.seasons.length, 1);
    // historian vanha nimi ei yliaja nykyistä lautaa, jos RP ei täsmää
    const raw = arzFx('profile.json'); raw.stats.platform_families_full_profiles[0].board_ids_full_profiles[0].full_profiles[0].profile.rank_points = 4600;
    assert.strictEqual(ARZ.normalizeProfile(raw).rankName, 'Champion');
  });
  test('Arenyze: operaattori- ja käyttö-fixturet normalisoituvat', () => {
    const o = ARZ.normalizeOperators(arzFx('operators.json'));
    assert.strictEqual(o.seasonCode, 'Y11S3'); assert.deepStrictEqual(o.operators.map((x) => [x.name, x.rounds, x.kd]), [['Mute', 90, 0.9], ['Twitch', 47, 1.08]]);
    assert.deepStrictEqual(ARZ.normalizeOperators([{ operator: 'Ash', roundsPlayed: 5 }]).operators.map((x) => x.name), ['Ash']);
    const u = ARZ.normalizeUsage(arzFx('usage.json'));
    assert.strictEqual(u.plan, 'free'); assert.strictEqual(u.limit, 2000); assert.strictEqual(u.totalCalls, 12345); assert.strictEqual(u.statsCalls, 3200);
  });
  test('Arenyze: normalisointi ei koskaan heitä (puuttuvat / rikkinäiset kentät -> null)', () => {
    const junk = [null, undefined, 5, 'x', [], {}, { fullStats: null }, { fullStats: { data: 5, operators: 'x', platform_families_full_profiles: 'x' } },
      { stats: { platform_families_full_profiles: [null, 5, { board_ids_full_profiles: [null, { full_profiles: [null] }] }] } },
      { fullStats: { platform_families_full_profiles: [{ board_ids_full_profiles: [{ board_id: 'ranked', full_profiles: [{ season_id: 'x', profile: { rank_points: 'ei' } }] }] }], data: { segments: [null, { stats: 5 }, { type: 'season', stats: { kdRatio: 'x' } }] } } }];
    for (const j of junk) {
      const s = ARZ.normalizeFullStats(j), p = ARZ.normalizeProfile(j), o = ARZ.normalizeOperators(j), u = ARZ.normalizeUsage(j);
      assert.strictEqual(typeof s.hasData, 'boolean'); assert.ok(Array.isArray(s.operators) && Array.isArray(s.seasons)); assert.ok(Array.isArray(p.history)); assert.ok(Array.isArray(o.operators)); assert.strictEqual(u.limit, null);
    }
    const e = ARZ.normalizeFullStats({});
    assert.strictEqual(e.hasData, false); assert.strictEqual(e.kd, null); assert.strictEqual(e.rankName, null); assert.strictEqual(e.hsPercent, null); assert.strictEqual(e.level, null);
    // vain kausirivi (ei lautaa): rank-pisteet ja K/D segmentistä
    const seg = ARZ.normalizeFullStats({ fullStats: { data: { segments: [{ type: 'season', attributes: { season: 43, sessionType: 'ranked' }, metadata: { shortName: 'Y11S3' }, stats: { matchesPlayed: { value: 40 }, kills: { value: 400 }, kdRatio: { value: 1.25 }, rankPoints: { value: 2750 } } }] } } });
    assert.strictEqual(seg.hasData, true); assert.strictEqual(seg.rankName, 'Gold III'); assert.strictEqual(seg.kd, 1.25); assert.strictEqual(seg.matches, 40); assert.strictEqual(seg.deaths, 320);
  });
  test('Arenyze: rank-nimi pisteistä (Rank 2.0: 100 RP / divisioona) ja nimen jäsennys', () => {
    const r = (p) => ARZ.rankFromPoints(p);
    assert.strictEqual(r(3300).name, 'Platinum II'); assert.strictEqual(r(1000).name, 'Copper V'); assert.strictEqual(r(1099).name, 'Copper V'); assert.strictEqual(r(1100).name, 'Copper IV');
    assert.strictEqual(r(1499).name, 'Copper I'); assert.strictEqual(r(1500).name, 'Bronze V'); assert.strictEqual(r(4499).name, 'Diamond I'); assert.strictEqual(r(4500).name, 'Champion'); assert.strictEqual(r(7000).name, 'Champion');
    assert.strictEqual(r(null), null); assert.strictEqual(r(0), null); assert.strictEqual(r('x'), null);
    assert.deepStrictEqual(ARZ.parseRankName('PLATINUM II'), { tier: 'Platinum', division: 'II', name: 'Platinum II' });
    assert.strictEqual(ARZ.parseRankName('Champions').name, 'Champion'); assert.strictEqual(ARZ.parseRankName('gold 3').name, 'Gold III'); assert.strictEqual(ARZ.parseRankName('Unranked'), null); assert.strictEqual(ARZ.parseRankName(5), null);
  });
  test('Arenyze: IPC-validointi (haku, avain, tuntemattomat kentät, nimi)', () => {
    const ok = ARZ.validateLookupArg({ name: ' Player.Name-1 ', platform: 'xbl', kind: 'profile', mode: 'refresh' });
    assert.deepStrictEqual(ok, { name: 'Player.Name-1', platform: 'xbl', kind: 'profile', mode: 'refresh' });
    assert.deepStrictEqual(ARZ.validateLookupArg({ name: 'Åke Ä' }), { name: 'Åke Ä', platform: 'uplay', kind: 'summary', mode: 'view' });
    for (const bad of [null, 5, [], {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(41) }, { name: 'a\nb' }, { name: 5 }, { name: 'a', platform: 'steam' }, { name: 'a', kind: 'x' }, { name: 'a', mode: 'auto' }, { name: 'a', evil: 1 }]) {
      assert.throws(() => ARZ.validateLookupArg(bad), (e) => e instanceof ApiError && e.code === 'BAD_INPUT', JSON.stringify(bad));
    }
    assert.strictEqual(ARZ.validateKeyArg(undefined), null); assert.strictEqual(ARZ.validateKeyArg({ key: ` ${FAKE_KEY} ` }), FAKE_KEY);
    for (const bad of [5, [], {}, { key: '' }, { key: 'short' }, { key: 'has space in key' }, { key: 'abc\r\ndef-12345' }, { key: FAKE_KEY, evil: 1 }, { key: 'x'.repeat(300) }]) {
      assert.throws(() => ARZ.validateKeyArg(bad), (e) => e.code === 'BAD_INPUT', JSON.stringify(bad));
    }
  });
  test('Arenyze: asetukset arenyzeAuto / arenyzeSoftLimit (oletukset, sanitize, validate)', () => {
    const d = createSettings(arzTmp()).get();
    assert.strictEqual(d.arenyzeAuto, true); assert.strictEqual(d.arenyzeSoftLimit, 1800);
    assert.deepStrictEqual(sanitize({ arenyzeAuto: false, arenyzeSoftLimit: 500 }), { arenyzeAuto: false, arenyzeSoftLimit: 500 });
    assert.deepStrictEqual(sanitize({ arenyzeAuto: 'x', arenyzeSoftLimit: -1 }), {}); assert.deepStrictEqual(sanitize({ arenyzeSoftLimit: 1.5 }), {}); assert.deepStrictEqual(sanitize({ arenyzeSoftLimit: '5' }), {});
    assert.strictEqual(validate({ arenyzeAuto: true, arenyzeSoftLimit: 0 }), null);
    for (const bad of [{ arenyzeAuto: 'kyllä' }, { arenyzeSoftLimit: -1 }, { arenyzeSoftLimit: 1.5 }, { arenyzeSoftLimit: '100' }, { arenyzeSoftLimit: 1000001 }, { arenyzeSoftLimit: NaN }]) assert.ok(validate(bad), JSON.stringify(bad));
    assert.ok(validate({ arenyzeKey: 'x' })); // avain ei kulje asetusten kautta
  });
  test('Arenyze: avainvarasto (salattu levylle, ei selkotekstiä; ei tallenna ilman salausta; poisto; virheellinen tiedosto -> null)', () => {
    const dir = arzTmp();
    const ks = ARZ.createKeyStore({ dir, safeStorage: fakeSafe() });
    assert.strictEqual(ks.has(), false); assert.strictEqual(ks.load(), null);
    assert.strictEqual(ks.save(FAKE_KEY), true); assert.strictEqual(ks.has(), true);
    const raw = fs.readFileSync(ks.file);
    assert.ok(!raw.toString('latin1').includes(FAKE_KEY) && !raw.toString('utf8').includes(FAKE_KEY) && !raw.toString('latin1').includes(Buffer.from(FAKE_KEY).toString('base64')));
    assert.strictEqual(path.basename(ks.file), 'arenyze-key.bin');
    assert.strictEqual(ks.load(), FAKE_KEY);
    assert.strictEqual(ARZ.createKeyStore({ dir, safeStorage: fakeSafe(false) }).load(), null); // salaus pois -> ei lueta
    assert.throws(() => ARZ.createKeyStore({ dir: arzTmp(), safeStorage: fakeSafe(false) }).save(FAKE_KEY), /Salausta ei ole saatavilla/);
    assert.throws(() => ks.save('lyhyt'), (e) => e.code === 'BAD_INPUT');
    fs.writeFileSync(ks.file, 'roskaa'); assert.strictEqual(ks.load(), null);
    assert.strictEqual(ks.clear(), true); assert.strictEqual(ks.has(), false); assert.strictEqual(ks.clear(), true);
    assert.strictEqual(ARZ.createKeyStore({ dir, safeStorage: null }).available(), false);
  });
  test('Arenyze: haku käyttää oikeaa osoitetta, api-key-otsaketta ja parametreja (nimi koodataan, V2-reitit)', async () => {
    const m = arzMake();
    await m.a.lookup('summary', 'Åke Ä&x=1', 'psn', { origin: 'user' });
    await m.a.lookup('profile', 'PlayerName', 'uplay', { origin: 'user' });
    await m.a.lookup('operators', 'PlayerName', 'xbl', { origin: 'user' });
    const [c1, c2, c3] = m.fetchImpl.calls;
    assert.ok(c1.url.startsWith('https://public-api.arenyze.com/r6/api/v2/fullstats?'), c1.url);
    const q1 = new URL(c1.url).searchParams;
    assert.strictEqual(q1.get('nameOnPlatform'), 'Åke Ä&x=1'); assert.strictEqual(q1.get('platformType'), 'psn'); assert.strictEqual(q1.get('modes'), 'ranked'); assert.ok(!c1.url.includes('&x=1'));
    assert.ok(c2.url.startsWith('https://public-api.arenyze.com/r6/api/v2/profile?')); assert.ok(c3.url.startsWith('https://public-api.arenyze.com/r6/api/v2/operators?')); assert.strictEqual(new URL(c3.url).searchParams.get('platformType'), 'xbl');
    for (const c of m.fetchImpl.calls) { assert.strictEqual(c.headers['api-key'], FAKE_KEY); assert.strictEqual(c.headers.Accept, 'application/json'); }
    assert.ok(!JSON.stringify(m.a.status()).includes(FAKE_KEY)); // avain ei vuoda tilaan
  });
  test('Arenyze: välimuisti-TTL (tuore ei hae, 6 h jälkeen hakee, operaattorit 24 h) ja vanhentunut data näkyy iällä, jos päivitys epäonnistuu', async () => {
    let fail = false;
    const m = arzMake({ route: (url) => (fail ? new Error('verkko poikki') : arzRoute(url)) });
    const r1 = await m.a.lookup('summary', 'Pelaaja', 'uplay');
    assert.strictEqual(r1.cached, false); assert.strictEqual(r1.stale, false); assert.strictEqual(m.fetchImpl.calls.length, 1);
    m.clock.t += 5 * HOUR_MS;
    const r2 = await m.a.lookup('summary', 'pelaaja', 'uplay'); // nimi ei ole kirjainkokoriippuvainen
    assert.strictEqual(r2.cached, true); assert.strictEqual(r2.ageMs, 5 * HOUR_MS); assert.strictEqual(m.fetchImpl.calls.length, 1);
    await m.a.lookup('operators', 'Pelaaja', 'uplay'); assert.strictEqual(m.fetchImpl.calls.length, 2);
    m.clock.t += 2 * HOUR_MS; // 7 h: yhteenveto vanhentunut, operaattorit (7 h < 24 h) tuoreet
    const ops = await m.a.lookup('operators', 'Pelaaja', 'uplay'); assert.strictEqual(ops.cached, true); assert.strictEqual(m.fetchImpl.calls.length, 2);
    fail = true;
    const r3 = await m.a.lookup('summary', 'Pelaaja', 'uplay'); // päivitys epäonnistuu -> vanha tulos + virhe + ikä
    assert.strictEqual(r3.cached, true); assert.strictEqual(r3.stale, true); assert.strictEqual(r3.ageMs, 7 * HOUR_MS); assert.strictEqual(r3.error.code, 'NETWORK'); assert.strictEqual(r3.data.rankPoints, 3300);
    fail = false; m.a._failures.clear();
    const r4 = await m.a.lookup('summary', 'Pelaaja', 'uplay'); assert.strictEqual(r4.cached, false); assert.strictEqual(r4.error, null); assert.strictEqual(r4.ageMs, 0);
    m.clock.t += 25 * HOUR_MS;
    assert.strictEqual((await m.a.lookup('operators', 'Pelaaja', 'uplay')).cached, false); // 24 h ylittyi
    // ilman vanhaa tulosta virhe heitetään
    fail = true; await assert.rejects(m.a.lookup('summary', 'Toinen', 'uplay'), (e) => e.code === 'NETWORK');
  });
  test('Arenyze: välimuisti säilyy levyllä uudelleenkäynnistyksen yli; Päivitä (force) ohittaa TTL:n, mutta ei alle 30 s vanhaa', async () => {
    const m = arzMake();
    await m.a.lookup('summary', 'Pelaaja', 'uplay'); m.a.flush();
    const b = m.reopen();
    const r = await b.lookup('summary', 'Pelaaja', 'uplay');
    assert.strictEqual(r.cached, true); assert.strictEqual(m.fetchImpl.calls.length, 1); assert.strictEqual(b.usage().calls, 1);
    const quick = await m.a.lookup('summary', 'Pelaaja', 'uplay', { origin: 'user', force: true }); // < 30 s
    assert.strictEqual(quick.cached, true); assert.strictEqual(m.fetchImpl.calls.length, 1);
    m.clock.t += 60 * 1000;
    const forced = await m.a.lookup('summary', 'Pelaaja', 'uplay', { origin: 'user', force: true });
    assert.strictEqual(forced.cached, false); assert.strictEqual(m.fetchImpl.calls.length, 2);
    // tuntematon välimuistiversio hylätään, laskuri säilyy
    m.a.flush();
    fs.writeFileSync(m.a._store.file, JSON.stringify({ version: 999, entries: { x: { at: 1, kind: 'summary', data: {} } }, usage: { month: '2026-10', calls: 7 } }));
    const c = m.reopen(); assert.strictEqual(c._store.size(), 0); assert.strictEqual(c.usage().calls, 7);
  });
  test('Arenyze: kuukausilaskuri (jokainen HTTP-yritys, tallentuu, nollautuu kalenterikuukauden vaihtuessa)', async () => {
    const m = arzMake();
    assert.strictEqual(m.a.usage().month, '2026-10'); assert.strictEqual(m.a.usage().calls, 0);
    await m.a.lookup('summary', 'A', 'uplay'); await m.a.lookup('profile', 'A', 'uplay'); await m.a.lookup('summary', 'A', 'uplay');
    assert.strictEqual(m.a.usage().calls, 2); m.a.flush();
    assert.strictEqual(m.reopen().usage().calls, 2); assert.strictEqual(m.reopen().usage().month, '2026-10');
    m.clock.t = Date.UTC(2026, 10, 1, 0, 0, 1); // marraskuu
    assert.deepStrictEqual([m.a.usage().month, m.a.usage().calls], ['2026-11', 0]);
    await m.a.lookup('summary', 'B', 'uplay'); assert.strictEqual(m.a.usage().calls, 1);
  });
  test('Arenyze: pehmeä raja pysäyttää automaattihaut (view/auto), käsin haku (user) toimii yhä; palvelimen lukema huomioidaan', async () => {
    const m = arzMake({ settings: { arenyzeSoftLimit: 2 } });
    await m.a.lookup('summary', 'A', 'uplay', { origin: 'auto' }); await m.a.lookup('summary', 'B', 'uplay', { origin: 'auto' });
    assert.strictEqual(m.a.usage().remaining, 0);
    await assert.rejects(m.a.lookup('summary', 'C', 'uplay', { origin: 'auto' }), (e) => e.code === 'BUDGET' && e.message.includes('pehmeä raja'));
    await assert.rejects(m.a.lookup('summary', 'C', 'uplay', { origin: 'view' }), (e) => e.code === 'BUDGET');
    assert.strictEqual(m.fetchImpl.calls.length, 2);
    const manual = await m.a.lookup('summary', 'C', 'uplay', { origin: 'user' }); assert.strictEqual(manual.cached, false); assert.strictEqual(m.fetchImpl.calls.length, 3);
    // rajan jälkeen välimuistissa oleva vanhentunut tulos näytetään huomautuksella
    m.clock.t += 7 * HOUR_MS;
    const st = await m.a.lookup('summary', 'A', 'uplay', { origin: 'auto' }); assert.strictEqual(st.cached, true); assert.strictEqual(st.stale, true); assert.ok(st.note.includes('pehmeä raja'));
    assert.strictEqual(m.fetchImpl.calls.length, 3);
    // palvelin kertoo suuremman käytön (muu sovellus käyttää samaa avainta): raja täyttyy aiemmin
    const m2 = arzMake({ settings: { arenyzeSoftLimit: 1800 } });
    const st2 = await m2.a.testKey(); // /me/usage: total_calls 12345 -> yli pehmeän rajan
    assert.strictEqual(st2.usage.used, 12345); assert.strictEqual(st2.usage.remaining, 0); assert.strictEqual(st2.server.limit, 2000); assert.strictEqual(m2.a.usage().calls, 1);
    await assert.rejects(m2.a.lookup('summary', 'X', 'uplay', { origin: 'auto' }), (e) => e.code === 'BUDGET');
    // raja 0 = ei automaattisia hakuja lainkaan
    const m3 = arzMake({ settings: { arenyzeSoftLimit: 0 } });
    await assert.rejects(m3.a.lookup('summary', 'X', 'uplay', { origin: 'auto' }), (e) => e.code === 'BUDGET');
  });
  test('Arenyze: automaattihaku pois päältä (arenyzeAuto = false) estää auto-haut; ilman avainta NO_KEY eikä verkkokutsuja', async () => {
    const m = arzMake({ settings: { arenyzeAuto: false } });
    await assert.rejects(m.a.lookup('summary', 'A', 'uplay', { origin: 'auto' }), (e) => e.code === 'AUTO_OFF');
    assert.strictEqual(m.a.ensureRoster([{ name: 'A' }]).lookups.length, 0); assert.strictEqual(m.fetchImpl.calls.length, 0);
    assert.strictEqual((await m.a.lookup('summary', 'A', 'uplay', { origin: 'view' })).cached, false); // paneeli toimii silti
    const n = arzMake({ key: false });
    assert.strictEqual(n.a.configured(), false); assert.strictEqual(n.a.status().configured, false);
    await assert.rejects(n.a.lookup('summary', 'A', 'uplay'), (e) => e.code === 'NO_KEY');
    await assert.rejects(n.a.lookup('summary', 'A', 'uplay', { origin: 'user' }), (e) => e.code === 'NO_KEY');
    assert.strictEqual(n.a.ensureRoster([{ name: 'A' }]).lookups.length, 0);
    assert.strictEqual(n.a.decorate([{ name: 'A' }], (p) => p.name, () => false)[0].arz, undefined); // ei arz-kenttää -> UI ei näytä saraketta
    assert.strictEqual(n.fetchImpl.calls.length, 0);
  });
  test('Arenyze: samanaikaiset haut samasta pelaajasta yhdistetään (yksi HTTP-kutsu), rinnakkaisuus enintään 2', async () => {
    let active = 0, maxActive = 0;
    const m = arzMake({ route: async (url) => { active++; maxActive = Math.max(maxActive, active); await wait(15); active--; return arzRoute(url); } });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => m.a.lookup('summary', 'Sama', 'uplay')));
    assert.strictEqual(m.fetchImpl.calls.length, 1); assert.ok(rs.every((r) => r.data.rankPoints === 3300)); assert.strictEqual(m.a.usage().calls, 1);
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => m.a.lookup('summary', n, 'uplay')));
    assert.strictEqual(m.fetchImpl.calls.length, 7); assert.ok(maxActive <= 2, `rinnakkaisuus ${maxActive}`);
  });
  test('Arenyze: 429 + Retry-After -> odotetaan ja yritetään kerran uudelleen (molemmat yritykset lasketaan); pitkä odotus -> RATE_LIMIT ja automaattihaut tauolle', async () => {
    let n = 0;
    const m = arzMake({ route: (url) => (++n === 1 ? { status: 429, headers: { 'retry-after': '3' }, body: {} } : arzRoute(url)) });
    const r = await m.a.lookup('summary', 'A', 'uplay');
    assert.deepStrictEqual(m.sleeps, [3000]); assert.strictEqual(m.fetchImpl.calls.length, 2); assert.strictEqual(r.data.rankPoints, 3300); assert.strictEqual(m.a.usage().calls, 2);
    const m2 = arzMake({ route: () => ({ status: 429, headers: { 'retry-after': '120' }, body: {} }) });
    await assert.rejects(m2.a.lookup('summary', 'A', 'uplay', { origin: 'user' }), (e) => e.code === 'RATE_LIMIT' && e.retryAfter === 120);
    assert.strictEqual(m2.sleeps.length, 0); assert.strictEqual(m2.fetchImpl.calls.length, 1);
    assert.ok(m2.a.status().rateLimitedUntil > m2.clock.t);
    await assert.rejects(m2.a.lookup('summary', 'B', 'uplay', { origin: 'auto' }), (e) => e.code === 'RATE_LIMIT' && e.message.includes('Yritä uudelleen'));
    assert.strictEqual(m2.fetchImpl.calls.length, 1); // automaattihaku ei yritä rajoituksen aikana
    const m3 = arzMake({ route: () => ({ status: 429, headers: { 'retry-after': '2' }, body: {} }) }); // kaksi 429:ää peräkkäin
    await assert.rejects(m3.a.lookup('summary', 'A', 'uplay'), (e) => e.code === 'RATE_LIMIT'); assert.strictEqual(m3.fetchImpl.calls.length, 2);
  });
  test('Arenyze: virhetilat (401/403 -> AUTH, 404 -> NOT_FOUND, 500, {error}) ja epäonnistuneen automaattihaun muisti', async () => {
    const m = arzMake({ route: (url) => (url.includes('Puuttuu') ? { status: 404, body: {} } : url.includes('Rikki') ? { status: 500, body: {} } : url.includes('Virhe') ? { body: { error: 'Player not found' } } : url.includes('Kielletty') ? { status: 403, body: {} } : arzRoute(url)) });
    await assert.rejects(m.a.lookup('summary', 'Puuttuu', 'uplay', { origin: 'user' }), (e) => e.code === 'NOT_FOUND' && e.message.includes('Arenyzestä'));
    await assert.rejects(m.a.lookup('summary', 'Rikki', 'uplay', { origin: 'user' }), (e) => e.code === 'HTTP_ERROR' && e.status === 500);
    await assert.rejects(m.a.lookup('summary', 'Virhe', 'uplay', { origin: 'user' }), (e) => e.code === 'HTTP_ERROR' && e.message.includes('Player not found'));
    await assert.rejects(m.a.lookup('summary', 'Kielletty', 'uplay', { origin: 'user' }), (e) => e.code === 'AUTH');
    const calls = m.fetchImpl.calls.length;
    await assert.rejects(m.a.lookup('summary', 'Puuttuu', 'uplay', { origin: 'auto' }), (e) => e.code === 'NOT_FOUND'); // muistettu -> ei uutta kutsua
    assert.strictEqual(m.fetchImpl.calls.length, calls);
    assert.strictEqual(m.a.peek('Puuttuu').state, 'error'); assert.strictEqual(m.a.peek('Puuttuu').code, 'NOT_FOUND');
    await assert.rejects(m.a.lookup('summary', 'Puuttuu', 'uplay', { origin: 'user' }), (e) => e.code === 'NOT_FOUND'); // käyttäjän painike yrittää aina
    assert.strictEqual(m.fetchImpl.calls.length, calls + 1);
    m.clock.t += 31 * 60 * 1000; // NOT_FOUND-muisti vanhenee 30 min
    await assert.rejects(m.a.lookup('summary', 'Puuttuu', 'uplay', { origin: 'view' }), (e) => e.code === 'NOT_FOUND'); assert.strictEqual(m.fetchImpl.calls.length, calls + 2);
  });
  test('Arenyze: testKey (ehdokasavain tallentuu vasta onnistuneen /me/usage-testin jälkeen), clearKey, ei salausta -> ei tallenneta', async () => {
    const dir = arzTmp();
    const fetchImpl = arzFetch((url, init) => (init.headers['api-key'] === FAKE_KEY ? arzRoute(url) : { status: 401, body: { error: 'Invalid api-key' } }));
    const mk = (safe) => ARZ.createArenyze({ dir, safeStorage: safe, fetchImpl, now: Date.now, getSettings: () => ({}), saveDelayMs: 5 });
    const a = mk(fakeSafe());
    await assert.rejects(a.testKey('wrong-key-1234567'), (e) => e.code === 'AUTH');
    assert.strictEqual(a.configured(), false); assert.strictEqual(a.keys.has(), false); assert.strictEqual(a.status().lastTest.ok, false);
    const st = await a.testKey(FAKE_KEY);
    assert.strictEqual(a.configured(), true); assert.strictEqual(a.keys.has(), true); assert.strictEqual(st.lastTest.ok, true); assert.strictEqual(st.server.plan, 'free');
    assert.strictEqual(fetchImpl.calls[fetchImpl.calls.length - 1].url, 'https://public-api.arenyze.com/r6/api/me/usage');
    assert.strictEqual((await a.testKey()).lastTest.ok, true); // tallennetun avaimen testi
    assert.strictEqual(a.clearKey(), true); assert.strictEqual(a.configured(), false); assert.strictEqual(a.keys.has(), false);
    await assert.rejects(a.testKey(), (e) => e.code === 'NO_KEY');
    const b = ARZ.createArenyze({ dir: arzTmp(), safeStorage: fakeSafe(false), fetchImpl, now: Date.now, getSettings: () => ({}) });
    await assert.rejects(b.testKey(FAKE_KEY), (e) => e.code === 'NO_STORAGE'); assert.strictEqual(b.status().storageAvailable, false);
  });
  test('Arenyze: rosterin hakulista (kaksoiskappaleet, anonyymit, tuore välimuisti, käynnissä oleva, epäonnistunut, budjetin katkaisu, oma viimeisenä)', () => {
    const roster = [{ name: 'Oma', isOwn: true }, { name: 'A' }, { name: 'a' }, { name: 'B' }, { name: 'Anon', anonymous: true }, { name: '' }, { name: 'C' }, { name: 'D' }, { name: 'E' }];
    const p1 = ARZ.planRoster(roster, { remaining: 100 });
    assert.deepStrictEqual(p1.lookups, ['A', 'B', 'C', 'D', 'E', 'Oma']); // oma viimeisenä
    assert.deepStrictEqual(p1.skipped.map((s) => s.reason).sort(), ['anon', 'anon', 'dup']);
    // oma tuoreessa välimuistissa ohitetaan; B käynnissä; C epäonnistui
    const p2 = ARZ.planRoster(roster, { remaining: 100, isFresh: (n) => n === 'Oma', isPending: (n) => n === 'B', failed: (n) => n === 'C' });
    assert.deepStrictEqual(p2.lookups, ['A', 'D', 'E']); assert.deepStrictEqual(p2.skipped.filter((s) => ['Oma', 'B', 'C'].includes(s.name)).map((s) => `${s.name}:${s.reason}`).sort(), ['B:pending', 'C:failed', 'Oma:cached']);
    // budjetti: vain 2 hakua, loput 'budget'; omaa ei haeta ennen muita
    const p3 = ARZ.planRoster(roster, { remaining: 2 });
    assert.deepStrictEqual(p3.lookups, ['A', 'B']); assert.deepStrictEqual(p3.skipped.filter((s) => s.reason === 'budget').map((s) => s.name), ['C', 'D', 'E', 'Oma']);
    assert.deepStrictEqual(ARZ.planRoster(roster, { remaining: 0 }).lookups, []);
    assert.deepStrictEqual(ARZ.planRoster(null).lookups, []); assert.deepStrictEqual(ARZ.planRoster([null, 5, {}]).lookups, []);
    assert.strictEqual(ARZ.planRoster(Array.from({ length: 40 }, (_, i) => ({ name: `P${i}` }))).lookups.length, 12); // katto
  });
  test('Arenyze: ensureRoster hakee 10 pelaajaa kerran (sama joukko ei hae uudelleen), oma tuore ohitetaan, budjetti katkaisee, decorate palauttaa tilat', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Pelaaja${i}`);
    const roster = names.map((n, i) => ({ name: n, isOwn: i === 0, isAnonymous: i === 9 }));
    const m = arzMake();
    await m.a.lookup('summary', 'Pelaaja0', 'uplay', { origin: 'user' }); // oma jo välimuistissa
    const before = m.fetchImpl.calls.length;
    const d1 = m.a.decorate(roster, (p) => p.name, (p) => p.isOwn);
    assert.strictEqual(d1[1].arz.state, 'pending'); assert.strictEqual(d1[9].arz.anonymous, true); assert.strictEqual(d1[0].arz.state, 'ok');
    await wait(200);
    assert.strictEqual(m.fetchImpl.calls.length - before, 8); // 10 - oma (tuore) - anonyymi
    const d2 = m.a.decorate(roster, (p) => p.name, (p) => p.isOwn);
    assert.ok(d2.slice(0, 9).every((p) => p.arz.state === 'ok' && p.arz.rankName === 'Platinum II' && p.arz.kd === 1.05 && p.arz.wins === 64 && p.arz.losses === 51));
    assert.strictEqual(m.fetchImpl.calls.length - before, 8); // ei uusia kutsuja samalle joukolle
    assert.ok(m.updates() >= 1);
    // fetch: false ei hae mitään
    const m2 = arzMake(); m2.a.decorate(roster, (p) => p.name, (p) => p.isOwn, { fetch: false }); await wait(30); assert.strictEqual(m2.fetchImpl.calls.length, 0);
    // budjetti: pehmeä raja 4 -> vain 4 hakua, loput 'budget'
    const m3 = arzMake({ settings: { arenyzeSoftLimit: 4 } });
    const d3 = m3.a.decorate(roster, (p) => p.name, (p) => p.isOwn);
    await wait(200);
    assert.strictEqual(m3.fetchImpl.calls.length, 4);
    const st = m3.a.decorate(roster, (p) => p.name, (p) => p.isOwn).map((p) => p.arz.state);
    assert.strictEqual(st.filter((s) => s === 'ok').length, 4); assert.ok(st.filter((s) => s === 'budget').length >= 5);
    assert.strictEqual(m3.a.usage().calls, 4); assert.ok(d3[1].arz);
  });
  test('Arenyze: epätavallisten tilastojen arvio (evaluateR6) Arenyze-datasta: kynnykset, lähde, herkkyys, liian pieni otos, lomakekentät', () => {
    const base = ARZ.normalizeFullStats(arzFx('fullstats.json'));
    const clean = ARZ.evaluate(base, 'normal');
    assert.strictEqual(clean.level, 'none'); assert.strictEqual(clean.sampleOk, true); assert.strictEqual(clean.source, 'arenyze'); // 117 ottelua, K/D 1,05, HS 44 %
    const hacker = { ...base, kd: 3.4, hsPercent: 80, winrate: 60, matches: 200, kills: 4000, level: 20, rankTier: 'Diamond' };
    const e = ARZ.evaluate(hacker, 'normal');
    assert.strictEqual(e.level, 'suspicious'); assert.strictEqual(e.source, 'arenyze'); assert.ok(e.reasons.some((r) => r.kind === 'kd') && e.reasons.some((r) => r.kind === 'headshot') && e.reasons.some((r) => r.kind === 'smurf'));
    assert.deepStrictEqual(ARZ.toR6Input(hacker), { kd: 3.4, hsPercent: 80, winrate: 60, matches: 200, kills: 4000, killsPerRound: null, level: 20, rank: 'Diamond' });
    // sama tulos kuin suoralla suspicion.evaluateR6-kutsulla (ei omaa pisteytystä)
    const direct = S.evaluateR6(ARZ.toR6Input(hacker)); assert.strictEqual(e.score, direct.score); assert.deepStrictEqual(e.reasons, direct.reasons);
    assert.strictEqual(ARZ.evaluate(hacker, 'off'), null); assert.strictEqual(ARZ.evaluate(hacker, 'strict').level, 'suspicious');
    assert.strictEqual(ARZ.evaluate({ ...hacker, matches: 10 }, 'normal').sampleOk, false); assert.strictEqual(ARZ.evaluate({ ...base, hasData: false }, 'normal'), null); assert.strictEqual(ARZ.evaluate(null), null);
    const watchIn = { ...base, kd: 2.1, hsPercent: 61, matches: 120, kills: 800 };
    assert.strictEqual(ARZ.evaluate(watchIn, 'normal').level, 'watch');
    const strictIn = { ...base, kd: 3.2, hsPercent: 61, matches: 200, kills: 3000 }; // pisteet 3: normaali = tarkkaile, tiukka = mahdollinen hakkeri
    assert.strictEqual(ARZ.evaluate(strictIn, 'normal').level, 'watch'); assert.strictEqual(ARZ.evaluate(strictIn, 'strict').level, 'suspicious');
    assert.deepStrictEqual(ARZ.toCheckForm(base), { kd: '1.05', hsPercent: '44.2', winrate: '55.7', matches: '117', kills: '1240', killsPerRound: '', level: '312', rank: 'Platinum' });
    assert.deepStrictEqual(ARZ.toCheckForm(ARZ.normalizeFullStats({})), { kd: '', hsPercent: '', winrate: '', matches: '', kills: '', killsPerRound: '', level: '', rank: '' });
    // lomake -> r6:assess-validointi hyväksyy täytetyt kentät
    assert.ok(S.validateR6Input(ARZ.toCheckForm(base)).value);
    const c = ARZ.compact(hacker, 'normal'); assert.strictEqual(c.rankName, 'Platinum II'); assert.strictEqual(c.suspicion.level, 'suspicious'); assert.ok(!('operators' in c) && !('seasons' in c));
  });
  test('Arenyze: lookup-tulos sisältää arvion (summary) ja noudattaa herkkyysasetusta; peek palauttaa tiiviin tilan', async () => {
    const m = arzMake({ settings: { suspicionSensitivity: 'off' } });
    const r = await m.a.lookup('summary', 'A', 'uplay');
    assert.strictEqual(r.suspicion, null); assert.strictEqual(r.kind, 'summary');
    m.settings.suspicionSensitivity = 'normal';
    const r2 = await m.a.lookup('summary', 'A', 'uplay'); assert.strictEqual(r2.suspicion.level, 'none'); assert.strictEqual(r2.suspicion.source, 'arenyze');
    const pk = m.a.peek('A'); assert.strictEqual(pk.state, 'ok'); assert.strictEqual(pk.rankPoints, 3300); assert.strictEqual(pk.stale, false);
    assert.strictEqual(m.a.peek('Tuntematon').state, 'none'); assert.strictEqual(m.a.peek('').state, 'none');
    const p = await m.a.lookup('profile', 'A', 'uplay'); assert.strictEqual(p.suspicion, undefined); assert.strictEqual(p.data.history.length, 4);
  });
};
