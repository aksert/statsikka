'use strict';
// Rainbow Six Siege: yhteiset näkymäosat (ottelutallenteista): tulostaulu, kierrostaulukko, "Aiemmin"-teksti, tilat.
(function () {
  const { h, num, dec, pct, dateTime } = U;

  const RESULT_TEXT = { win: 'Voitto', loss: 'Tappio', draw: 'Tasapeli', live: 'Käynnissä', unknown: 'Ei tulosta' };
  const resultText = (r) => RESULT_TEXT[r] || RESULT_TEXT.unknown;
  const resultClass = (r) => (r === 'win' ? 'win' : r === 'loss' ? 'loss' : r === 'live' ? 'live' : 'na');
  const FILTERS = [['all', 'Kaikki'], ['ranked', 'Ranked'], ['unranked', 'Unranked'], ['quick', 'Quick']];

  function tile(label, value, cls, sub, title) {
    return h('div', { class: 'tile', title: title || null }, h('div', { class: 'tl', text: label }), h('div', { class: `tv ${cls || ''}`, text: value }), sub ? h('div', { class: 'ts', text: sub }) : null);
  }

  // ---- Edistyneet tilastot (ottelutallenteista laskettu, src/main/r6-advanced.js). Tooltipit selittävät mittarit.
  const ADV_TIPS = {
    KOST: 'KOST = kierrokset, joissa pelaaja teki tapon, hoiti objektiivin (asennus tai purku), selvisi hengissä tai hänen kuolemansa tradattiin (tiimikaveri kosti 10 s sisällä), jaettuna pelatuilla kierroksilla.',
    Entry: 'Entry = kierroksen ensimmäinen vihollistappo. Näytetään entry-tapot – entry-kuolemat; onnistuminen = tapot / (tapot + kuolemat).',
    Trade: 'Trade-tappo: kostat tiimikaverin kuoleman tappamalla hänen tappajansa 10 sekunnin sisällä. Tradattu kuolema: tiimikaverisi kosti kuolemasi 10 sekunnin sisällä. Näytetään trade-tapot / tradatut kuolemat.',
    Clutch: '1vX-clutch: jäät tiimisi viimeiseksi eläväksi X vihollista vastaan. Voitto = tiimisi voittaa kierroksen. Näytetään voitot / yritykset.',
    Multi: 'Kierrokset, joilla teit 2, 3, 4 tai 5 (ace) vihollistappoa.',
    Obj: 'Defuserin asennukset / purut. Nykyisissä tallenteissa tekijää ei aina voi tunnistaa, jolloin luvut jäävät alakanttiin.',
  };
  const pairText = (a, b) => `${num(a)} / ${num(b)}`;

  // Tiilet: KOST %, Entry, Tradet, Clutchit, Multikillit, Plantit / Purut. adv = näyttömuoto (finalize) tai null -> "–".
  function advTiles(adv) {
    if (!adv) {
      const none = 'Ei dataa';
      return [['KOST %', 'KOST'], ['Entry', 'Entry'], ['Tradet', 'Trade'], ['Clutchit', 'Clutch'], ['Multikillit', 'Multi'], ['Plantit / Purut', 'Obj']].map(([l, k]) => tile(l, '–', '', none, ADV_TIPS[k]));
    }
    const c = adv.clutch, m = adv.multi;
    return [
      tile('KOST %', pct(adv.kost), '', `${num(adv.kostRounds)} / ${num(adv.rounds)} kierrosta`, ADV_TIPS.KOST),
      tile('Entry', `${num(adv.entryKills)}–${num(adv.entryDeaths)}`, '', adv.entryPct == null ? 'ei kaksintaisteluja' : `onnistuminen ${pct(adv.entryPct)}`, ADV_TIPS.Entry),
      tile('Tradet', pairText(adv.tradeKills, adv.tradedDeaths), '', 'trade-tapot / tradatut kuolemat', ADV_TIPS.Trade),
      tile('Clutchit', pairText(c.winsTotal, c.attemptsTotal), '', c.winPct == null ? 'ei yrityksiä' : `${pct(c.winPct)} voitettu`, ADV_TIPS.Clutch),
      tile('Multikillit', `${num(m.k2)} / ${num(m.k3)} / ${num(m.k4)} / ${num(m.ace)}`, 'sm', '2K / 3K / 4K / Ace', ADV_TIPS.Multi),
      tile('Plantit / Purut', pairText(adv.plants, adv.defuses), '', adv.objectiveUnknown > 0 ? `+ ${num(adv.objectiveUnknown)} krs ilman tunnistettua tekijää` : 'asennukset / purut', ADV_TIPS.Obj),
    ];
  }
  // Pieni taulukko: clutchit 1v1…1v5 (yritykset, voitot, voitto-%).
  function clutchCard(adv) {
    const c = adv && adv.clutch;
    return h('div', { class: 'card r6-clutch', title: ADV_TIPS.Clutch }, h('h2', { text: 'Clutchit' }),
      c && c.attemptsTotal > 0
        ? h('table', { class: 't' },
          h('thead', null, h('tr', null, ['', '1v1', '1v2', '1v3', '1v4', '1v5'].map((x) => h('th', { text: x })))),
          h('tbody', null,
            h('tr', null, h('td', { text: 'Voitot / yritykset' }), c.attempts.map((a, i) => h('td', { text: pairText(c.wins[i], a) }))),
            h('tr', null, h('td', { text: 'Voitto-%' }), c.attempts.map((a, i) => h('td', { text: a > 0 ? pct((c.wins[i] / a) * 100) : '–' })))))
        : h('div', { class: 'sub', text: adv ? 'Ei clutch-tilanteita.' : 'Ei dataa (vanhat ottelut tai tallenne puuttuu).' }));
  }
  // Pistetaulun lisäsarakkeet (KOST, Entry, Trade, Clutch): vain jos jollain pelaajalla on dataa eikä opts.adv === false.
  const ADV_COLS = ['KOST', 'Entry', 'Trade', 'Clutch'];
  const ARZ_COL = 'Ranked (Arenyze)'; // live-rivin Arenyze-sarake: rank + RP, kauden K/D ja V-H; näkyy vain kun avain on asetettu ja automaattihaku päällä
  function advCells(p) {
    const a = p.adv;
    if (!a) return ADV_COLS.map((c) => h('td', { class: 'adv-cell', text: '–', title: ADV_TIPS[c] }));
    return [
      h('td', { class: 'adv-cell', text: pct(a.kost), title: `${ADV_TIPS.KOST} (${num(a.kostRounds)} / ${num(a.rounds)} kierrosta)` }),
      h('td', { class: 'adv-cell', text: `${num(a.entryKills)}–${num(a.entryDeaths)}`, title: ADV_TIPS.Entry }),
      h('td', { class: 'adv-cell', text: pairText(a.tradeKills, a.tradedDeaths), title: ADV_TIPS.Trade }),
      h('td', { class: 'adv-cell', text: pairText(a.clutch.winsTotal, a.clutch.attemptsTotal), title: ADV_TIPS.Clutch }),
    ];
  }

  // "Kanssa 3 (2V-1H)" / "Vastaan 1 (0V-1H)" sinun näkökulmastasi.
  function relText(label, rel) {
    if (!rel || !rel.matches) return null;
    return `${label} ${rel.matches} (${rel.wins}V-${rel.losses}H${rel.draws ? `-${rel.draws}T` : ''})`;
  }
  function encounterText(hist) {
    if (!hist) return '';
    return [relText('Kanssa', hist.with), relText('Vastaan', hist.against)].filter(Boolean).join(' · ');
  }
  function histStatsText(hist) {
    if (!hist || !hist.matches) return '';
    return `${hist.matches} ottelua · K/D ${dec(hist.kd)} · HS ${pct(hist.hsPercent)}`;
  }

  function operatorsText(p) {
    const ops = (p.operators || []).filter((o) => o && o.name);
    if (!ops.length) return '–';
    const shown = ops.slice(0, 4).map((o) => (o.rounds > 1 ? `${o.name} ×${o.rounds}` : o.name));
    return shown.join(', ') + (ops.length > 4 ? ` +${ops.length - 4}` : '');
  }

  function scoreText(m, ownFirst) {
    const sc = (m.teams || []).map((t) => (t && Number.isFinite(t.score) ? t.score : 0));
    const oi = m.ownTeamIndex;
    if (ownFirst && (oi === 0 || oi === 1)) return `${sc[oi] || 0} – ${sc[1 - oi] || 0}`;
    return `${sc[0] || 0} – ${sc[1] || 0}`;
  }
  const metaText = (m) => [m.map && m.map.name, m.gamemode && m.gamemode.name, m.matchType && m.matchType.name].filter(Boolean).join(' · ');

  // Yksi joukkueen tulostaulu. opts.history: näytä "Aiemmin"-sarake ja epäilysmerkki.
  function teamTable(m, teamIdx, title, cls, opts = {}) {
    const rows = (m.players || []).filter((p) => p.teamIndex === teamIdx).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const cols = ['Pelaaja', 'Operaattorit', 'Tapot', 'Kuolemat'];
    if (m.hasAssists) cols.push('Apu');
    cols.push('K/D', 'HS %');
    if (m.hasScore) cols.push('Pisteet');
    if (m.hasHealth) cols.push('HP');
    if (m.hasAdv && opts.adv !== false) cols.push(...ADV_COLS);
    if (m.hasArz) cols.push(ARZ_COL);
    if (opts.history) cols.push('Aiemmin');
    const team = (m.teams || [])[teamIdx];
    return h('div', { class: `card team-table r6-team-table ${cls}` },
      h('div', { class: 'head' }, h('span', { text: title }), team ? h('span', { class: 'mono sub', text: `${team.score} voittoa` }) : null),
      h('table', { class: 't' },
        h('thead', null, h('tr', null, cols.map((c) => h('th', { text: c, title: ADV_TIPS[c] || null, class: ADV_TIPS[c] ? 'adv-cell' : c === ARZ_COL ? 'arz-cell' : null })))),
        h('tbody', null, rows.length ? rows.map((p) => playerRow(p, m, cols.length, opts))
          : h('tr', null, h('td', { colspan: String(cols.length), class: 'muted', text: 'Ei pelaajia' })))));
  }
  // Pelaajarivi. opts.onPlayer(p): rivin klikkaus avaa pelaajapaneelin (oma rivi ei ole klikattava). p.prev: oliko edellisessä ottelussa.
  function playerRow(p, m, ncols, opts) {
    const click = opts.onPlayer && !p.isOwn ? () => opts.onPlayer(p) : null;
    const prevChip = p.prev && window.PlayerPanel ? PlayerPanel.prevChip(p.prev, PlayerPanel.prevTitle(m.prevMatch && { map: m.prevMatch.map, type: m.prevMatch.type, ts: m.prevMatch.ts }, p.prev, m.prevMatch ? resultText(m.prevMatch.result) : '')) : null;
    const row = h('tr', { class: `${p.isOwn ? 'own' : ''} ${click ? 'clickable' : ''}`.trim(), tabindex: click ? '0' : null, data: { player: p.profileID || p.username }, onclick: click },
          h('td', null, h('span', { class: 'pname', text: p.username }), p.isOwn ? h('span', { class: 'badge', text: 'sinä' }) : null, prevChip),
          h('td', { class: 'ops-cell', text: operatorsText(p) }),
          h('td', { text: num(p.kills) }), h('td', { text: num(p.deaths) }),
          m.hasAssists ? h('td', { text: num(p.assists) }) : null,
          h('td', { text: dec(p.kd) }), h('td', { text: pct(p.hsPercent) }),
          m.hasScore ? h('td', { text: num(p.score) }) : null,
          m.hasHealth ? h('td', { text: p.health == null ? '–' : num(p.health) }) : null,
          m.hasAdv && opts.adv !== false ? advCells(p) : null,
          m.hasArz ? h('td', { class: 'arz-cell' }, window.ArzUi ? ArzUi.liveCell(p.arz) : null) : null,
          opts.history ? h('td', { class: 'hist-cell r6-hist' }, p.isOwn ? 'Sinä' : histCell(p)) : null);
    if (click) row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) click(); });
    return row;
  }
  function histCell(p) {
    const enc = encounterText(p.hist);
    const parts = [];
    if (enc) parts.push(h('div', { text: enc }));
    else parts.push(h('div', { text: p.hist ? 'Aiemmin tavattu' : 'Ensimmäinen kerta' }));
    const st = histStatsText(p.hist);
    if (st) parts.push(h('div', { class: 'sub', text: st }));
    if (p.suspicion) { const n = Suspicion.node(p.suspicion, { compact: true }); if (n) parts.push(n); }
    return parts;
  }

  // Pelaajan klikkaus avaa pelaajapaneelin (oma rivi ei ole klikattava).
  function openPlayer(p) {
    const key = p.key || p.profileID || (p.username ? `u:${String(p.username).toLowerCase()}` : '');
    if (key && window.R6Player) R6Player.open(key, p.username);
  }

  // Tiivis yhteenveto live-näkymän alkuun: tutut pelaajat, edellisen ottelun pelaajat ja merkityt.
  function liveSummary(m) {
    const others = (m.players || []).filter((p) => !p.isOwn);
    const known = others.filter((p) => p.hist && p.hist.matches);
    const withN = known.filter((p) => p.hist.with && p.hist.with.matches).length, againstN = known.filter((p) => p.hist.against && p.hist.against.matches).length;
    const prev = others.filter((p) => p.prev).length;
    const flagged = others.filter((p) => p.suspicion && p.suspicion.level !== 'none').length;
    const chips = [
      h('span', { class: 'chip', text: `Tuttuja pelaajia ${known.length} / ${others.length}${known.length ? ` (kanssa ${withN}, vastaan ${againstN})` : ''}` }),
      m.prevMatch ? h('span', { class: 'chip', text: `Edellisessä ottelussa mukana ${prev}` }) : null,
      h('span', { class: `chip ${flagged ? 'warn' : ''}`, text: `Merkittyjä ${flagged}` }),
    ];
    return h('div', { class: 'live-summary' }, chips,
      h('span', { class: 'sub', text: 'Klikkaa pelaajaa nähdäksesi hänen profiilinsa.' }));
  }

  // Molemmat joukkueet: oma ensin.
  function scoreboard(m, opts = {}) {
    opts = { onPlayer: openPlayer, ...opts };
    const oi = m.ownTeamIndex === 0 || m.ownTeamIndex === 1 ? m.ownTeamIndex : 0;
    const ownKnown = m.ownTeamIndex === 0 || m.ownTeamIndex === 1;
    return h('div', { class: 'two-col teams r6-teams' },
      teamTable(m, oi, ownKnown ? 'Oma tiimi' : 'Tiimi 1', 'blue', opts),
      teamTable(m, 1 - oi, ownKnown ? 'Vastustaja' : 'Tiimi 2', 'orange', opts));
  }

  // Kierroskohtaiset tulokset.
  function roundsTable(m) {
    const oi = m.ownTeamIndex;
    const wins = m.roundWinners || [];
    const rows = (m.rounds || []).map((r, i) => {
      const w = wins[i] !== undefined ? wins[i] : -1;
      const role = r.teamRoles && (oi === 0 || oi === 1) ? r.teamRoles[oi] : '';
      const roleFi = role === 'Attack' ? 'Hyökkäys' : role === 'Defense' ? 'Puolustus' : '–';
      const res = w < 0 || (oi !== 0 && oi !== 1) ? 'unknown' : (w === oi ? 'win' : 'loss');
      const sc = Array.isArray(r.score) ? ((oi === 0 || oi === 1) ? `${r.score[oi]} – ${r.score[1 - oi]}` : `${r.score[0]} – ${r.score[1]}`) : '–';
      return h('tr', null, h('td', { text: String((r.roundNumber != null ? r.roundNumber : i) + 1) }), h('td', { text: roleFi }),
        h('td', { class: 'site-cell', text: r.site || '–' }), h('td', { text: sc }),
        h('td', null, h('span', { class: `res ${resultClass(res)}`, text: res === 'unknown' ? '–' : resultText(res) })),
        h('td', { text: r.winCondition || '' }));
    });
    return h('div', { class: 'card r6-rounds' }, h('h2', { text: 'Kierrokset' }),
      rows.length ? h('table', { class: 't' }, h('thead', null, h('tr', null, ['Kierros', 'Puoli', 'Paikka', 'Tilanne', 'Tulos', 'Ratkaisu'].map((c) => h('th', { text: c })))), h('tbody', null, rows))
        : h('div', { class: 'sub', text: 'Ei kierrostietoja.' }));
  }

  // Skannaus- ja tyhjät tilat: palauttaa DOM-solmun tai null, jos dataa on.
  function emptyState(s, ctx) {
    if (s && s.scanning && !s.matchCount) {
      return h('div', { class: 'empty' }, h('h3', { text: 'Luetaan ottelutallenteita…' }), h('div', { text: `${s.scanning.done} / ${s.scanning.total} ottelukansiota` }));
    }
    if (s && !s.dirFound) {
      return h('div', { class: 'empty' }, h('h3', { text: 'Match Replay -kansiota ei löytynyt' }),
        h('div', { text: 'Ota pelissä käyttöön Match Replay ja pelaa ottelu, tai valitse MatchReplay-kansio Asetuksissa.' }),
        h('div', null, h('button', { class: 'btn', onclick: () => ctx.goto('settings') }, 'Avaa asetukset')));
    }
    if (s && !s.matchCount) {
      return h('div', { class: 'empty' }, h('h3', { text: 'Ei vielä tallennettuja otteluita' }),
        h('div', { text: 'Ottelut tallentuvat, kun Match Replay on päällä pelissä. Ne ilmestyvät tänne automaattisesti.' }));
    }
    return null;
  }
  // Näkymän sisältö vain kun näkyvissä (ei turhia hakuja piilotetuille välilehdille).
  const visible = (el) => el.isConnected && !el.closest('[hidden]');

  window.R6Ui = { tile, advTiles, clutchCard, ADV_TIPS, resultText, resultClass, FILTERS, encounterText, histStatsText, operatorsText, scoreText, metaText, teamTable, scoreboard, liveSummary, openPlayer, roundsTable, emptyState, visible, dateTime };
})();
