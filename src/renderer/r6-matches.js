'use strict';
// Rainbow Six Siege: Ottelut. Tallenteista kertynyt ottelulista (uusin ensin); rivi aukeaa pistetaulukoksi ja kierrostuloksiksi.
(function () {
  const { h, fill, dec, pct, skel } = U;
  const R = R6Ui;
  const PAGE = 25;

  function create(ctx) {
    const body = h('div', { class: 'view-pane' });
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Ottelut' })), body);
    let filter = 'all';
    let items = [];
    let total = 0;
    let page = 1;
    let pages = 1;
    let status = null;
    const open = new Set();
    const details = new Map(); // nimi -> ottelun täysi näkymä | 'lataa' | virhe
    let token = 0;
    let timer = null;

    function matchEl(m) {
      const isOpen = open.has(m.name);
      const own = m.own ? `${m.own.kills} / ${m.own.deaths} · K/D ${dec(m.own.kd)} · HS ${pct(m.own.hsPercent)}${m.own.kost == null ? '' : ` · KOST ${pct(m.own.kost)}`}` : 'Et ollut mukana';
      const head = h('button', { class: 'match-head r6-match-head', type: 'button', 'aria-expanded': String(isOpen), data: { name: m.name }, onclick: () => toggle(m.name) },
        h('span', { class: 'sub', text: R.dateTime(m.ts) }),
        h('span', null, h('div', { text: m.map || 'Ottelu' }), h('div', { class: 'sub', text: [m.gamemode, m.matchType].filter(Boolean).join(' · ') })),
        h('span', { class: 'mono', text: `${m.score[0]} – ${m.score[1]}` }),
        h('span', { class: `res ${R.resultClass(m.result)}`, text: R.resultText(m.result) }),
        h('span', { class: 'sub mono', text: own }));
      let inner = null;
      if (isOpen) {
        const d = details.get(m.name);
        if (!d || d === 'lataa') inner = h('div', { class: 'match-body' }, skel('100%', 160));
        else if (d instanceof Error) inner = h('div', { class: 'match-body' }, h('div', { class: 'errbox' }, h('div', { text: U.errMsg(d) })));
        else inner = h('div', { class: 'match-body r6-match-body' }, R.scoreboard(d, { history: true }), R.roundsTable(d));
      }
      return h('div', { class: 'match' }, head, inner);
    }

    function render() {
      const empty = status ? R.emptyState(status, ctx) : null;
      fill(body,
        U.seg(R.FILTERS, filter, (v) => { filter = v; page = 1; items = []; open.clear(); load(); }),
        empty && !total ? empty : [
          h('div', { class: 'row' }, h('span', { class: 'sub', text: `${total} ottelua${status && status.scanning ? ` · luetaan tallenteita ${status.scanning.done} / ${status.scanning.total}` : ''}` })),
          items.length ? items.map(matchEl) : h('div', { class: 'empty' }, h('h3', { text: 'Ei otteluita tällä suodatuksella' })),
          page < pages ? h('div', null, h('button', { class: 'btn ghost', type: 'button', onclick: more }, `Näytä lisää (${total - items.length})`)) : null,
        ]);
    }

    async function toggle(name) {
      if (open.has(name)) { open.delete(name); render(); return; }
      open.add(name);
      render();
      if (!details.has(name)) details.set(name, 'lataa'); // välimuistissa oleva näytetään heti, tuore haetaan perään
      await toggleRefresh(name);
    }

    async function fetchPage(p) {
      return U.unwrap(window.api.r6Matches({ page: p, pageSize: PAGE, matchType: filter }));
    }
    async function load() {
      const my = ++token;
      try {
        status = await U.unwrap(window.api.r6Status());
        // Päivityksessä haetaan jo ladatut sivut uudelleen, jotta lista ei hyppää.
        const upto = Math.max(1, page);
        let all = [];
        let last = null;
        for (let p = 1; p <= upto; p++) {
          last = await fetchPage(p);
          if (my !== token) return;
          all = all.concat(last.items);
          if (last.page < p) break;
        }
        items = all; total = last.total; pages = last.pages; page = Math.min(upto, last.page);
        render();
        for (const k of open) toggleRefresh(k);
      } catch (e) {
        if (my !== token) return;
        fill(body, h('div', { class: 'errbox' }, h('h3', { text: 'Otteluiden lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    async function toggleRefresh(name) {
      try { details.set(name, await U.unwrap(window.api.r6Match(name))); } catch (e) { details.set(name, e); }
      if (open.has(name)) render();
    }
    async function more() {
      const my = token;
      try {
        const r = await fetchPage(page + 1);
        if (my !== token) return;
        page = r.page; pages = r.pages; total = r.total;
        items = items.concat(r.items);
        render();
      } catch (e) { U.toast(U.errMsg(e), 'err'); }
    }

    window.api.onR6Update(() => {
      if (!R.visible(el)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });

    fill(body, skel('100%', 60), skel('100%', 200));
    return { el, onShow: load, reload: load };
  }

  window.R6Matches = { create };
})();
