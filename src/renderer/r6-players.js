'use strict';
// Rainbow Six Siege: Pelaajat. Kaikki ottelutallenteissa tapaamasi pelaajat; haku, lajittelu ja yksittäisen pelaajan tiedot.
(function () {
  const { h, fill, num, dec, pct, skel } = U;
  const R = R6Ui;
  const SORTS = [['last', 'Viimeksi nähty'], ['matches', 'Ottelut'], ['kd', 'K/D'], ['hs', 'HS %'], ['kpr', 'Tappoja / kierros'], ['kost', 'KOST %'], ['susp', 'Epäilyspisteet'], ['name', 'Nimi']];
  const rec = (rel) => (rel && rel.matches ? `${rel.matches} (${rel.wins}V-${rel.losses}H)` : '–');

  function create(ctx) {
    const body = h('div', { class: 'view-pane' });
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Pelaajat' })), body);
    const q = { search: '', sort: 'last', page: 1, flaggedOnly: false };
    let list = null;
    let status = null;
    let token = 0;
    let timer = null;
    let updTimer = null;
    const searchIn = h('input', { class: 'input', type: 'search', maxlength: '40', placeholder: 'Hae pelaajaa nimellä', spellcheck: 'false', 'aria-label': 'Hae pelaajaa' });
    const sortSel = h('select', { class: 'input', 'aria-label': 'Lajittelu' }, SORTS.map(([v, l]) => h('option', { value: v }, l)));
    sortSel.value = q.sort;
    const flagBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': 'false', onclick: () => { q.flaggedOnly = !q.flaggedOnly; q.page = 1; flagBtn.setAttribute('aria-pressed', String(q.flaggedOnly)); flagBtn.classList.toggle('on', q.flaggedOnly); loadList(); } }, 'Vain merkityt');
    searchIn.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q.search = searchIn.value; q.page = 1; loadList(); }, 250); });
    sortSel.addEventListener('change', () => { q.sort = sortSel.value; q.page = 1; loadList(); });
    const listBox = h('div', { class: 'r6-player-list' });
    fill(body, h('div', { class: 'row players-bar' }, searchIn, sortSel, flagBtn), listBox);

    function playerRow(p) {
      const row = h('tr', { class: 'clickable', tabindex: '0', data: { player: p.profileID }, onclick: () => openPlayer(p.profileID, p.username) },
        h('td', null, h('span', { class: 'pname', text: p.username }), p.otherNames.length ? h('div', { class: 'sub', text: `myös: ${p.otherNames.join(', ')}` }) : null),
        h('td', { text: num(p.matches) }), h('td', { text: rec(p.with) }), h('td', { text: rec(p.against) }),
        h('td', { text: dec(p.kd) }), h('td', { text: pct(p.hsPercent) }), h('td', { text: dec(p.kpr) }),
        h('td', { class: 'kost-cell', text: p.kost == null ? '–' : pct(p.kost), title: p.kost == null ? 'Ei kierrosdataa (vanha tai poistettu tallenne)' : `${R.ADV_TIPS.KOST} (${p.advRounds} kierrosta)` }),
        h('td', { class: 'sub', text: p.lastSeen ? new Date(p.lastSeen).toLocaleDateString('fi-FI') : '–' }),
        h('td', { class: 'susp-cell' }, p.suspicion ? Suspicion.node(p.suspicion, { compact: true }) : null));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) openPlayer(p.profileID, p.username); });
      return row;
    }

    // KOST-otsikko on lajitteluotsikko: klikkaus lajittelee KOST:in mukaan ja päivittää valitsimen.
    function headCell(c) {
      if (c !== 'KOST %') return h('th', { text: c });
      return h('th', { class: `sortable${q.sort === 'kost' ? ' on' : ''}`, tabindex: '0', role: 'button', title: `${R.ADV_TIPS.KOST} Klikkaa lajitellaksesi.`, onclick: sortKost, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortKost(); } } }, q.sort === 'kost' ? 'KOST % ▼' : 'KOST %');
    }
    function sortKost() { q.sort = 'kost'; q.page = 1; sortSel.value = 'kost'; loadList(); }

    function renderList() {
      const d = list;
      const empty = status ? R.emptyState(status, ctx) : null;
      if (empty && !(d && d.knownTotal)) { fill(listBox, empty); return; }
      fill(listBox,
        h('div', { class: 'row' },
          h('span', { class: 'sub', text: `${d.total} pelaajaa${d.total !== d.knownTotal ? ` (${d.knownTotal} yhteensä)` : ''}` }),
          d.flagged.watch || d.flagged.suspicious ? h('span', { class: 'sub', text: `Tarkkaile: ${d.flagged.watch} · Mahdollinen hakkeri: ${d.flagged.suspicious}` }) : null),
        d.players.length
          ? h('div', { class: 'card' }, h('table', { class: 't r6-players-table' },
            h('thead', null, h('tr', null, ['Pelaaja', 'Ott.', 'Kanssa', 'Vastaan', 'K/D', 'HS %', 'T/krs', 'KOST %', 'Viimeksi', 'Merkki'].map(headCell))),
            h('tbody', null, d.players.map(playerRow))))
          : h('div', { class: 'empty' }, h('h3', { text: 'Ei hakua vastaavia pelaajia' })),
        d.pages > 1 ? h('div', { class: 'row pager' },
          h('button', { class: 'btn ghost small', type: 'button', disabled: d.page <= 1, onclick: () => { q.page = d.page - 1; loadList(); } }, 'Edellinen'),
          h('span', { class: 'sub', text: `Sivu ${d.page} / ${d.pages}` }),
          h('button', { class: 'btn ghost small', type: 'button', disabled: d.page >= d.pages, onclick: () => { q.page = d.page + 1; loadList(); } }, 'Seuraava')) : null,
        h('div', { class: 'sub', text: 'Kanssa / Vastaan: ottelut ja tulokset (V-H) sinun näkökulmastasi. Merkki perustuu vain omiin ottelutallenteisiisi.' }));
    }

    async function loadList() {
      const my = ++token;
      try {
        status = await U.unwrap(window.api.r6Status());
        const d = await U.unwrap(window.api.r6Players({ search: q.search, sort: q.sort, page: q.page, pageSize: 50, flaggedOnly: q.flaggedOnly }));
        if (my !== token) return;
        list = d; q.page = d.page;
        renderList();
      } catch (e) {
        if (my !== token) return;
        fill(listBox, h('div', { class: 'errbox' }, h('h3', { text: 'Pelaajien lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    // Pelaajan tiedot avautuvat yhteiseen pelaajapaneeliin (sama kuin live-näkymässä).
    function openPlayer(id, name) { R6Player.open(id, name); }

    window.api.onR6Update(() => {
      if (!R.visible(el)) return;
      clearTimeout(updTimer);
      updTimer = setTimeout(loadList, 500);
    });

    fill(listBox, skel('100%', 60), skel('100%', 240));
    return { el, onShow() { return loadList(); }, reload: loadList };
  }

  window.R6Players = { create };
})();
