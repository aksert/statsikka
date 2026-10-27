'use strict';
// Asetukset + Rocket League Stats API -käyttöönotto.
(function () {
  const { h, fill } = U;

  function create(ctx) {
    let settings = null;
    let installs = [];       // [{ dir, valid, file, fileExists, values }]
    let selected = null;     // dir
    let snippet = '';
    let result = null;       // viimeisin enable-tulos

    const general = h('div', { class: 'card' });
    const bgCard = h('div', { class: 'card bg-settings' });
    const profiles = h('div', { class: 'card' });
    const api = h('div', { class: 'card' });
    const r6card = h('div', { class: 'card r6-settings' });
    const arzCard = h('div', { class: 'card arz-settings' });
    const owCard = h('div', { class: 'card ow-settings' });
    const maint = h('div', { class: 'card' });
    const updCard = h('div', { class: 'card upd-settings' });
    const el = h('div', { class: 'view-pane' }, h('h1', { class: 'page-title', text: 'Asetukset' }), general, bgCard, profiles, api, r6card, arzCard, owCard, updCard, maint);
    let r6status = null;
    const SENS = [['off', 'Pois'], ['normal', 'Normaali'], ['strict', 'Tiukka']];

    // ---- Yleiset
    function renderGeneral() {
      const plat = U.seg(OwProfile.PLATFORMS, settings.owPlatform, (v) => save({ owPlatform: v }));
      const mode = U.seg(OwProfile.MODES, settings.owGamemode, (v) => save({ owGamemode: v }));
      const sens = U.seg(SENS, settings.suspicionSensitivity, (v) => save({ suspicionSensitivity: v }));
      const port = h('input', { class: 'input', type: 'number', min: '1024', max: '65535', value: String(settings.rlWebPort) });
      port.addEventListener('change', () => {
        const n = Number(port.value);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) { U.toast('Portin pitää olla kokonaisluku 1024–65535.', 'err'); port.value = String(settings.rlWebPort); return; }
        save({ rlWebPort: n }).then((ok) => { if (ok) { snippet = null; loadDetect(true); } });
      });
      const autoLive = h('input', { type: 'checkbox', class: 'auto-live', checked: settings.autoLive !== false, 'aria-label': 'Siirry live-näkymään automaattisesti' });
      autoLive.addEventListener('change', () => { save({ autoLive: autoLive.checked }); });
      fill(general, h('h2', { text: 'Yleiset' }),
        h('div', { class: 'form-grid' },
          h('label', { text: 'Overwatch: oletusalusta (pelaajahaku)' }), plat,
          h('label', { text: 'Overwatch: oletuspelitila (pelaajahaku)' }), mode,
          h('label', { text: 'Epätavalliset tilastot: herkkyys' }), sens,
          h('label', { text: 'Stats API: WebSocket-portti' }), port,
          h('label', { text: 'Siirry live-näkymään automaattisesti' }), h('label', { class: 'row' }, autoLive, h('span', { class: 'sub', text: 'Kun ottelu alkaa (Rocket League heti, Rainbow Six 1. kierroksen jälkeen)' }))),
        h('p', { class: 'sub', text: 'Herkkyys: Pois piilottaa "Tarkkaile" / "Mahdollinen hakkeri" -merkin, Tiukka laskee tasorajoja yhdellä. Indikaattori koskee Overwatch 2:ta ja Rainbow Six Siegea (käsin syötetty tarkistus sekä omista ottelutallenteista lasketut Live-peli ja Pelaajat; ei Rocket Leaguea) ja perustuu tilastoihin, ei todiste huijaamisesta.' }),
        h('p', { class: 'sub', text: 'Automaattinen siirtyminen vaihtaa vain sovelluksen sisäisen näkymän: ikkunaa ei tuoda esiin eikä ilmoituksia näytetä. Se ei toimi, kun kirjoitat lomakkeeseen.' }),
        h('p', { class: 'sub', text: 'Portin muutos kirjoitetaan peliin vasta kun painat "Ota käyttöön" uudelleen.' }));
    }
    async function save(patch) {
      try {
        settings = await U.unwrap(window.api.setSettings(patch));
        ctx.onSettings(settings);
        U.toast('Tallennettu.');
        return true;
      } catch (e) { U.toast(U.errMsg(e), 'err'); return false; }
    }

    // ---- Tausta ja käynnistys: tray, automaattinen avaus pelin käynnistyessä, käynnistys Windowsin mukana
    function renderBackground() {
      const box = (cls, key, label, text) => {
        const cb = h('input', { type: 'checkbox', class: cls, checked: settings[key] === true, 'aria-label': label });
        cb.addEventListener('change', async () => {
          const want = cb.checked;
          const ok = await save({ [key]: want });
          // Windows-käynnistyksen tila luetaan käyttöjärjestelmältä: jos se ei vastaa pyyntöä, kerrotaan se.
          if (ok && key === 'startWithWindows' && settings.startWithWindows !== want) U.toast('Windows ei ottanut käynnistystä käyttöön. Tarkista Windowsin Asetukset → Sovellukset → Käynnistys.', 'err');
          renderBackground();
        });
        return h('label', { class: 'row' }, cb, h('span', { class: 'sub', text }));
      };
      fill(bgCard, h('h2', { text: 'Tausta ja käynnistys' }),
        h('div', { class: 'form-grid' },
          h('label', { text: 'Toimi taustalla' }), box('run-bg', 'runInBackground', 'Toimi taustalla', 'Ikkunan sulkeminen piilottaa Statsikan ilmaisinalueen kuvakkeeseen, ja pelien seuranta jatkuu.'),
          h('label', { text: 'Avaa pelin käynnistyessä' }), box('open-launch', 'openOnGameLaunch', 'Avaa pelin käynnistyessä', 'Kun Overwatch 2, Rocket League tai Rainbow Six Siege käynnistyy, ikkuna avataan ja siirrytään pelin Live-näkymään.'),
          h('label', { text: 'Käynnistä Windowsin mukana' }), box('start-win', 'startWithWindows', 'Käynnistä Windowsin mukana', 'Käynnistyy kirjautuessa piilotettuna ilmaisinalueelle (vaatii "Toimi taustalla" -asetuksen, muuten ikkuna avautuu normaalisti).')),
        h('p', { class: 'sub bg-note', text: 'Ikkuna avautuu pelin käynnistyessä ilman kohdistusta: se ei vie näppäimistöä pelistä eikä vilku tai näytä ilmoituksia. Näkymä vaihtuu kerran per pelin käynnistys, ei kesken kirjoittamisen eikä vahvistusikkunan tai pelaajapaneelin ollessa auki. Kokoruudun (exclusive fullscreen) peli voi peittää ikkunan, jolloin ikkunaton kokoruutu (borderless) toimii parhaiten.' }),
        h('p', { class: 'sub', text: 'Tray-kuvake on kellon vieressä (Windows voi piilottaa sen ^-nuolen taakse). Kaksoisnapsautus tai valikon "Avaa Statsikka" tuo ikkunan esiin; valikosta pääsee myös suoraan pelien Live-näkymiin. Sovelluksen saa kokonaan kiinni valikon "Lopeta" -kohdasta tai Ctrl+Q:lla. Kun Statsikka käynnistetään uudelleen (esim. Kaynnista.bat), piilossa oleva ikkuna tulee esiin.' }));
    }

    // ---- Omat profiilit (jaetut apurit: link-card.js)
    const TAG_RE = LinkCard.TAG_RE;
    const RL_PLATFORMS = LinkCard.RL_PLATFORMS;

    async function saveOw(patch) {
      const cur = settings.owProfile;
      if (patch.battletag !== undefined) {
        const t = patch.battletag.trim();
        if (t && !TAG_RE.test(t)) { U.toast('Virheellinen BattleTag. Muoto: Nimi#1234.', 'err'); renderProfiles(); return; }
        patch = { ...patch, battletag: t };
      }
      if (!(await LinkCard.confirmOwChange(cur, patch))) { renderProfiles(); return; }
      await save({ owProfile: patch });
      renderProfiles();
    }

    function renderProfiles() {
      const op = settings.owProfile;
      const tag = h('input', { class: 'input', type: 'text', maxlength: '40', value: op.battletag, placeholder: 'BattleTag, esim. TeKrop#2217', spellcheck: 'false', 'aria-label': 'Oma BattleTag' });
      tag.addEventListener('change', () => saveOw({ battletag: tag.value }));
      const plat = U.seg(OwProfile.PLATFORMS, op.platform, (v) => saveOw({ platform: v }));
      const out = h('div', { class: 'check-out' });
      const check = h('button', { class: 'btn ghost', type: 'button', onclick: () => LinkCard.checkOw(out, tag.value, plat.get()) }, 'Tarkista');

      const rlName = h('input', { class: 'input', type: 'text', maxlength: '64', value: settings.rlOwnName, placeholder: 'Pelinimesi Rocket Leaguessa', spellcheck: 'false' });
      rlName.addEventListener('change', () => save({ rlOwnName: rlName.value }));
      const rlPlat = h('select', { class: 'input' }, RL_PLATFORMS.map(([v, l]) => h('option', { value: v }, l)));
      rlPlat.value = settings.rlPlatform;
      rlPlat.addEventListener('change', () => save({ rlPlatform: rlPlat.value }));
      const r6 = h('input', { class: 'input', type: 'text', maxlength: '32', value: settings.r6Name, placeholder: 'Ubisoft-nimi', spellcheck: 'false' });
      r6.addEventListener('change', () => save({ r6Name: r6.value }));

      fill(profiles, h('h2', { text: 'Omat profiilit' }),
        h('p', { class: 'sub', text: 'Omat tiedot näkyvät "Oma profiili" -näkymässä. Tallennus tapahtuu kun poistut kentästä tai painat Enter.' }),
        h('h3', { class: 'sub-title', text: 'Overwatch 2' }),
        h('div', { class: 'form-grid' }, h('label', { text: 'BattleTag' }), h('div', { class: 'row' }, tag, check), h('label', { text: 'Alusta' }), plat),
        out,
        h('p', { class: 'sub', text: 'Tilannekuva tallennetaan automaattisesti käynnistyksessä ja 30 min välein, kun sovellus on auki. BattleTagin tai alustan vaihto nollaa kehityshistorian.' }),
        h('h3', { class: 'sub-title', text: 'Rocket League' }),
        h('div', { class: 'form-grid' }, h('label', { text: 'Oma nimi' }), rlName, h('label', { text: 'Alusta (tiedoksi)' }), rlPlat),
        h('p', { class: 'sub', text: 'Oma nimi korostaa sinut live-pistetaulukossa ja laskee voitot historiaan.' }),
        h('h3', { class: 'sub-title', text: 'Rainbow Six Siege' }),
        h('div', { class: 'form-grid' }, h('label', { text: 'Ubisoft-nimi' }), r6),
        h('p', { class: 'sub', text: 'Nimi täyttyy automaattisesti omista ottelutallenteista (Match Replay), jos kenttä on tyhjä. Sinut tunnistetaan tallenteen omistajana, joten nimen ei tarvitse täsmätä.' }));
    }

    // ---- Rainbow Six Siege: ottelutallenteet
    function renderR6() {
      const s = r6status;
      const scanBtn = h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
        try { await U.unwrap(window.api.r6Rescan()); U.toast('Skannataan ottelutallenteet uudelleen.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      } }, 'Skannaa uudelleen');
      const pickBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          const r = await U.unwrap(window.api.r6PickDir());
          if (r) U.toast('Kansio valittu.');
        } catch (e) { U.toast(U.errMsg(e), 'err'); }
      } }, 'Valitse kansio');
      const src = s && s.dirSource === 'setting' ? 'valittu käsin' : s && s.dirSource === 'env' ? 'ympäristömuuttujasta' : 'löytyi automaattisesti';
      const line = !s ? 'Ladataan…'
        : s.scanning ? `Skannataan ottelutallenteita… ${s.scanning.done} / ${s.scanning.total}`
          : `${s.matchCount} ottelua${s.lastMatchTs ? `, viimeisin ${U.dateTime(s.lastMatchTs)}` : ''}`;
      fill(r6card, h('h2', { text: 'Rainbow Six Siege: ottelutallenteet' }),
        h('p', { class: 'sub', text: 'Tilastot, live-peli ja pelaajahistoria luetaan pelin omista ottelutallenteista (Match Replay). Tiedostoihin vain luetaan; pelikansioon ei kirjoiteta.' }),
        h('div', { class: 'form-grid' },
          h('label', { text: 'Tallennekansio' }), h('span', { class: 'sub path r6-dir', text: s && s.dir ? `${s.dir} (${src})` : (s ? 'Ei löytynyt. Valitse MatchReplay-kansio.' : '–') }),
          h('label', { text: 'Tila' }), h('span', { class: 'r6-status-line', text: line }),
          h('label', { text: 'Toiminnot' }), h('div', { class: 'row' }, pickBtn, scanBtn)),
        s && s.error ? h('p', { class: 'sub warn', text: s.error }) : null,
        h('p', { class: 'sub', text: 'Ota pelissä käyttöön Match Replay (Options → General → Match Replay) jotta ottelut tallentuvat. Valikoiden nimet voivat vaihdella pelipäivitysten mukaan. Peli säilyttää vain rajallisen määrän tallenteita; Statsikka tallentaa yhteenvedot itse, joten historia kasvaa ajan mittaan myös vanhojen tallenteiden poistuessa.' }));
    }
    async function loadR6() {
      try { r6status = await U.unwrap(window.api.r6Status()); } catch (_) { r6status = null; }
      renderR6();
    }
    window.api.onR6Update((d) => { if (!el.hidden) loadR6(); else if (d && d.settingsChanged && settings) loadSettingsAgain(); });
    function loadSettingsAgain() { U.unwrap(window.api.getSettings()).then((s) => { settings = s; }).catch(() => {}); }

    // ---- R6-tilastot (Arenyze API): avain salattuna (safeStorage, arenyze-key.bin), käyttö ja pehmeä raja. Lomake rakennetaan kerran, vain tilaosa piirretään uudelleen.
    let arzStatus = null;
    const arzStatusBox = h('div', { class: 'arz-status-box' });
    const arzKey = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '256', placeholder: 'Arenyze API-avain', 'aria-label': 'Arenyze API-avain' });
    const arzLimit = h('input', { class: 'input arz-limit', type: 'number', min: '0', max: '1000000', step: '50', 'aria-label': 'Pehmeä raja (kutsua / kk)' });
    const arzAuto = h('input', { type: 'checkbox', class: 'arz-auto', 'aria-label': 'Hae live-ottelun pelaajat automaattisesti' });
    const arzTestBtn = h('button', { class: 'btn', type: 'button', onclick: () => arzTest() }, 'Testaa avain');
    const arzUsageBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => arzUsage() }, 'Päivitä käyttö');
    const arzClearBtn = h('button', { class: 'btn danger', type: 'button', onclick: () => arzClear() }, 'Poista avain');
    const arzCacheBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => arzCache() }, 'Tyhjennä Arenyze-välimuisti');
    arzAuto.addEventListener('change', () => { save({ arenyzeAuto: arzAuto.checked }).then(() => loadArz()); });
    arzLimit.addEventListener('change', async () => {
      const n = Number(arzLimit.value);
      if (arzLimit.value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 1000000) { U.toast('Pehmeän rajan pitää olla kokonaisluku 0–1 000 000.', 'err'); arzLimit.value = String(settings.arenyzeSoftLimit); return; }
      if (await save({ arenyzeSoftLimit: n })) loadArz();
    });
    const monthName = (m) => { const [y, mo] = String(m || '').split('-'); return mo ? `${Number(mo)}/${y}` : '–'; };
    function renderArz() {
      const s = arzStatus;
      if (!s) { fill(arzStatusBox, h('span', { class: 'sub', text: 'Ladataan…' })); return; }
      const u = s.usage, sv = s.server;
      const keyLine = !s.storageAvailable && !s.configured ? 'Salausta ei ole saatavilla' : s.configured ? 'Avain tallennettu salattuna' : 'Ei avainta';
      const test = s.lastTest ? `${s.lastTest.ok ? 'Testi onnistui' : 'Testi epäonnistui'}: ${s.lastTest.message}` : '';
      const server = sv && sv.totalCalls != null ? `Arenyzen mukaan ${U.num(sv.totalCalls)}${sv.limit != null ? ` / ${U.num(sv.limit)}` : ''} kutsua${sv.plan ? ` (${sv.plan})` : ''}, haettu ${ArzUi.ageText(Date.now() - sv.at)}` : 'Palvelimen lukemaa ei ole haettu (paina "Päivitä käyttö").';
      fill(arzStatusBox,
        h('div', { class: 'form-grid' },
          h('label', { text: 'Tila' }), h('div', { class: 'ow-status' }, h('span', { class: `status-dot ${s.configured ? 'connected' : ''}` }), h('strong', { class: 'arz-state', text: keyLine }), test ? h('span', { class: `sub ${s.lastTest && s.lastTest.ok ? '' : 'warn'}`, text: test }) : null),
          h('label', { text: `Käyttö (${monthName(u.month)})` }), h('span', { class: 'arz-usage', text: `${U.num(u.used)} kutsua (omat ${U.num(u.calls)})${u.inflight ? `, ${u.inflight} käynnissä` : ''}, pehmeä raja ${U.num(u.softLimit)}` }),
          h('label', { text: 'Palvelimen lukema' }), h('span', { class: 'sub arz-server', text: server }),
          h('label', { text: 'Välimuisti' }), h('span', { class: 'sub', text: `${s.cacheEntries} tallennettua hakua` })),
        s.usage.remaining <= 0 && s.configured ? h('p', { class: 'sub warn', text: 'Pehmeä raja on täynnä: automaattiset haut on pysäytetty. Pelaajapaneelin Päivitä- ja Hae Arenyzestä -napit toimivat yhä.' }) : null,
        s.rateLimitedUntil ? h('p', { class: 'sub warn', text: 'Arenyze rajoitti pyyntöjä hetkeksi; automaattiset haut jatkuvat itsestään.' }) : null,
        !s.storageAvailable && !s.configured ? h('p', { class: 'sub warn', text: 'Salausta (safeStorage) ei ole saatavilla, joten avainta ei voi tallentaa.' }) : null);
      arzTestBtn.disabled = !s.storageAvailable && !s.configured;
      arzUsageBtn.disabled = !s.configured;
      arzClearBtn.disabled = !s.configured;
      arzAuto.disabled = !s.configured;
      if (settings) { arzAuto.checked = settings.arenyzeAuto !== false; if (document.activeElement !== arzLimit) arzLimit.value = String(settings.arenyzeSoftLimit); }
    }
    async function loadArz() {
      try { arzStatus = await U.unwrap(window.api.arenyzeStatus()); } catch (_) { arzStatus = null; }
      renderArz();
    }
    async function arzTest() {
      const typed = arzKey.value.trim();
      arzTestBtn.disabled = true;
      try {
        arzStatus = await U.unwrap(window.api.arenyzeTest(typed ? { key: typed } : undefined));
        arzKey.value = ''; // avainta ei jätetä kenttään
        U.toast(typed ? 'Avain toimii ja on tallennettu.' : 'Avain toimii.');
      } catch (e) { U.toast(ArzUi.msg(e), 'err'); await loadArz(); }
      arzTestBtn.disabled = false;
      renderArz();
    }
    async function arzUsage() {
      arzUsageBtn.disabled = true;
      try { arzStatus = await U.unwrap(window.api.arenyzeUsage()); U.toast('Käyttö päivitetty.'); } catch (e) { U.toast(ArzUi.msg(e), 'err'); }
      renderArz();
    }
    async function arzClear() {
      const ok = await U.confirmDialog('Poistetaanko Arenyze-avain?', 'Tallennettu avain poistetaan tältä koneelta. Välimuistissa olevat tulokset säilyvät, mutta uusia hakuja ei tehdä ennen kuin lisäät avaimen.', 'Poista');
      if (!ok) return;
      try { arzStatus = await U.unwrap(window.api.arenyzeClearKey()); U.toast('Avain poistettu.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      renderArz();
    }
    async function arzCache() {
      try { arzStatus = await U.unwrap(window.api.arenyzeClearCache()); U.toast('Arenyze-välimuisti tyhjennetty (kuukausilaskuri säilyy).'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      renderArz();
    }
    window.api.onArenyzeUpdate(() => { if (!el.hidden) loadArz(); });
    fill(arzCard, h('h2', { text: 'R6-tilastot (Arenyze API)' }),
      h('p', { class: 'sub', text: 'Näyttää minkä tahansa Rainbow Six -pelaajan rankin, rank-pisteet, kausitilastot (K/D, voitot–häviöt, ottelut, HS-%), parhaat operaattorit ja rank-pisteiden historian, myös pelaajille joiden kanssa et ole pelannut. Tiedot tulevat Arenyzen kehittäjärajapinnasta (Ubisoftin kausitilastot). Ottelukohtaista historiaa muille pelaajille ei ole saatavilla.' }),
      arzStatusBox,
      h('h3', { class: 'sub-title', text: 'Avain ja asetukset' }),
      h('div', { class: 'form-grid' },
        h('label', { text: 'API-avain' }), h('div', { class: 'row' }, arzKey, arzTestBtn),
        h('label', { text: 'Toiminnot' }), h('div', { class: 'row' }, arzUsageBtn, arzClearBtn, arzCacheBtn),
        h('label', { text: 'Pehmeä raja (kutsua / kk)' }), h('div', { class: 'row' }, arzLimit, h('span', { class: 'sub', text: 'Tämän jälkeen automaattiset haut loppuvat; käsin haku toimii yhä. Oletus 1 800.' })),
        h('label', { text: 'Hae live-ottelun pelaajat automaattisesti' }), h('label', { class: 'row' }, arzAuto, h('span', { class: 'sub', text: 'R6 Live-peli hakee ottelun enintään 10 pelaajaa kerran per ottelu (vain kun avain on asetettu).' }))),
      h('ol', { class: 'sub' },
        h('li', null, 'Luo ilmainen tili osoitteessa ', h('a', { href: 'https://r6.arenyze.com/' }, 'r6.arenyze.com'), '.'),
        h('li', { text: 'Avaa Dashboard → API key ja kopioi avain.' }),
        h('li', { text: 'Liitä avain yllä olevaan kenttään ja paina "Testaa avain".' })),
      h('p', { class: 'sub', text: 'Ilmainen tili: 2 000 kutsua kuukaudessa ja kohtuullinen käyttö ("testaukseen ja kevyeen henkilökohtaiseen käyttöön"). Statsikka säästää kutsuja: tulokset tallennetaan levylle 6 tunniksi (operaattorit 24 h), samaa pelaajaa ei haeta kahdesti yhtä aikaa, ja kuukausilaskuri sekä pehmeä raja pysäyttävät automaattiset haut ajoissa.' }),
      h('p', { class: 'sub', text: 'Yksityisyys: avain tallennetaan vain tälle koneelle salattuna (Windows safeStorage, tiedosto arenyze-key.bin), eikä sitä lähetetä muualle kuin Arenyzelle. Pelaajien nimiä lähetetään Arenyzelle vain, kun pelaaja haetaan (live-ottelun automaattihaku, pelaajapaneeli tai Hae Arenyzestä).' }));

    // ---- Overwolf GEP (live-pelitiedot). Lomake rakennetaan kerran (kirjoitetut kentät säilyvät tilapäivityksissä), vain tilaosa piirretään uudelleen.
    const OW_STATE = { inactive: 'Ei käytössä', 'waiting-credentials': 'Odotetaan tunnuksia', ready: 'Valmis', 'game-running': 'Peli käynnissä', error: 'Virhe' };
    const OW_DOT = { ready: 'waiting', 'game-running': 'connected' };
    let owStatus = null;
    let owMode = 'dev';
    const owStatusBox = h('div', { class: 'ow-status-box' });
    const owDevKey = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '2048', placeholder: 'OW_DEV_KEY', 'aria-label': 'Overwolf-kehittäjäavain' });
    const owEmail = h('input', { class: 'input', type: 'email', autocomplete: 'off', spellcheck: 'false', maxlength: '254', placeholder: 'Console-tilin sähköposti', 'aria-label': 'Overwolf Console -sähköposti' });
    const owApiKey = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '2048', placeholder: 'OW_CLI_API_KEY', 'aria-label': 'Overwolf Console API-avain' });
    const owDevChannel = h('input', { type: 'checkbox', class: 'ow-dev-channel', checked: true, 'aria-label': 'Käytä GEP dev -kanavaa' });
    const owDevFields = h('div', { class: 'ow-fields' }, h('label', { text: 'Kehittäjäavain' }), owDevKey);
    const owConsoleFields = h('div', { class: 'ow-fields', hidden: true }, h('label', { text: 'Console-sähköposti' }), owEmail, h('label', { text: 'Console API-avain' }), owApiKey);
    const owModeSeg = U.seg([['dev', 'Kehittäjäavain (OW_DEV_KEY)'], ['console', 'Console-tunnukset']], owMode, (v) => { owMode = v; owDevFields.hidden = v !== 'dev'; owConsoleFields.hidden = v !== 'console'; });
    const owDiag = h('pre', { class: 'snippet ow-diag', text: '' });
    const owEnableBtn = h('button', { class: 'btn', type: 'button', onclick: () => owEnable() }, 'Ota käyttöön ja käynnistä uudelleen');
    const owClearBtn = h('button', { class: 'btn danger', type: 'button', onclick: () => owClear() }, 'Poista tunnukset');

    function renderOwStatus() {
      const s = owStatus;
      if (!s) { fill(owStatusBox, h('span', { class: 'sub', text: 'Ladataan…' })); return; }
      const st = s.status;
      const credText = s.stored ? `Tallennettu salattuna: ${s.storedMode === 'console' ? 'Console-tunnukset' : 'kehittäjäavain'}` : 'Ei tallennettu';
      const startup = s.startup === 'relaunch-guard' ? 'Uudelleenkäynnistys tehtiin, mutta tunnusta ei näy prosessissa. Uutta yritystä ei tehdä (silmukkasuoja).' : '';
      const envText = s.owElectron ? `ow-electron${st.version ? `, GEP-paketti ${st.version}` : ''}${s.channelArg ? ', dev-kanava päällä' : ''}` : 'Tavallinen Electron: Overwolf ei ole käytettävissä (käynnistä npm start / Kaynnista.bat).';
      fill(owStatusBox,
        h('div', { class: 'form-grid' },
          h('label', { text: 'Tila' }), h('div', { class: 'ow-status' }, h('span', { class: `status-dot ${OW_DOT[st.state] || ''}` }), h('strong', { class: 'ow-state', text: OW_STATE[st.state] || st.state }), h('span', { class: 'sub', text: st.reason || '' })),
          h('label', { text: 'Tunnukset' }), h('span', { class: 'sub ow-cred-line', text: `${credText}${s.envActive ? ' · käytössä tässä ajossa (ympäristömuuttuja)' : ''}` }),
          h('label', { text: 'Ajoympäristö' }), h('span', { class: 'sub', text: envText })),
        startup ? h('p', { class: 'sub warn', text: startup }) : null,
        st.lastError ? h('p', { class: 'sub warn', text: st.lastError }) : null,
        !s.storageAvailable ? h('p', { class: 'sub warn', text: 'Salausta (safeStorage) ei ole saatavilla, joten tunnuksia ei tallenneta. Aseta OW_DEV_KEY ympäristömuuttujaksi käsin ennen käynnistystä.' }) : null);
      owEnableBtn.disabled = !s.storageAvailable;
      owClearBtn.disabled = !s.stored && !s.envActive;
      owDevChannel.checked = s.devChannel !== false;
    }
    async function loadOw() {
      try { owStatus = await U.unwrap(window.api.overwolfStatus()); } catch (_) { owStatus = null; }
      renderOwStatus();
    }
    async function owEnable() {
      const arg = owMode === 'dev' ? { mode: 'dev', devKey: owDevKey.value, devChannel: owDevChannel.checked }
        : { mode: 'console', email: owEmail.value, apiKey: owApiKey.value, devChannel: owDevChannel.checked };
      owDevKey.value = ''; owEmail.value = ''; owApiKey.value = ''; // avaimia ei jätetä kenttiin
      owEnableBtn.disabled = true;
      try {
        const r = await U.unwrap(window.api.overwolfEnable(arg));
        U.toast(r.relaunching ? 'Tunnukset tallennettu. Käynnistetään uudelleen…' : (r.owElectron ? 'Tunnukset tallennettu.' : 'Tunnukset tallennettu. Käynnistä Statsikka ow-electronilla (npm start).'));
      } catch (e) { U.toast(U.errMsg(e), 'err'); }
      await loadOw();
    }
    async function owClear() {
      const ok = await U.confirmDialog('Poistetaanko Overwolf-tunnukset?', 'Tallennetut tunnukset poistetaan tältä koneelta. GEP pysyy käynnissä, kunnes suljet Statsikan; seuraavalla käynnistyksellä live-pelitiedot eivät ole käytössä.', 'Poista');
      if (!ok) return;
      try { await U.unwrap(window.api.overwolfClear()); U.toast('Tunnukset poistettu.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      await loadOw();
    }
    async function loadDiag() {
      try {
        const rows = await U.unwrap(window.api.gepDiag());
        owDiag.textContent = rows.length ? rows.slice(-30).map((r) => `${new Date(r.t).toLocaleTimeString('fi-FI')} ${r.game} ${r.kind} ${r.feature}/${r.category}/${r.key} = ${r.value}`).join('\n') : 'Ei vielä GEP-viestejä.';
      } catch (e) { owDiag.textContent = U.errMsg(e); }
    }
    fill(owCard, h('h2', { text: 'Overwolf (live-pelitiedot)' }),
      h('p', { class: 'sub', text: 'Overwolfin Game Events Provider (GEP) kertoo Rainbow Six Siegen ja Overwatch 2:n pelaajat, joukkueet ja live-luvut heti ottelun alussa: R6 Live-peli näyttää kaikki 10 pelaajaa ennen ensimmäistä kierrosta ja OW Live-lobby täyttyy ja haetaan itsestään. Vaatii oman kehittäjäavaimen ja ajon ow-electronilla (npm start / Kaynnista.bat). Kehitystila on tarkoitettu henkilökohtaiseen käyttöön.' }),
      owStatusBox,
      h('h3', { class: 'sub-title', text: 'Tunnukset' }),
      owModeSeg,
      h('div', { class: 'form-grid' }, owDevFields, owConsoleFields,
        h('label', { text: 'GEP dev -kanava' }), h('label', { class: 'row' }, owDevChannel, h('span', { class: 'sub', text: 'Käytä --owepm-package-channel=gep:dev (Rainbow Six on Overwolfin dev-kanavalla; poista valinta, kun peli on siirretty tuotantoon)' })),
        h('label', { text: 'Toiminnot' }), h('div', { class: 'row' }, owEnableBtn, owClearBtn)),
      h('p', { class: 'sub', text: 'Ota käyttöön tallentaa tunnukset salattuna ja käynnistää Statsikan uudelleen, koska ow-electron lukee tunnukset vasta käynnistyessään.' }),
      h('ol', { class: 'sub' },
        h('li', null, 'Luo ilmainen tili osoitteessa ', h('a', { href: 'https://dev.overwolf.com/' }, 'dev.overwolf.com'), ' ja lähetä sovellusidea. Kun Developer status on Approved, avaa Profile → Developer Key → Generate key ja liitä avain yllä.'),
        h('li', null, 'Vaihtoehto: jos Overwolf on avannut sinulle Developer Console -tilin (', h('a', { href: 'https://console.overwolf.com/' }, 'console.overwolf.com'), '), käytä Profile → API Keys -avainta ja tilin sähköpostia.')),
      h('p', { class: 'sub', text: 'Yksityisyys: tunnukset tallennetaan vain tälle koneelle salattuna (Windows safeStorage, tiedosto ow-credentials.bin), niitä ei kirjata lokiin eikä lähetetä Statsikan kautta mihinkään; ne annetaan vain ow-electronille ympäristömuuttujina. Overwolfin anonyymi analytiikka on kytketty pois eikä sovellus näytä mainoksia.' }),
      h('details', { ontoggle: (e) => { if (e.target.open) loadDiag(); } }, h('summary', { class: 'sub', text: 'Viimeisimmät GEP-viestit (diagnostiikka)' }), owDiag,
        h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: loadDiag }, 'Päivitä'))));
    window.api.onGepUpdate((s) => { if (!el.hidden && s && owStatus) { owStatus.status = s.status; renderOwStatus(); } });

    // ---- Stats API
    function valuesText(v) {
      const keys = ['PacketSendRate', 'Port', 'WebPort'];
      if (!v || !keys.some((k) => v[k] !== undefined)) return 'Ei asetettu (Stats API pois päältä)';
      return keys.map((k) => `${k}=${v[k] === undefined ? '–' : v[k]}`).join('  ');
    }

    function renderApi() {
      const cur = installs.find((i) => i.dir === selected);
      const list = installs.length
        ? h('div', { class: 'list' }, installs.map((i) => h('button', { class: `install ${i.dir === selected ? 'sel' : ''}`, type: 'button', onclick: () => { selected = i.dir; result = null; renderApi(); } },
          h('input', { type: 'radio', name: 'inst', checked: i.dir === selected, tabindex: '-1' }),
          h('div', null, h('div', { text: i.dir }), h('div', { class: 'sub', text: i.valid ? `Nykyiset arvot: ${valuesText(i.values)}` : 'Kansiosta ei löydy TAGame-kansiota' })))))
        : h('div', { class: 'sub', text: 'Ei vielä valittua asennusta. Paina "Etsi Rocket League" tai "Valitse kansio".' });

      const out = [
        h('h2', { text: 'Rocket League Stats API' }),
        h('p', { class: 'sub', text: 'Rocket Leaguen virallinen paikallinen Stats API lähettää ottelun tiedot sovellukselle. Se pitää ottaa käyttöön ini-tiedostossa ennen pelin käynnistystä.' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: detect }, 'Etsi Rocket League'),
          h('button', { class: 'btn ghost', type: 'button', onclick: pick }, 'Valitse kansio')),
        list,
      ];
      if (cur && cur.valid) {
        out.push(h('div', { class: 'sub', text: `Muokattava tiedosto: ${cur.file}${cur.fileExists ? '' : ' (luodaan)'}` }));
        out.push(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: enable }, 'Ota käyttöön')));
      } else if (cur) {
        out.push(h('div', { class: 'banner', text: 'Valittu kansio ei näytä Rocket League -asennukselta (TAGame-kansiota ei löydy).' }));
      }
      if (result && result.ok) {
        out.push(h('div', { class: 'banner', style: null },
          h('strong', { text: 'Stats API otettu käyttöön. ' }),
          `Kirjoitettu: ${result.file}.${result.backup ? ` Alkuperäinen varmuuskopioitu: ${result.backup}.` : ''} Käynnistä Rocket League uudelleen, jotta muutos tulee voimaan.`));
      } else if (result && !result.ok) {
        const perm = result.code === 'EPERM' || result.code === 'EACCES';
        out.push(h('div', { class: 'errbox' }, h('h3', { text: perm ? 'Ei kirjoitusoikeutta tiedostoon' : 'Käyttöönotto epäonnistui' }),
          h('div', { text: perm ? 'Windows esti tiedoston muokkaamisen (kansio on todennäköisesti suojattu). Voit tehdä muutoksen käsin:' : result.message }),
          perm ? h('ol', { style: null, class: 'sub' },
            h('li', { text: 'Sulje Rocket League.' }),
            h('li', { text: `Avaa tiedosto järjestelmänvalvojana (esim. Muistio, Suorita järjestelmänvalvojana): ${result.file || 'TAGame\\Config\\DefaultStatsAPI.ini'}` }),
            h('li', { text: 'Lisää tai päivitä alla oleva osio ja tallenna.' }),
            h('li', { text: 'Käynnistä Rocket League uudelleen.' })) : null,
          h('pre', { class: 'snippet', text: result.snippet || snippet }),
          h('div', null, h('button', { class: 'btn ghost small', onclick: () => copy(result.snippet || snippet) }, 'Kopioi'))));
      }
      out.push(h('div', { class: 'sub', text: 'Muistutus: Rocket League täytyy käynnistää uudelleen muutoksen jälkeen. Sovellus ei voi lukea ottelua, jos peli on käynnistetty ennen käyttöönottoa.' }));
      if (snippet) {
        out.push(h('details', null, h('summary', { class: 'sub', text: 'Näytä asetussnippet käsin liitettäväksi' }),
          h('pre', { class: 'snippet', text: snippet }),
          h('div', null, h('button', { class: 'btn ghost small', onclick: () => copy(snippet) }, 'Kopioi'))));
      }
      fill(api, out);
    }

    async function copy(text) {
      try { await U.unwrap(window.api.copyText(text)); U.toast('Kopioitu leikepöydälle.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
    }
    async function loadDetect(auto) {
      try {
        const d = await U.unwrap(window.api.rlDetect());
        installs = d.installs; snippet = d.snippet;
        if (!selected) selected = (settings && settings.rlInstallDir && installs.find((i) => i.dir === settings.rlInstallDir)) ? settings.rlInstallDir : (installs[0] && installs[0].dir) || null;
        if (!auto && !installs.length) U.toast('Rocket Leaguea ei löytynyt yleisistä sijainneista. Valitse kansio käsin.', 'err');
        if (!auto && installs.length) U.toast(`Löytyi ${installs.length} asennus${installs.length > 1 ? 'ta' : ''}.`);
      } catch (e) { U.toast(U.errMsg(e), 'err'); }
      renderApi();
    }
    const detect = () => { result = null; return loadDetect(false); };
    async function pick() {
      try {
        const info = await U.unwrap(window.api.rlPickDir());
        if (!info) return;
        installs = [info, ...installs.filter((i) => i.dir !== info.dir)];
        selected = info.dir; result = null;
        if (!snippet) { const d = await U.unwrap(window.api.rlDetect()); snippet = d.snippet; }
        renderApi();
      } catch (e) { U.toast(U.errMsg(e), 'err'); }
    }
    async function enable() {
      try {
        result = await U.unwrap(window.api.rlEnable(selected));
        if (result.ok) {
          const info = await U.unwrap(window.api.rlInspect(selected));
          installs = installs.map((i) => (i.dir === selected ? info : i));
          settings = await U.unwrap(window.api.getSettings());
        }
      } catch (e) { result = { ok: false, code: 'ERROR', message: U.errMsg(e), snippet }; }
      renderApi();
    }

    // ---- Tiedot ja ylläpito
    let info = null;
    function renderMaint() {
      const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
      const cacheBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Tyhjennä välimuisti');
      cacheBtn.addEventListener('click', busy(cacheBtn, async () => {
        try { await U.unwrap(window.api.clearCache()); U.toast('Välimuisti tyhjennetty.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      }));
      const owBtn = h('button', { class: 'btn danger', type: 'button' }, 'Nollaa OW-profiilin historia');
      owBtn.addEventListener('click', busy(owBtn, async () => {
        const ok = await U.confirmDialog('Nollataanko OW-profiilin historia?', 'Tallennetut tilannekuvat ja käsin kirjatut edistymismerkinnät poistetaan pysyvästi. Tätä ei voi perua. Uusi tilannekuva haetaan heti, jos profiili on asetettu.', 'Nollaa');
        if (!ok) return;
        try { await U.unwrap(window.api.profileOwHistoryReset()); U.toast('OW-historia nollattu.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      }));
      const rlBtn = h('button', { class: 'btn danger', type: 'button' }, 'Tyhjennä RL-otteluhistoria');
      rlBtn.addEventListener('click', busy(rlBtn, async () => {
        const ok = await U.confirmDialog('Tyhjennä Rocket League -historia?', 'Kaikki tallennetut Rocket League -ottelut poistetaan pysyvästi. Tätä ei voi perua.', 'Tyhjennä');
        if (!ok) return;
        try { await U.unwrap(window.api.rlClearHistory()); U.toast('RL-historia tyhjennetty.'); } catch (e) { U.toast(U.errMsg(e), 'err'); }
      }));
      fill(maint, h('h2', { text: 'Tiedot ja ylläpito' }),
        h('div', { class: 'form-grid' },
          h('label', { text: 'Versio' }), h('span', { class: 'ver', text: info ? `Statsikka ${info.version} (Electron ${info.electron})` : '–' }),
          h('label', { text: 'Tietojen sijainti' }), h('span', { class: 'sub path', text: info ? info.dataDir : '–' }),
          h('label', { text: 'Verkkovälimuisti' }), h('div', { class: 'row' }, cacheBtn, h('span', { class: 'sub', text: 'OverFast-vastaukset ja kuvat ladataan seuraavalla haulla uudelleen.' })),
          h('label', { text: 'OW-profiilin historia' }), h('div', { class: 'row' }, owBtn, h('span', { class: 'sub', text: 'Tilannekuvat ja edistymismerkinnät.' })),
          h('label', { text: 'Rocket League -historia' }), h('div', { class: 'row' }, rlBtn, h('span', { class: 'sub', text: 'Tallennetut ottelut.' }))));
    }

    // ---- Päivitykset (electron-updater, GitHub Releases): tila tulee pääprosessilta valmiiksi suomennettuna (state.text)
    let upd = null;
    function renderUpdates() {
      const ver = (upd && upd.current) || (info && info.version) || '–';
      const dev = !upd || upd.state === 'dev' || upd.state === 'disabled';
      const busy = !!upd && ['checking', 'available', 'downloading'].includes(upd.state);
      const checkBtn = h('button', { class: 'btn ghost upd-check', type: 'button', disabled: dev || busy }, 'Tarkista päivitykset');
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        try { upd = await U.unwrap(window.api.updaterCheck()); } catch (e) { U.toast(U.errMsg(e), 'err'); }
        renderUpdates();
      });
      const installBtn = upd && upd.state === 'downloaded' ? h('button', { class: 'btn upd-install', type: 'button' }, 'Käynnistä uudelleen ja päivitä') : null;
      if (installBtn) installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        try { await U.unwrap(window.api.updaterInstall()); } catch (e) { installBtn.disabled = false; U.toast(U.errMsg(e), 'err'); }
      });
      const text = upd ? upd.text : '–';
      fill(updCard, h('h2', { text: 'Päivitykset' }),
        h('div', { class: 'form-grid' },
          h('label', { text: 'Nykyinen versio' }), h('span', { class: 'ver upd-version', text: ver }),
          h('label', { text: 'Tila' }), h('span', { class: `sub upd-state${upd && upd.state === 'error' ? ' err' : ''}`, text }),
          h('label', { text: 'Päivitys' }), h('div', { class: 'row' }, checkBtn, installBtn)),
        h('p', { class: 'sub', text: 'Statsikka tarkistaa päivitykset itse käynnistyksen jälkeen ja kuuden tunnin välein. Ladattu päivitys asentuu, kun sovellus suljetaan kokonaan (tray-valikon "Lopeta" tai Ctrl+Q).' }));
    }
    async function loadUpdates() {
      try { upd = await U.unwrap(window.api.updaterState()); } catch (_) { upd = null; }
      renderUpdates();
    }
    window.api.onUpdaterState((s) => { upd = s; renderUpdates(); });

    async function init() {
      settings = await U.unwrap(window.api.getSettings());
      try { info = await U.unwrap(window.api.appInfo()); } catch (_) { info = null; }
      renderGeneral();
      renderBackground();
      renderProfiles();
      renderMaint();
      loadUpdates();
      loadR6();
      loadArz();
      loadOw();
      await loadDetect(true);
    }
    init().catch((e) => fill(el, h('div', { class: 'errbox' }, h('h3', { text: 'Asetusten lataus epäonnistui' }), h('div', { text: U.errMsg(e) }))));

    // Asetukset voivat muuttua muualla (esim. Oma profiili), joten luetaan ne uudelleen näkymään tultaessa.
    function onShow() {
      if (!settings) return;
      U.unwrap(window.api.getSettings()).then((s) => { settings = s; renderGeneral(); renderBackground(); renderProfiles(); renderArz(); }).catch(() => {});
      loadUpdates();
      loadR6();
      loadArz();
      loadOw();
    }

    return { el, onShow };
  }

  window.SettingsView = { create };
})();
