'use strict';
// Rocket League: pelaajapaneelin sisältö (rl:player) ja pelaajan avaus. Kaikki, mitä Stats API -tallenteistasi löytyy pelaajasta.
(function () {
  const { h, fill, num, dec, dateTime } = U;
  const rec = (s) => (s && s.games ? `${s.games} (${s.wins}V-${s.losses}H)` : '–');
  const SIDE_TEXT = { with: 'Kanssasi', against: 'Vastaan', unknown: '–' };
  const RES = { win: 'Voitto', loss: 'Tappio' };
  const NOTE = 'Rocket League ei tarjoa muiden pelaajien otteluhistoriaa. Näytetään ottelut, jotka Stats API on tallentanut sinun peleistäsi, joissa pelaaja oli mukana.';
  const tile = (label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'tl', text: label }), h('div', { class: 'tv', text: value }), sub ? h('div', { class: 'ts', text: sub }) : null);

  function render(p) {
    const open = new Set();
    const box = h('div', { class: 'rl-profile' });
    function matchEl(m) {
      const isOpen = open.has(m.guid);
      const [a, b] = [m.teams.find((t) => t.teamNum === m.teamNum) || { score: 0 }, m.teams.find((t) => t.teamNum !== m.teamNum) || { score: 0 }];
      const st = m.stats;
      const head = h('button', { class: 'match-head rl-pm-head', type: 'button', 'aria-expanded': String(isOpen), data: { guid: m.guid }, onclick: () => { if (open.has(m.guid)) open.delete(m.guid); else open.add(m.guid); draw(); } },
        h('span', { class: 'sub', text: dateTime(m.endedAt) }),
        h('span', null, h('div', { text: m.playlistName || 'Ottelu' }), h('div', { class: 'sub', text: m.arenaName || '' })),
        h('span', null, h('span', { class: `chip side-${m.side}`, text: SIDE_TEXT[m.side] })),
        h('span', { class: `res ${m.result || 'na'}`, text: RES[m.result] || 'Ei tulosta', title: 'Tulos pelaajan näkökulmasta' }),
        h('span', { class: 'mono', text: `${a.score} – ${b.score}${m.overtime ? ' (JA)' : ''}` }),
        h('span', { class: 'sub mono', text: `${st.score} p · ${st.goals} maalia · ${st.assists} syöttöä · ${st.saves} torj. · ${st.shots} laukausta · ${st.demos} demoa` }));
      return h('div', { class: 'match' }, head,
        isOpen && m.match ? h('div', { class: 'match-body' }, RlLive.teamTable(0, m.match.players, false), RlLive.teamTable(1, m.match.players, false)) : null);
    }
    function draw() {
      const av = p.averages;
      fill(box,
        h('div', { class: 'row' },
          h('span', { class: 'badge', text: p.platform }),
          p.names.length > 1 ? h('span', { class: 'sub', text: `Muut nimet: ${p.names.filter((n) => n !== p.name).slice(0, 5).join(', ')}` }) : null,
          p.lastSeen ? h('span', { class: 'sub', text: `Viimeksi nähty ${dateTime(p.lastSeen)}` }) : null),
        h('div', { class: 'tiles' },
          tile('Pelit', num(p.games), 'tallenteissasi'),
          tile('Kanssasi', rec(p.with), 'sinun V-H'),
          tile('Vastaan', rec(p.against), 'sinun V-H'),
          tile('Pisteet / peli', dec(av.score)),
          tile('Maalit / peli', dec(av.goals)),
          tile('Syötöt / peli', dec(av.assists)),
          tile('Torjunnat / peli', dec(av.saves)),
          tile('Laukaukset / peli', dec(av.shots)),
          tile('Demot / peli', dec(av.demos)),
          tile('Paras peli', p.best ? `${num(p.best.score)} p` : '–', p.best ? `${p.best.goals} maalia` : null)),
        h('div', { class: 'section-title', text: `Ottelut (${p.matchTotal > p.matchList.length ? `${p.matchList.length} uusinta / ${p.matchTotal}` : p.matchList.length})` }),
        p.matchList.map(matchEl),
        h('div', { class: 'sub', text: NOTE }));
    }
    draw();
    return box;
  }

  function open(key, name) {
    PlayerPanel.open({
      id: `rl:${key}`, title: name || 'Pelaaja', sub: 'Rocket League',
      load: () => U.unwrap(window.api.rlPlayer(key)),
      render: (p, api) => { api.setTitle(p.name || name || 'Pelaaja'); return render(p); },
    });
  }

  window.RlPlayer = { open };
})();
