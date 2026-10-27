'use strict';
// Rainbow Six Siege: "Pelaajan tarkistus". R6:lle ei ole datalähdettä, joten käyttäjä syöttää luvut käsin;
// pääprosessi arvioi ne samalla pisteytyksellä kuin OW:n epätavalliset tilastot (r6:assess).
(function () {
  const { h, fill } = U;

  const RANKS = ['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Champion'];
  const NUM = [
    { key: 'kd', label: 'K/D', short: 'K/D' },
    { key: 'hsPercent', label: 'HS-%', short: 'HS-%' },
    { key: 'winrate', label: 'Voitto-%', short: 'V-%' },
    { key: 'matches', label: 'Ottelut', short: 'Ott.' },
    { key: 'kills', label: 'Tapot', short: 'Tapot' },
    { key: 'killsPerRound', label: 'Tappoja / kierros (valinnainen)', short: 'T/krs' },
    { key: 'level', label: 'Taso (valinnainen)', short: 'Taso' },
  ];
  const KEY_ONE = 'statsikka.r6check';
  const KEY_LOBBY = 'statsikka.r6lobby';
  const SLOTS = 5;
  const HINT = 'R6:lle ei ole julkista rajapintaa, joten syötä luvut käsin.';

  const blank = () => Object.fromEntries([['name', ''], ...NUM.map((f) => [f.key, '']), ['rank', '']]);
  function clean(raw) {
    const e = blank();
    if (raw && typeof raw === 'object') for (const k of Object.keys(e)) if (typeof raw[k] === 'string') e[k] = raw[k].slice(0, 40);
    if (e.rank && !RANKS.includes(e.rank)) e.rank = '';
    return e;
  }
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* localStorage ei käytettävissä */ } }
  const payload = (e) => Object.fromEntries([...NUM.map((f) => [f.key, e[f.key]]), ['rank', e.rank]]);

  // Arvio IPC:llä -> merkki. Palauttaa DOM-solmun (virhe / pois päältä / merkki).
  async function assess(e, opts) {
    try {
      const res = await U.unwrap(window.api.r6Assess(payload(e)));
      if (!res) return h('span', { class: 'sub', text: 'Indikaattori on pois päältä (Asetukset > Herkkyys).' });
      return Suspicion.node(res, { showNone: true, compact: !!opts.compact, open: !!opts.open });
    } catch (err) {
      return h('span', { class: 'sub warn', text: U.errMsg(err) });
    }
  }

  function create() {
    // ---- Yksittäinen pelaaja
    const one = clean(read(KEY_ONE));
    const oneOut = h('div', { class: 'r6-result' });
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: '40', value: one.name, placeholder: 'Pelaajan nimi (valinnainen)', spellcheck: 'false', 'aria-label': 'Pelaajan nimi' });
    nameIn.addEventListener('input', () => { one.name = nameIn.value; write(KEY_ONE, one); });
    const inps = {};
    const fields = NUM.map((f) => {
      const inp = h('input', { class: 'input', type: 'text', inputmode: 'decimal', maxlength: '12', value: one[f.key], 'aria-label': f.label, spellcheck: 'false' });
      inps[f.key] = inp;
      inp.addEventListener('input', () => { one[f.key] = inp.value.trim(); write(KEY_ONE, one); });
      return h('label', { class: 'r6-field' }, h('span', { class: 'sub', text: f.label }), inp);
    });
    const rankSel = h('select', { class: 'input', 'aria-label': 'Rank' }, h('option', { value: '' }, '–'), RANKS.map((r) => h('option', { value: r }, r)));
    rankSel.value = one.rank;
    rankSel.addEventListener('change', () => { one.rank = rankSel.value; write(KEY_ONE, one); });
    fields.push(h('label', { class: 'r6-field' }, h('span', { class: 'sub', text: 'Rank (valinnainen)' }), rankSel));

    // Hae Arenyzestä: täyttää kentät kausitilastoista (K/D, HS-%, voitto-%, ottelut, tapot, taso, rank) ja arvioi saman normalisoidun datan evaluateR6:lla.
    const arzPlat = U.seg(ArzUi.PLATFORMS, 'uplay');
    const arzMsg = h('div', { class: 'sub arz-check-msg', role: 'status' });
    const arzBtn = h('button', { class: 'btn ghost arz-lookup', type: 'button', title: 'Hakee pelaajan tilastot Arenyzestä (1 kutsu; tulos välimuistiin 6 h)', onclick: () => arzLookup() }, 'Hae Arenyzestä');
    async function arzLookup() {
      const name = nameIn.value.trim();
      if (!name) { fill(arzMsg, 'Anna pelaajan nimi ensin.'); return; }
      arzBtn.disabled = true;
      fill(arzMsg, U.skel(220, 16));
      try {
        const r = await ArzUi.lookup({ name, platform: arzPlat.get(), kind: 'summary', mode: 'user' });
        const d = r.data;
        if (!d.hasData) { fill(arzMsg, `Pelaaja löytyi Arenyzestä, mutta rankattuja tilastoja ei ole${d.level != null ? ` (taso ${d.level})` : ''}.`); return; }
        for (const k of Object.keys(inps)) { inps[k].value = r.check[k]; one[k] = r.check[k]; }
        rankSel.value = r.check.rank; one.rank = r.check.rank;
        write(KEY_ONE, one);
        fill(arzMsg, `Haettu Arenyzestä (${ArzUi.ageText(r.ageMs)}): ${d.rankName || 'ei rankia'}${d.rankPoints == null ? '' : `, ${d.rankPoints} RP`}${d.seasonCode ? `, ${d.seasonCode}` : ''}. Kentät täytetty kausitilastoista.${r.error ? ` Päivitys epäonnistui (${r.error.message}), käytetään tallennettua tulosta.` : ''}`);
        fill(oneOut, h('div', { class: 'r6-result-head' }, h('strong', { text: one.name || d.name || 'Pelaaja' }),
          r.suspicion ? Suspicion.node(r.suspicion, { showNone: true, open: r.suspicion.level !== 'none' }) : h('span', { class: 'sub', text: 'Indikaattori on pois päältä (Asetukset > Herkkyys).' })));
      } catch (e) {
        fill(arzMsg, h('span', { class: 'warn' }, ArzUi.msg(e)));
      } finally { arzBtn.disabled = false; }
    }
    const form = h('form', { class: 'r6-form', onsubmit: async (ev) => {
      ev.preventDefault();
      fill(oneOut, U.skel(260, 36));
      const node = await assess(one, { open: true });
      fill(oneOut, h('div', { class: 'r6-result-head' }, h('strong', { text: one.name || 'Pelaaja' }), node));
    } },
    h('label', { class: 'r6-field wide' }, h('span', { class: 'sub', text: 'Nimi' }), nameIn),
    h('div', { class: 'row r6-arz-row' }, arzBtn, arzPlat, arzMsg),
    h('div', { class: 'r6-fields' }, fields),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Tarkista'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => {
        Object.assign(one, blank()); write(KEY_ONE, one);
        nameIn.value = ''; rankSel.value = '';
        form.querySelectorAll('.r6-fields input').forEach((i) => { i.value = ''; });
        fill(oneOut); fill(arzMsg);
      } }, 'Tyhjennä lomake')),
    oneOut);
    const oneCard = h('div', { class: 'card r6-single' }, h('h2', { text: 'Yksittäinen pelaaja' }),
      h('p', { class: 'sub', text: HINT }),
      h('p', { class: 'sub', text: 'Tai hae pelaajan tilastot nimellä: "Hae Arenyzestä" täyttää kentät Ubisoftin kausitilastoista (vaatii ilmaisen Arenyze-avaimen Asetuksissa) ja arvioi ne. Käy kenelle tahansa pelaajalle, myös niille joiden kanssa et ole pelannut.' }),
      h('p', { class: 'sub', text: 'Pakollinen on vain ottelumäärä; tyhjät kentät ohitetaan. Kaikki säännöt eivät toteudu pienellä otoksella (esim. K/D vaatii 50 ottelua, HS-% 100 tappoa).' }),
      form);

    // ---- Lobby (5 + 5)
    const saved = read(KEY_LOBBY);
    const lobby = {
      ally: Array.from({ length: SLOTS }, (_, i) => clean(saved && saved.ally && saved.ally[i])),
      enemy: Array.from({ length: SLOTS }, (_, i) => clean(saved && saved.enemy && saved.enemy[i])),
    };
    const saveLobby = () => write(KEY_LOBBY, lobby);
    const resultBoxes = { ally: [], enemy: [] };
    const rowEls = { ally: [], enemy: [] };

    function rowEl(team, i) {
      const e = lobby[team][i];
      const res = h('div', { class: 'r6-row-res' });
      resultBoxes[team][i] = res;
      const nm = h('input', { class: 'input r6-name', type: 'text', maxlength: '40', value: e.name, placeholder: `Pelaaja ${i + 1}`, spellcheck: 'false', 'aria-label': `Nimi ${i + 1}` });
      nm.addEventListener('input', () => { e.name = nm.value; saveLobby(); });
      const nums = NUM.map((f) => {
        const inp = h('input', { class: 'input r6-num', type: 'text', inputmode: 'decimal', maxlength: '12', value: e[f.key], placeholder: f.short, title: f.label, 'aria-label': `${f.label} ${i + 1}`, spellcheck: 'false' });
        inp.addEventListener('input', () => { e[f.key] = inp.value.trim(); saveLobby(); fill(res); });
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') evaluateAll(); });
        return inp;
      });
      const rk = h('select', { class: 'input r6-rank', title: 'Rank (valinnainen)', 'aria-label': `Rank ${i + 1}` }, h('option', { value: '' }, 'Rank'), RANKS.map((r) => h('option', { value: r }, r)));
      rk.value = e.rank;
      rk.addEventListener('change', () => { e.rank = rk.value; saveLobby(); fill(res); });
      const row = h('div', { class: 'r6-row' }, nm, nums, rk, res);
      rowEls[team][i] = { nm, nums, rk };
      return row;
    }
    const hasData = (e) => NUM.some((f) => e[f.key] !== '') || e.rank !== '';
    async function evaluateOne(team, i) {
      const e = lobby[team][i];
      const box = resultBoxes[team][i];
      if (!hasData(e)) { fill(box); return; }
      fill(box, U.skel(120, 22));
      fill(box, await assess(e, { compact: true }));
    }
    let busy = false;
    async function evaluateAll() {
      if (busy) return;
      const jobs = [];
      for (const team of ['ally', 'enemy']) for (let i = 0; i < SLOTS; i++) if (hasData(lobby[team][i])) jobs.push(evaluateOne(team, i)); else fill(resultBoxes[team][i]);
      if (!jobs.length) { U.toast('Syötä ainakin yhden pelaajan luvut.', 'err'); return; }
      busy = true; evalBtn.disabled = true;
      try { await Promise.all(jobs); } finally { busy = false; evalBtn.disabled = false; }
    }
    const evalBtn = h('button', { class: 'btn', type: 'button', onclick: evaluateAll }, 'Arvioi kaikki');
    const clearBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      for (const team of ['ally', 'enemy']) for (let i = 0; i < SLOTS; i++) {
        Object.assign(lobby[team][i], blank());
        const r = rowEls[team][i];
        r.nm.value = ''; r.rk.value = ''; r.nums.forEach((n) => { n.value = ''; });
        fill(resultBoxes[team][i]);
      }
      saveLobby();
    } }, 'Tyhjennä');
    const teamBox = (team, title, cls) => h('div', { class: `r6-team ${cls}` }, h('h3', { class: 'sub-title', text: title }),
      Array.from({ length: SLOTS }, (_, i) => rowEl(team, i)));
    const lobbyCard = h('div', { class: 'card r6-lobby' }, h('h2', { text: 'Lobby (5 + 5)' }),
      h('p', { class: 'sub', text: 'Samat kentät tiiviinä rivinä: K/D, HS-%, voitto-%, ottelut, tapot, tappoja/kierros, taso, rank. Syötteet muistetaan seuraavaa kertaa varten.' }),
      h('div', { class: 'row' }, evalBtn, clearBtn),
      teamBox('ally', 'Oma tiimi', 'ally'), teamBox('enemy', 'Viholliset', 'enemy'));

    const el = h('div', { class: 'view-pane' },
      h('h1', { class: 'page-title', text: 'Pelaajan tarkistus' }),
      h('div', { class: 'sub', text: 'Pelaajille, joita et ole nähnyt omissa ottelutallenteissasi: arvio käsin syötetyistä luvuista. Tallenteista tavatut pelaajat löytyvät Pelaajat-välilehdeltä arvioineen. Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.' }),
      oneCard, lobbyCard);
    return { el, onShow() {} };
  }

  window.R6Check = { create, RANKS, HINT };
})();
