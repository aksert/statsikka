'use strict';
// Epätavallisten tilastojen merkki (vain Overwatch 2) ja Tarkkuus-kortti. Perusteet avautuvat details-elementissä (ei ponnahdusikkunaa).
(function () {
  const { h, pct, duration } = U;

  const LABEL = { watch: 'Tarkkaile', suspicious: 'Mahdollinen hakkeri' };
  const DISCLAIMER = 'Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.';
  const DISCLAIMER_REPLAY = 'Perustuu ottelutallenteiden tilastoihin, ei todiste huijaamisesta.';
  const DISCLAIMER_ARENYZE = 'Perustuu Ubisoftin kausitilastoihin (Arenyze), ei todiste huijaamisesta.';
  const disclaimerOf = (s) => (s.source === 'replay' ? DISCLAIMER_REPLAY : s.source === 'arenyze' ? DISCLAIMER_ARENYZE : DISCLAIMER);

  // opts.showNone: näytä hillitty merkki myös tasolla "none" (profiilin otsikko). opts.compact: pienempi (lobbykortti).
  function node(s, opts = {}) {
    if (!s) return null;
    if (s.level === 'none') {
      if (!opts.showNone) return null;
      return h('span', { class: 'susp-none', title: disclaimerOf(s), text: s.sampleOk ? 'Ei epätavallisia tilastoja' : 'Liian vähän pelejä arvioon' });
    }
    const stop = (e) => e.stopPropagation(); // lobbykortti on klikattava: merkin käsittely ei avaa profiilia
    return h('details', { class: `susp ${s.level} ${opts.compact ? 'compact' : ''}`, open: !!opts.open, onclick: stop, onkeydown: stop },
      h('summary', { class: 'susp-badge', title: 'Näytä perusteet' },
        h('span', { class: 'susp-dot', 'aria-hidden': 'true' }), LABEL[s.level],
        opts.compact ? null : h('span', { class: 'susp-score', text: `${s.score} p` })),
      h('div', { class: 'susp-body' },
        h('ul', { class: 'susp-reasons' }, s.reasons.map((r) => h('li', null, h('span', { text: r.text }), h('span', { class: 'susp-w', text: `+${r.weight}` })))),
        h('div', { class: 'sub', text: disclaimerOf(s) })));
  }

  // Tarkkuus-kortti: aseen ja kriittisten osumien tarkkuus eniten pelatuilla hitscan-hahmoilla.
  function accuracyCard(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const over = (flag) => (flag ? 'acc-over' : '');
    const lim = (v) => (v == null ? '' : ` (raja ${Math.round(v)} %)`);
    return h('div', { class: 'card accuracy-card' }, h('h2', { text: 'Tarkkuus' }),
      list.length ? h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Hahmo', 'Peliaika', 'Aseen tarkkuus', 'Kriittiset osumat'].map((x) => h('th', { text: x })))),
        h('tbody', null, list.map((r) => h('tr', null,
          h('td', null, h('div', { class: 'hero-cell' }, U.img(r.portrait, '', r.name), h('span', { text: r.name }))),
          h('td', { text: duration(r.timePlayed) }),
          h('td', { class: over(r.weaponOver), text: r.weapon == null ? '–' : `${pct(r.weapon)}${lim(r.weaponLimit)}` }),
          h('td', { class: over(r.critOver), text: r.critLimit == null ? 'ei käytössä' : (r.crit == null ? '–' : `${pct(r.crit)}${lim(r.critLimit)}`) })))))
        : h('div', { class: 'sub', text: 'Ei hitscan-hahmoja, joita olisi pelattu vähintään tunti.' }),
      h('div', { class: 'sub', text: `Kolme eniten pelattua hitscan-hahmoa (vähintään 1 h). Punainen = yli heuristisen rajan. ${DISCLAIMER}` }));
  }

  window.Suspicion = { node, accuracyCard, LABEL, DISCLAIMER, DISCLAIMER_ARENYZE };
})();
