'use strict';
// Rocket League: Pelaajat. Kaikki Stats API -tallenteissasi tavatut pelaajat; haku, lajittelu ja pelaajapaneeli.
(function () {
  const { h, fill, num, skel } = U;
  const SORTS = [['games', 'Pelit'], ['with', 'Kanssa'], ['against', 'Vastaan'], ['last', 'Viimeksi nähty'], ['name', 'Nimi']];
  const rec = (s) => (s && s.games ? `${s.games} (${s.wins}V-${s.losses}H)` : '–');

  function create() {
    const body = h('div', { class: 'view-pane' });
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Pelaajat' })), body);
    const q = { search: '', sort: 'games', page: 1 };
    let token = 0, timer = null;
    const searchIn = h('input', { class: 'input', type: 'search', maxlength: '40', placeholder: 'Hae pelaajaa nimellä', spellcheck: 'false', 'aria-label': 'Hae pelaajaa' });
    const sortSel = h('select', { class: 'input', 'aria-label': 'Lajittelu' }, SORTS.map(([v, l]) => h('option', { value: v }, l)));
    sortSel.value = q.sort;
    searchIn.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q.search = searchIn.value; q.page = 1; load(); }, 250); });
    sortSel.addEventListener('change', () => { q.sort = sortSel.value; q.page = 1; load(); });
    const listBox = h('div', { class: 'rl-player-list' });
    fill(body, h('div', { class: 'row players-bar' }, searchIn, sortSel), listBox);

    function row(p) {
      const open = () => RlPlayer.open(p.key, p.name);
      const tr = h('tr', { class: 'clickable', tabindex: '0', data: { player: p.key }, onclick: open },
        h('td', null, h('span', { class: 'pname', text: p.name }), ' ', h('span', { class: 'badge', text: p.platform }),
          p.otherNames.length ? h('div', { class: 'sub', text: `myös: ${p.otherNames.join(', ')}` }) : null),
        h('td', { text: num(p.games) }), h('td', { text: rec(p.with) }), h('td', { text: rec(p.against) }),
        h('td', { class: 'sub', text: p.lastSeen ? new Date(p.lastSeen).toLocaleDateString('fi-FI') : '–' }));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) open(); });
      return tr;
    }
    function render(d) {
      if (!d.knownTotal) {
        fill(listBox, h('div', { class: 'empty' }, h('h3', { text: 'Ei vielä tavattuja pelaajia' }),
          h('div', { text: 'Pelaajat tallentuvat ottelutallenteiden mukana, kun pelaat Rocket Leaguea sovelluksen ollessa auki ja Stats API on käytössä.' })));
        return;
      }
      fill(listBox,
        h('div', { class: 'row' }, h('span', { class: 'sub', text: `${d.total} pelaajaa${d.total !== d.knownTotal ? ` (${d.knownTotal} yhteensä)` : ''}` })),
        d.players.length
          ? h('div', { class: 'card' }, h('table', { class: 't rl-players-table' },
            h('thead', null, h('tr', null, ['Pelaaja', 'Pelit', 'Kanssa', 'Vastaan', 'Viimeksi'].map((c) => h('th', { text: c })))),
            h('tbody', null, d.players.map(row))))
          : h('div', { class: 'empty' }, h('h3', { text: 'Ei hakua vastaavia pelaajia' })),
        d.pages > 1 ? h('div', { class: 'row pager' },
          h('button', { class: 'btn ghost small', type: 'button', disabled: d.page <= 1, onclick: () => { q.page = d.page - 1; load(); } }, 'Edellinen'),
          h('span', { class: 'sub', text: `Sivu ${d.page} / ${d.pages}` }),
          h('button', { class: 'btn ghost small', type: 'button', disabled: d.page >= d.pages, onclick: () => { q.page = d.page + 1; load(); } }, 'Seuraava')) : null,
        h('div', { class: 'sub', text: 'Kanssa / Vastaan: pelit ja tulokset (V-H) sinun näkökulmastasi. Perustuu vain omiin Stats API -tallenteisiisi.' }));
    }
    async function load() {
      const my = ++token;
      try {
        const d = await U.unwrap(window.api.rlPlayers({ search: q.search, sort: q.sort, page: q.page, pageSize: 50 }));
        if (my !== token) return;
        q.page = d.page;
        render(d);
      } catch (e) {
        if (my !== token) return;
        fill(listBox, h('div', { class: 'errbox' }, h('h3', { text: 'Pelaajien lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    fill(listBox, skel('100%', 60), skel('100%', 200));
    return { el, onShow: load, reload: load };
  }

  window.RlPlayers = { create };
})();
