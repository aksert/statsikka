'use strict';
// Rainbow Six Siege: Ottelut. Tallenteista kertynyt ottelulista (uusin ensin) korttirivein: tuloksen värinen palkki, kartta, tulos, omat luvut,
// operaattorit ja RP-muutos (Arenyzen rank-historiasta, vain kun luotettavasti laskettu). Kortti aukeaa pistetaulukoksi ja kierrostuloksiksi.
(function () {
  const { h, fill, dec, pct, skel } = U;
  const R = R6Ui;
  const PAGE = 25;
  const MINUS = '−';
  const signed = (n) => (n > 0 ? '+' : n < 0 ? MINUS : '±') + Math.abs(n);
  const resCls = (m) => R.resultClass(m.result);

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

    // RP-muutos-chip: vain kun main laski muutoksen (Arenyze-historia + täsmälleen yksi ranked-ottelu välillä).
    function rpChip(m) {
      const r = m.rp;
      if (!r || !Number.isFinite(r.rpDelta)) return null;
      return h('span', { class: `chip rp-chip ${r.rpDelta > 0 ? 'up' : r.rpDelta < 0 ? 'down' : ''}`.trim(), text: `${signed(r.rpDelta)} RP`, title: `Rank-pisteet ennen → jälkeen (Arenyze): ${U.num(r.rpBefore)} → ${U.num(r.rpAfter)}` });
    }
    function statLines(m) {
      const o = m.own;
      if (!o) return [h('div', { class: 'sub', text: 'Et ollut mukana' })];
      const extra = [`HS ${pct(o.hsPercent)}`];
      if (o.kost != null) extra.push(`KOST ${pct(o.kost)}`);
      if (o.entryKills != null) extra.push(`Entry ${o.entryKills}–${o.entryDeaths}`);
      if (o.clutchAttempts > 0) extra.push(`Clutch ${o.clutchWins}/${o.clutchAttempts}`);
      return [h('div', { class: 'mono rmc-kd', text: `${o.kills} / ${o.deaths} · K/D ${dec(o.kd)}` }), h('div', { class: 'sub mono', text: extra.join(' · ') })];
    }
    function matchEl(m) {
      const isOpen = open.has(m.name);
      const cls = resCls(m);
      const head = h('button', { class: 'match-head r6-match-head', type: 'button', 'aria-expanded': String(isOpen), data: { name: m.name }, onclick: () => toggle(m.name) },
        h('span', { class: 'rmc-map' }, h('div', { class: 'rmc-mapname', text: m.map || 'Ottelu' }), h('div', { class: 'sub', text: [m.gamemode, m.matchType].filter(Boolean).join(' · ') }), h('div', { class: 'sub', text: R.dateTime(m.ts) })),
        h('span', { class: 'rmc-res' }, h('div', { class: `rmc-result ${cls}`, text: `${R.resultText(m.result)} ${m.score[0]}–${m.score[1]}` }), rpChip(m)),
        h('span', { class: 'rmc-stats' }, statLines(m)),
        h('span', { class: 'sub rmc-ops', text: m.own ? R.operatorsText({ operators: m.own.operators }) : '' }));
      let inner = null;
      if (isOpen) {
        const d = details.get(m.name);
        if (!d || d === 'lataa') inner = h('div', { class: 'match-body' }, skel('100%', 160));
        else if (d instanceof Error) inner = h('div', { class: 'match-body' }, h('div', { class: 'errbox' }, h('div', { text: U.errMsg(d) })));
        else inner = h('div', { class: 'match-body r6-match-body' }, R.scoreboard(d, { history: true }), R.roundsTable(d));
      }
      return h('div', { class: `match r6-match-card m-${cls}`, data: { result: cls } }, head, inner);
    }

    // Yhteenveto näkyvistä (ladatuista) otteluista: V-H, voitto-%, K/D ja RP yhteensä. Käynnissä oleva ja "et ollut mukana" -ottelu eivät kuulu lukuihin.
    function summaryEl() {
      const mine = items.filter((m) => m.own && m.result !== 'live');
      const w = mine.filter((m) => m.result === 'win').length, l = mine.filter((m) => m.result === 'loss').length, d = mine.filter((m) => m.result === 'draw').length;
      const kills = mine.reduce((a, m) => a + m.own.kills, 0), deaths = mine.reduce((a, m) => a + m.own.deaths, 0);
      const wr = w + l + d > 0 ? (w / (w + l + d)) * 100 : null;
      const rpItems = items.filter((m) => m.rp && Number.isFinite(m.rp.rpDelta));
      const rpSum = rpItems.reduce((a, m) => a + m.rp.rpDelta, 0);
      const cell = (label, value, cls, title) => h('div', { class: 'rs-cell', title: title || null }, h('div', { class: 'rs-l', text: label }), h('div', { class: `rs-v mono ${cls || ''}`.trim(), text: value }));
      return h('div', { class: 'card r6-match-summary', title: 'Yhteenveto sivulla näkyvistä otteluista' },
        cell('Ottelut', String(mine.length)),
        cell('V–H', `${w}–${l}${d ? `–${d}` : ''}`),
        cell('Voitto-%', pct(wr), wr == null ? '' : U.wrClass(wr)),
        cell('K/D', mine.length ? dec(deaths > 0 ? kills / deaths : kills) : '–'),
        rpItems.length ? cell('RP yhteensä', `${signed(rpSum)} RP`, rpSum > 0 ? 'win' : rpSum < 0 ? 'loss' : '', `Rank-pisteiden muutos ${rpItems.length} ottelusta (Arenyze)`) : null);
    }

    function render() {
      const empty = status ? R.emptyState(status, ctx) : null;
      fill(body,
        U.seg(R.FILTERS, filter, (v) => { filter = v; page = 1; items = []; open.clear(); load(); }),
        empty && !total ? empty : [
          h('div', { class: 'row' }, h('span', { class: 'sub', text: `${total} ottelua${status && status.scanning ? ` · luetaan tallenteita ${status.scanning.done} / ${status.scanning.total}` : ''}` })),
          items.length ? summaryEl() : null,
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

    // Arenyze-historia saapui (tai päivittyi): RP-chipit piirretään uudelleen.
    window.api.onArenyzeUpdate(() => {
      if (!R.visible(el)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
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
