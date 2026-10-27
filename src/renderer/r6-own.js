'use strict';
// Rainbow Six Siege: oman profiilin tilastoosio ottelutallenteista (käytetään Oma profiili -koosteessa ja R6:n Oma profiili -välilehdellä).
(function () {
  const { h, fill, num, dec, pct, wrClass, skel } = U;
  const R = R6Ui;

  const ROLE_FI = { Attack: 'Hyökkäys', Defense: 'Puolustus' };
  const hasN = (n) => Number.isFinite(n);

  function create(ctx) {
    const body = h('div', { class: 'r6-own' });
    const el = h('div', { class: 'r6-own-wrap' }, body);
    let filter = 'all';
    let token = 0;
    let timer = null;

    function matchRef(label, m, extra) {
      if (!m) return h('div', { class: 'card' }, h('h2', { text: label }), h('div', { class: 'sub', text: '–' }));
      return h('div', { class: 'card' }, h('h2', { text: label }),
        h('div', { class: 'rv big mono', text: extra }),
        h('div', { class: 'sub', text: `${m.map || '–'} · ${R.dateTime(m.ts)} · ${R.resultText(m.result)}` }),
        h('div', { class: 'sub mono', text: `${m.kills} tappoa / ${m.deaths} kuolemaa · HS ${pct(m.hsPercent)}` }));
    }

    function mapTable(maps) {
      return h('div', { class: 'card' }, h('h2', { text: 'Kartat' }),
        maps.length ? h('table', { class: 't' },
          h('thead', null, h('tr', null, ['Kartta', 'Ottelut', 'Voitto-%', 'K/D'].map((c) => h('th', { text: c })))),
          h('tbody', null, maps.slice(0, 12).map((m) => h('tr', null, h('td', { text: m.name }), h('td', { text: `${m.matches} (${m.wins}V-${m.losses}H)` }),
            h('td', { class: wrClass(m.winrate), text: pct(m.winrate) }), h('td', { text: dec(m.kd) })))))
          : h('div', { class: 'sub', text: 'Ei vielä otteluita.' }),
        maps.length > 12 ? h('div', { class: 'sub', text: `+ ${maps.length - 12} muuta karttaa` }) : null);
    }
    function opTable(ops) {
      return h('div', { class: 'card' }, h('h2', { text: 'Operaattorit' }),
        ops.length ? h('table', { class: 't' },
          h('thead', null, h('tr', null, ['Operaattori', 'Krs', 'Tapot', 'Kuol.', 'K/D', 'HS %'].map((c) => h('th', { text: c })))),
          h('tbody', null, ops.slice(0, 15).map((o) => h('tr', null, h('td', null, h('span', { text: o.name }), ROLE_FI[o.role] ? h('span', { class: 'sub role-tag', text: ` ${ROLE_FI[o.role]}` }) : null),
            h('td', { text: num(o.rounds) }), h('td', { text: hasN(o.kills) ? num(o.kills) : '–' }), h('td', { text: hasN(o.deaths) ? num(o.deaths) : '–' }),
            h('td', { text: hasN(o.kd) ? dec(o.kd) : '–' }), h('td', { text: hasN(o.hsPercent) ? pct(o.hsPercent) : '–' })))))
          : h('div', { class: 'sub', text: 'Ei vielä otteluita.' }),
        ops.length > 15 ? h('div', { class: 'sub', text: `+ ${ops.length - 15} muuta operaattoria` }) : null);
    }

    function draw(s, status) {
      const empty = R.emptyState({ scanning: status.scanning, matchCount: status.matchCount, dirFound: status.dirFound }, ctx);
      const tc = s.typeCounts || {};
      const seg = U.seg(R.FILTERS.map(([v, l]) => [v, tc[v] != null ? `${l} (${tc[v]})` : l]), filter, (v) => { filter = v; load(); });
      if (empty) { fill(body, empty); return; }
      const st = s.streak;
      const wrPts = s.series.winrate.map((p) => ({ x: p.i, y: p.value, title: `Ottelu ${p.i} (${U.dateTime(p.ts)}): ${pct(p.value)}` }));
      const kostPts = (s.series.kost || []).map((p) => ({ x: p.i, y: p.value, title: `Ottelu ${p.i} (${U.dateTime(p.ts)}, ${p.map || '–'}): KOST ${pct(p.value)}` }));
      const backfill = status.scanning && status.scanning.backfill > 0 ? status.scanning : null;
      const kdPts = s.series.kd.map((p) => ({ x: p.i, y: p.value, title: `Ottelu ${p.i} (${U.dateTime(p.ts)}, ${p.map || '–'}): K/D ${dec(p.value)}` }));
      fill(body,
        h('div', { class: 'row r6-filter' }, seg,
          h('span', { class: 'sub', text: s.active ? 'Käynnissä oleva ottelu lasketaan mukaan, kun se päättyy.' : 'Tilastot omista ottelutallenteistasi.' })),
        s.matches === 0 ? h('div', { class: 'banner', text: 'Ei otteluita tällä suodatuksella.' }) : null,
        h('div', { class: 'tiles' },
          R.tile('Voitot', num(s.wins), 'win', `${s.matches} ottelua`), R.tile('Häviöt', num(s.losses), 'loss', s.draws ? `${s.draws} tasapeliä` : null),
          R.tile('Voitto-%', pct(s.winrate), wrClass(s.winrate)),
          R.tile('K/D', dec(s.kd), '', `${num(s.kills)} / ${num(s.deaths)}`), R.tile('HS %', pct(s.hsPercent), '', `${num(s.headshots)} päähän`),
          R.tile('Tappoja / kierros', dec(s.kpr), '', `${num(s.rounds)} kierrosta`),
          R.tile('Putki', st ? num(st.count) : '–', st ? (st.type === 'win' ? 'win' : 'loss') : '', st ? (st.type === 'win' ? 'voittoa putkeen' : 'tappiota putkeen') : null),
          R.tile('10 viimeisen voitto-%', pct(s.last10.winrate), wrClass(s.last10.winrate), s.last10.games ? `${s.last10.wins} / ${s.last10.games} voittoa` : null),
          R.tile('Hyökkäyskierrokset', pct(s.attack.winrate), wrClass(s.attack.winrate), `${s.attack.won} / ${s.attack.played} voitettu`),
          R.tile('Puolustuskierrokset', pct(s.defense.winrate), wrClass(s.defense.winrate), `${s.defense.won} / ${s.defense.played} voitettu`)),
        h('div', { class: 'section-title r6-adv-title', text: 'Edistyneet tilastot (kierrosdatasta)' }),
        backfill ? h('div', { class: 'banner small r6-backfill', role: 'status', text: `Täydennetään edistyneitä tilastoja vanhoille otteluille taustalla (${backfill.done} / ${backfill.total} kansiota luettu).` }) : null,
        h('div', { class: 'adv-tiles' }, R.advTiles(s.adv)),
        s.matches > 0 ? h('div', { class: 'sub r6-adv-note', text: s.adv
          ? `Laskettu ${num(s.advMatches)} / ${num(s.matches)} ottelusta: vain ottelut, joiden tallenne on ollut luettavissa. TDM-kierroksia ei lasketa.`
          : 'Ei vielä edistyneitä tilastoja tällä suodatuksella: ne lasketaan tallenteista, joten pelin jo poistamilta otteluilta ne puuttuvat.' }) : null,
        h('div', { class: 'two-col' },
          h('div', { class: 'card' }, h('h2', { text: 'Voitto-% (liukuva, 10 ottelua)' }),
            Charts.lineChart({ series: [{ name: 'Voitto-%', cls: 4, points: wrPts }], xKind: 'index', width: 520, height: 240, yFormat: (v) => `${Math.round(v)} %`, label: 'Liukuva voitto-prosentti' })),
          h('div', { class: 'card' }, h('h2', { text: 'K/D per ottelu' }),
            Charts.lineChart({ series: [{ name: 'K/D', cls: 3, points: kdPts }], xKind: 'index', width: 520, height: 240, yFormat: (v) => dec(v, 1), label: 'K/D per ottelu' }))),
        h('div', { class: 'two-col' },
          h('div', { class: 'card r6-kost-chart', title: R.ADV_TIPS.KOST }, h('h2', { text: 'KOST per ottelu' }),
            Charts.lineChart({ series: [{ name: 'KOST %', cls: 1, points: kostPts }], xKind: 'index', width: 520, height: 240, yFormat: (v) => `${Math.round(v)} %`, label: 'KOST per ottelu' })),
          R.clutchCard(s.adv)),
        h('div', { class: 'two-col stack-narrow' }, mapTable(s.maps), opTable(s.operators)),
        h('div', { class: 'two-col' },
          matchRef('Paras ottelu: eniten tappoja', s.bestKills, s.bestKills ? `${s.bestKills.kills} tappoa` : '–'),
          matchRef('Paras ottelu: korkein K/D', s.bestKd, s.bestKd ? `K/D ${dec(s.bestKd.kd)}` : '–')));
    }

    async function load() {
      const my = ++token;
      try {
        const [s, status] = await Promise.all([U.unwrap(window.api.r6Own({ matchType: filter })), U.unwrap(window.api.r6Status())]);
        if (my !== token) return;
        draw(s, status);
      } catch (e) {
        if (my !== token) return;
        fill(body, h('div', { class: 'errbox' }, h('h3', { text: 'R6-tilastojen lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    window.api.onR6Update(() => {
      if (!R.visible(el)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 500);
    });

    fill(body, skel('100%', 90), skel('100%', 240));
    return { el, reload: load };
  }

  window.R6Own = { create };
})();
