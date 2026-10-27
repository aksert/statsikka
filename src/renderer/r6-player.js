'use strict';
// Rainbow Six Siege: pelaajapaneelin sisältö (r6:player). Kaikki, mitä sovellus on nähnyt pelaajasta omissa ottelutallenteissasi.
(function () {
  const { h, fill, num, dec, pct, skel } = U;
  const R = R6Ui;
  const rec = (rel) => (rel && rel.matches ? `${rel.matches} (${rel.wins}V-${rel.losses}H${rel.draws ? `-${rel.draws}T` : ''})` : '–');
  const SIDE_TEXT = { with: 'Kanssasi', against: 'Vastaan', unknown: '–' };
  const NOTE = 'Ubisoft ei tarjoa muiden pelaajien otteluhistoriaa, joten näytetään kaikki, minkä sovellus on nähnyt tästä pelaajasta omissa ottelutallenteissasi. Ottelut, joissa et ollut mukana, eivät näy.';

  // Pelaajaa ei ole nähty omissa tallenteissa (esim. GEP-rosterin uusi pelaaja): minimaalinen paneeli.
  function renderEmpty(name) {
    return h('div', { class: 'empty r6-unseen' }, h('h3', { text: 'Ei aiempia tallenteita' }),
      h('div', { text: `${name || 'Pelaaja'} ei ole vielä näkynyt omissa ottelutallenteissasi. Tiedot kertyvät, kun pelaatte samassa ottelussa ja Match Replay on päällä.` }));
  }

  function render(p) {
    const open = new Map(); // ottelun nimi -> true
    const details = new Map(); // nimi -> ottelun täysi näkymä | 'lataa' | Error
    const box = h('div', { class: 'r6-profile' });
    // Arenyze-osio luodaan kerran (draw() piirtää ottelulistan uudelleen jokaisella avauksella, eikä haun pidä käynnistyä uudelleen).
    const arz = window.ArzUi ? ArzUi.section(p.username) : null;

    async function toggle(name) {
      if (open.has(name)) { open.delete(name); draw(); return; }
      open.set(name, true);
      if (!details.has(name)) details.set(name, 'lataa');
      draw();
      if (details.get(name) === 'lataa') {
        try { details.set(name, await U.unwrap(window.api.r6Match(name))); } catch (e) { details.set(name, e); }
        if (open.has(name)) draw();
      }
    }

    function matchEl(m) {
      const isOpen = open.has(m.name);
      const head = h('button', { class: 'match-head r6-pm-head', type: 'button', 'aria-expanded': String(isOpen), data: { name: m.name }, onclick: () => toggle(m.name) },
        h('span', { class: 'sub', text: R.dateTime(m.ts) }),
        h('span', null, h('div', { text: m.map || 'Ottelu' }), h('div', { class: 'sub', text: m.type || '' })),
        h('span', null, h('span', { class: `chip side-${m.side}`, text: SIDE_TEXT[m.side] }), m.unusual ? h('span', { class: 'chip warn', title: 'Poikkeavan hyvä ottelu', text: 'poikkeava' }) : null),
        h('span', { class: `res ${R.resultClass(m.playerResult)}`, text: R.resultText(m.playerResult), title: 'Tulos pelaajan näkökulmasta' }),
        h('span', { class: 'mono', text: `${m.teamScore[0]} – ${m.teamScore[1]}` }),
        h('span', { class: 'sub mono', text: `${m.kills}-${m.deaths}-${m.assists} · HS ${pct(m.hsPercent)}${m.kost == null ? '' : ` · KOST ${pct(m.kost)}`}`, title: m.kost == null ? null : R.ADV_TIPS.KOST }),
        h('span', { class: 'sub ops-cell', text: m.operators.length ? m.operators.map((o) => o.name).join(', ') : '–' }));
      let inner = null;
      if (isOpen) {
        const d = details.get(m.name);
        if (!d || d === 'lataa') inner = h('div', { class: 'match-body' }, skel('100%', 160));
        else if (d instanceof Error) inner = h('div', { class: 'match-body' }, h('div', { class: 'errbox' }, h('div', { text: U.errMsg(d) })));
        else inner = h('div', { class: 'match-body r6-match-body' }, R.scoreboard(d, { history: true, adv: false, onPlayer: (x) => R6Player.open(x.key || x.profileID, x.username) }));
      }
      return h('div', { class: 'match' }, head, inner);
    }

    function draw() {
      const list = p.matchList;
      fill(box,
        arz,
        h('div', { class: 'row' },
          p.usernames.length > 1 ? h('span', { class: 'sub', text: `Muut nimet: ${p.usernames.filter((n) => n !== p.username).slice(0, 5).join(', ')}` }) : null,
          p.suspicion ? h('span', { class: 'sub', text: 'Ottelutallenteistasi:' }) : null,
          p.suspicion ? Suspicion.node(p.suspicion, { showNone: true, open: p.suspicion.level !== 'none' }) : null),
        h('div', { class: 'tiles' },
          R.tile('Ottelut', num(p.matches), '', 'tallenteissasi'),
          R.tile('Kierrokset', num(p.rounds)),
          R.tile('K/D', dec(p.kd), '', `${num(p.kills)} / ${num(p.deaths)}`),
          R.tile('HS %', pct(p.hsPercent)),
          R.tile('Tappoja / kierros', dec(p.kpr)),
          p.assists > 0 ? R.tile('Avut', num(p.assists)) : null,
          R.tile('Kanssasi', rec(p.with), '', 'sinun V-H'),
          R.tile('Vastaan', rec(p.against), '', 'sinun V-H'),
          p.adv ? R.advTiles(p.adv) : null),
        h('div', { class: 'two-col stack-narrow' },
          h('div', { class: 'card' }, h('h2', { text: 'Parhaat operaattorit' }),
            p.operators.length ? h('table', { class: 't' },
              h('thead', null, h('tr', null, ['Operaattori', 'Kierrokset', 'K/D', 'HS %'].map((c) => h('th', { text: c })))),
              h('tbody', null, p.operators.slice(0, 8).map((o) => h('tr', null, h('td', { text: o.name }), h('td', { text: num(o.rounds) }), h('td', { text: o.kd == null ? '–' : dec(o.kd) }), h('td', { text: o.hsPercent == null ? '–' : pct(o.hsPercent) })))))
              : h('div', { class: 'sub', text: 'Ei operaattoritietoja.' })),
          h('div', { class: 'card' }, h('h2', { text: 'Kartat' }),
            p.maps.length ? h('table', { class: 't' },
              h('thead', null, h('tr', null, ['Kartta', 'Ottelut', 'V-H', 'K/D'].map((c) => h('th', { text: c })))),
              h('tbody', null, p.maps.slice(0, 8).map((x) => h('tr', null, h('td', { text: x.name }), h('td', { text: num(x.matches) }), h('td', { text: `${x.wins}-${x.losses}` }), h('td', { text: dec(x.kd) })))))
              : h('div', { class: 'sub', text: 'Ei karttatietoja.' }))),
        h('div', { class: 'section-title', text: `Ottelut (${p.matchTotal > list.length ? `${list.length} uusinta / ${p.matchTotal}` : list.length})` }),
        list.map(matchEl),
        h('div', { class: 'sub', text: NOTE }));
    }
    draw();
    return box;
  }

  function open(key, name) {
    PlayerPanel.open({
      id: `r6:${key}`, title: name || 'Pelaaja', sub: 'Rainbow Six Siege',
      load: () => U.unwrap(window.api.r6Player(key)).catch((e) => { if (e && e.code === 'NOT_FOUND') return { unseen: true }; throw e; }),
      render: (p, api) => {
        if (p.unseen) {
          api.setTitle(name || 'Pelaaja');
          return h('div', { class: 'r6-profile' }, window.ArzUi && name ? ArzUi.section(name) : null, renderEmpty(name));
        }
        api.setTitle(p.username || name || 'Pelaaja');
        return render(p);
      },
    });
  }

  window.R6Player = { open };
})();
