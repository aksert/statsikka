'use strict';
// Rocket League: live-pelinäkymä (scoreboard + tapahtumasyöte).
(function () {
  const { h, fill, num, dec, pct, mmss } = U;

  const STATUS_TEXT = { connected: 'Yhdistetty', waiting: 'Odotetaan peliä', disconnected: 'Ei yhteyttä' };

  function encounterText(enc) {
    if (!enc) return '–';
    const parts = [];
    if (enc.with.games) parts.push(`Kanssa ${enc.with.games} (${enc.with.wins}V-${enc.with.games - enc.with.wins}H)`);
    if (enc.against.games) parts.push(`Vastaan ${enc.against.games} (${enc.against.wins}V-${enc.against.games - enc.against.wins}H)`);
    return parts.length ? parts.join(' · ') : '–';
  }

  // Aiemmin-sarakkeen solu: rivi 1 kanssa/vastaan (sinun näkökulmastasi), rivi 2 pelaajan keskiarvot omasta historiastasi.
  function histCell(p) {
    const enc = encounterText(p.encounter);
    const parts = [h('div', { text: enc !== '–' ? enc : p.hist ? 'Aiemmin tavattu' : 'Ensimmäinen kerta' })];
    const st = histStatsText(p.hist);
    if (st) parts.push(h('div', { class: 'sub', text: st }));
    return parts;
  }
  function histStatsText(hist) {
    if (!hist || !hist.games) return '';
    const a = hist.avg || {};
    return `${hist.games} peliä · Pisteet ${num(a.score)}/peli · Maalit ${dec(a.goals, 1)} · Torjunnat ${dec(a.saves, 1)} · Voitto-% ${pct(hist.winrate)}`;
  }

  // Yhteinen pistetaulukko (käytetään myös historiassa). showHistory=false piilottaa historiasarakkeen.
  // opts.onPlayer(p): rivin klikkaus avaa pelaajapaneelin (oma rivi ei ole klikattava; oletus avaa RL-paneelin). opts.prevMatch: edellisen ottelun tiedot chipin tooltipiin.
  function teamTable(teamNum, players, showHistory, title, opts = {}) {
    const onPlayer = opts.onPlayer === undefined ? openPlayer : opts.onPlayer;
    const rows = players.filter((p) => p.teamNum === teamNum).sort((a, b) => b.score - a.score);
    const cols = ['Pelaaja', 'Pisteet', 'Maalit', 'Syötöt', 'Torjunnat', 'Laukaukset', 'Demot', 'Kosketukset'];
    if (showHistory) cols.push('Aiemmin');
    return h('div', { class: `card team-table ${teamNum === 0 ? 'blue' : 'orange'}` },
      h('div', { class: 'head', text: title || (teamNum === 0 ? 'Sininen tiimi' : 'Oranssi tiimi') }),
      h('table', { class: 't' },
        h('thead', null, h('tr', null, cols.map((c) => h('th', { text: c })))),
        h('tbody', null, rows.length ? rows.map((p) => {
          const click = onPlayer && !p.isOwn && p.key ? () => onPlayer(p) : null;
          const pm = opts.prevMatch;
          const chip = p.prev ? PlayerPanel.prevChip(p.prev, PlayerPanel.prevTitle(pm && { arenaName: pm.arenaName, playlistName: pm.playlistName, endedAt: pm.endedAt }, p.prev, pm ? RES_TEXT[pm.result] : '')) : null;
          const tr = h('tr', { class: `${p.isOwn ? 'own' : ''} ${click ? 'clickable' : ''}`.trim(), tabindex: click ? '0' : null, data: { player: p.key || p.name }, onclick: click },
            h('td', null, h('span', { class: 'pname', text: p.name }), ' ', h('span', { class: 'badge', text: p.platform }), p.isOwn ? h('span', { class: 'badge', text: 'sinä' }) : null, chip),
            h('td', { text: num(p.score) }), h('td', { text: num(p.goals) }), h('td', { text: num(p.assists) }),
            h('td', { text: num(p.saves) }), h('td', { text: num(p.shots) }), h('td', { text: num(p.demos) }), h('td', { text: num(p.touches) }),
            showHistory ? h('td', { class: 'hist-cell rl-hist' }, p.isOwn ? 'Sinä' : histCell(p)) : null);
          if (click) tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) click(); });
          return tr;
        })
          : h('tr', null, h('td', { colspan: String(cols.length), class: 'muted', text: 'Ei pelaajia' })))));
  }

  const RES_TEXT = { win: 'Voitto', loss: 'Tappio' };
  function openPlayer(p) { if (p.key && window.RlPlayer) RlPlayer.open(p.key, p.name); }

  // Tiivis yhteenveto live-näkymän alkuun: tutut pelaajat, edellisen ottelun pelaajat.
  function liveSummary(m) {
    const others = m.players.filter((p) => !p.isOwn);
    const known = others.filter((p) => p.encounter || p.hist);
    const prev = others.filter((p) => p.prev).length;
    return h('div', { class: 'live-summary' },
      h('span', { class: 'chip', text: `Tuttuja pelaajia ${known.length} / ${others.length}` }),
      m.prevMatch ? h('span', { class: 'chip', text: `Edellisessä ottelussa mukana ${prev}` }) : null,
      h('span', { class: 'sub', text: 'Klikkaa pelaajaa nähdäksesi hänen profiilinsa.' }));
  }

  function feedLine(it) {
    const t = it.teamNum === 0 ? 'blue' : it.teamNum === 1 ? 'orange' : '';
    const ck = it.clock ? `${mmss(it.clock.timeSeconds)}${it.clock.overtime ? ' +' : ''}` : '';
    let text;
    if (it.kind === 'goal') text = `MAALI! ${it.player || '?'}${it.assister ? ` (syöttö: ${it.assister})` : ''} – ${it.speedKmh} km/h`;
    else if (it.kind === 'save') text = `Torjunta: ${it.player}`;
    else if (it.kind === 'epicsave') text = `Upea torjunta: ${it.player}`;
    else text = `Demolointi: ${it.player}${it.victim ? ` → ${it.victim}` : ''}`;
    return h('li', { class: t }, h('span', { class: 'ck mono', text: ck }), h('span', { text }));
  }

  function create(ctx) {
    const statusBox = h('div');
    const body = h('div', { class: 'view-pane' });
    const el = h('div', { class: 'view-pane' },
      h('div', { class: 'row', style: null }, h('h1', { class: 'page-title', text: 'Live-peli' }), statusBox), body);
    let last = null;

    function render() {
      const d = last;
      if (!d) { fill(statusBox); fill(body, h('div', { class: 'skel', style: null })); return; }
      fill(statusBox, h('span', { class: 'status-pill' }, h('span', { class: `status-dot ${d.status}` }), STATUS_TEXT[d.status] || d.status, h('span', { class: 'sub', text: `ws://127.0.0.1:${d.port}` })));
      const m = d.match;
      if (!m) {
        fill(body, d.status === 'disconnected'
          ? h('div', { class: 'empty' }, h('h3', { text: 'Ei yhteyttä Rocket Leaguen Stats API:in' }),
            h('div', { text: 'Käynnistä Rocket League sen jälkeen, kun Stats API on otettu käyttöön. Sovellus yrittää yhdistää automaattisesti 3 sekunnin välein.' }),
            h('div', { style: null }, h('button', { class: 'btn', onclick: () => ctx.goto('settings') }, 'Avaa Stats API -käyttöönotto')))
          : h('div', { class: 'empty' }, h('h3', { text: 'Odotetaan peliä…' }), h('div', { text: 'Yhteys on auki. Ottelun tiedot näkyvät heti kun peli alkaa.' })));
        return;
      }
      const blue = m.teams.find((t) => t.teamNum === 0) || { score: 0 };
      const orange = m.teams.find((t) => t.teamNum === 1) || { score: 0 };
      const meta = [m.playlistName, m.arenaName].filter(Boolean).join(' · ');
      fill(body,
        h('div', { class: 'scorebar' },
          h('div', { class: 'side blue' }, h('span', { class: 'sn', text: 'Sininen' }), h('span', { class: 'sc mono', text: String(blue.score) })),
          h('div', { class: 'mid' },
            h('div', { class: 'clock mono', text: mmss(m.timeSeconds) }),
            m.overtime ? h('div', { class: 'ot', text: 'JATKOAIKA' }) : null,
            m.replay ? h('div', { class: 'ot', text: 'TOISTO' }) : null,
            h('div', { class: 'meta', text: meta || '–' })),
          h('div', { class: 'side orange' }, h('span', { class: 'sn', text: 'Oranssi' }), h('span', { class: 'sc mono', text: String(orange.score) }))),
        m.hasWinner ? h('div', { class: 'banner', text: `Ottelu päättyi: ${m.winnerTeamNum === 0 ? 'Sininen' : m.winnerTeamNum === 1 ? 'Oranssi' : '?'} voitti.` }) : null,
        liveSummary(m),
        h('div', { class: 'two-col teams' }, teamTable(0, m.players, true, null, { prevMatch: m.prevMatch }), teamTable(1, m.players, true, null, { prevMatch: m.prevMatch })),
        h('div', { class: 'card' }, h('h2', { text: 'Tapahtumat (viimeiset 30)' }),
          d.feed.length ? h('ul', { class: 'feed' }, d.feed.map(feedLine)) : h('div', { class: 'sub', text: 'Ei tapahtumia vielä.' })));
    }

    return {
      el,
      update(d) { last = d; if (el.isConnected && !el.closest('[hidden]')) render(); },
      onShow() { render(); },
    };
  }

  window.RlLive = { create, teamTable, STATUS_TEXT };
})();
