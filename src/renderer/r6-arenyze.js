'use strict';
// Rainbow Six Siege: Ubisoftin tilastot Arenyze-rajapinnasta (r6.arenyze.com) mille tahansa pelaajalle nimellä + alustalla.
// Yhteiset osat: pelaajapaneelin / oman profiilin osio, live-rivin solu ja rank-merkki. Haut tekee pääprosessi (välimuisti, kutsubudjetti, avain);
// tämä moduuli vain näyttää tuloksen. Ei innerHTML:ää.
(function () {
  const { h, fill, num, dec, pct, skel } = U;

  const PLATFORMS = [['uplay', 'PC'], ['psn', 'PlayStation'], ['xbl', 'Xbox']];
  const NOTE = 'Tiedot ovat Ubisoftin kausitilastoja Arenyzen rajapinnasta (r6.arenyze.com). Muiden pelaajien ottelukohtaista historiaa ei ole saatavilla. Tulokset tallennetaan välimuistiin 6 tunniksi.';
  let nav = null;           // { openSettings }
  const sections = new Set();

  const init = (n) => { nav = n; };
  function ageText(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 1) return 'juuri nyt';
    if (m < 60) return `${m} min sitten`;
    const hh = Math.floor(m / 60);
    if (hh < 48) return `${hh} h sitten`;
    return `${Math.floor(hh / 24)} pv sitten`;
  }
  const msg = (e) => (e && e.message ? e.message : 'Tuntematon virhe.');
  const lookup = (arg) => U.unwrap(window.api.arenyzeLookup(arg));
  const tierCls = (tier) => `t-${String(tier || 'none').toLowerCase()}`;

  // Rank-merkki: väri arvon mukaan, teksti esim. "Platinum II" tai "Rank 18", jos nimeä ei voi päätellä.
  function rankChip(d) {
    const name = d && d.rankName ? d.rankName : (d && d.rank ? `Rank ${d.rank}` : 'Ei rankia');
    return h('span', { class: `arz-rank ${tierCls(d && d.rankTier)}`, text: name });
  }

  // Live-pistetaulun solu (p.arz = pääprosessin peek-tulos).
  function liveCell(a) {
    if (!a) return h('span', { class: 'sub', text: '–' });
    if (a.anonymous) return h('span', { class: 'sub', text: 'Anonyymi', title: 'Pelaaja on piilottanut nimensä' });
    if (a.state === 'pending') return h('span', { class: 'sub arz-pending', text: 'Haetaan…' });
    if (a.state === 'error') return h('span', { class: 'sub warn', title: a.message || '', text: a.code === 'NOT_FOUND' ? 'Ei löytynyt' : 'Haku epäonnistui' });
    if (a.state === 'budget') return h('span', { class: 'sub warn', title: a.message || '', text: 'Raja täynnä' });
    if (a.state !== 'ok') return h('span', { class: 'sub', text: '–', title: a.message || 'Ei vielä haettu' });
    if (!a.hasData) return h('span', { class: 'sub', text: 'Ei rankattuja tietoja', title: `Haettu ${ageText(a.ageMs)}` });
    const wl = a.wins == null && a.losses == null ? '' : ` · V-H ${num(a.wins)}-${num(a.losses)}${a.winrate == null ? '' : ` (${pct(a.winrate)})`}`;
    return h('div', { class: 'arz-live', title: `Arenyze, haettu ${ageText(a.ageMs)}${a.stale ? ' (vanhentunut)' : ''}${a.seasonCode ? ` · ${a.seasonCode}` : ''}` },
      h('div', null, rankChip(a), h('span', { class: 'sub', text: a.rankPoints == null ? '' : ` ${num(a.rankPoints)} RP` })),
      h('div', { class: 'sub', text: `K/D ${dec(a.kd)}${wl}` }),
      a.suspicion ? Suspicion.node(a.suspicion, { compact: true }) : null);
  }

  // ---- Osio (pelaajapaneeli, oma profiili) ----------------------------------------------------------------------
  function opTable(ops) {
    return h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Operaattori', 'Puoli', 'Kierrokset', 'K/D', 'HS %'].map((c) => h('th', { text: c })))),
      h('tbody', null, ops.slice(0, 6).map((o) => h('tr', null, h('td', { text: o.name }), h('td', { text: o.side || '–' }), h('td', { text: num(o.rounds) }), h('td', { text: dec(o.kd) }), h('td', { text: pct(o.hsPercent) })))));
  }
  function seasonTable(list) {
    const rows = list.filter((s) => s.ranked || s.rankPoints != null).slice(-6).reverse();
    if (!rows.length) return null;
    return h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Kausi', 'RP', 'K/D', 'Ottelut'].map((c) => h('th', { text: c })))),
      h('tbody', null, rows.map((s) => h('tr', null, h('td', { text: s.code || (s.number == null ? '–' : `#${s.number}`) }), h('td', { text: num(s.rankPoints) }), h('td', { text: dec(s.kd) }), h('td', { text: num(s.matches) })))));
  }
  function historyChart(profile) {
    const pts = (profile && profile.history ? profile.history : []).map((p) => ({ x: p.ts, y: p.rp, title: `${U.dateTime(p.ts)}: ${num(p.rp)} RP${p.rank ? ` (${p.rank})` : ''}` }));
    return Charts.lineChart({ series: [{ name: 'Rank-pisteet', cls: 4, points: pts }], xKind: 'time', width: 640, height: 220, yFormat: (v) => num(v), label: 'Rank-pisteiden kehitys' });
  }

  // name: pelaajan nimi (Ubisoft). opts.platform: oletus uplay. Palauttaa kortin, joka hakee itse (välimuisti suojaa kutsubudjettia).
  function section(name, opts = {}) {
    let platform = opts.platform || 'uplay';
    let summary = null, profile = null;      // viimeisimmät tulokset
    let err = null, profileErr = null;       // virheet, kun tulosta ei ole
    let busy = true, busyProfile = false;
    let token = 0;
    const box = h('div', { class: 'card arz-section', data: { name: String(name || '') } });
    const self = { box, soft: () => load('view') };

    const platSeg = U.seg(PLATFORMS, platform, (v) => { platform = v; summary = profile = null; err = profileErr = null; load('view'); });

    function noKeyBox() {
      return h('div', { class: 'arz-nokey' },
        h('div', { class: 'sub', text: 'Rank, rank-pisteet, kausitilastot ja rank-pisteiden historia mille tahansa pelaajalle ilmaisella Arenyze-avaimella: luo tili osoitteessa r6.arenyze.com → dashboard → API key → liitä avain Asetuksiin (R6-tilastot).' }),
        nav ? h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: () => nav.openSettings() }, 'Avaa asetukset')) : null);
    }
    function head() {
      if (err && err.code === 'NO_KEY' && !summary) return h('div', { class: 'row arz-head' }, h('h2', { text: 'Ubisoftin tilastot (Arenyze)' }));
      const age = summary ? (summary.error ? `päivitys epäonnistui, tulos ${ageText(summary.ageMs)}` : `haettu ${ageText(summary.ageMs)}`) : '';
      return h('div', { class: 'row arz-head' }, h('h2', { text: 'Ubisoftin tilastot (Arenyze)' }),
        platSeg,
        age ? h('span', { class: 'sub arz-age', text: age }) : null,
        h('button', { class: 'btn ghost small arz-refresh', type: 'button', disabled: busy, onclick: () => load('refresh') }, 'Päivitä'));
    }
    function body() {
      if (err && !summary) {
        if (err.code === 'NO_KEY') return noKeyBox();
        return h('div', { class: 'arz-err' }, h('div', { class: 'sub warn', text: msg(err) }),
          err.code === 'BUDGET' || err.code === 'RATE_LIMIT' ? h('div', { class: 'sub', text: 'Voit hakea käsin Päivitä-napilla.' }) : null);
      }
      if (!summary) return [skel('100%', 80), skel('100%', 140)];
      const d = summary.data;
      const out = [];
      if (summary.error) out.push(h('div', { class: 'sub warn', text: `Päivitys epäonnistui: ${summary.error.message} Näytetään tallennettu tulos.` }));
      else if (summary.note) out.push(h('div', { class: 'sub warn', text: summary.note }));
      if (!d.hasData) {
        out.push(h('div', { class: 'sub', text: `Pelaajaa löytyi, mutta rankattuja tilastoja ei ole${d.level != null ? ` (taso ${num(d.level)})` : ''}.` }));
        return out;
      }
      const wl = d.wins == null && d.losses == null ? '–' : `${num(d.wins)} - ${num(d.losses)}`;
      out.push(h('div', { class: 'tiles arz-tiles' },
        R6Ui.tile('Rank', d.rankName || (d.rank ? `Rank ${d.rank}` : '–'), `arz-rank-tile ${tierCls(d.rankTier)}`, `${num(d.rankPoints)} RP${d.seasonCode ? ` · ${d.seasonCode}` : ''}`),
        R6Ui.tile('Huipparank', d.maxRankName || (d.maxRank ? `Rank ${d.maxRank}` : '–'), 'sm', d.maxRankPoints == null ? null : `${num(d.maxRankPoints)} RP`),
        R6Ui.tile('K/D (kausi)', dec(d.kd), '', `${num(d.kills)} / ${num(d.deaths)}`),
        R6Ui.tile('Voitot - häviöt', wl, 'sm', d.winrate == null ? null : `voitto-% ${pct(d.winrate)}`),
        R6Ui.tile('Ottelut', num(d.matches), '', d.abandons ? `${num(d.abandons)} keskeytystä` : null),
        R6Ui.tile('HS %', pct(d.hsPercent), '', d.hsPercent == null ? 'ei tietoa' : 'operaattoreista'),
        d.level != null ? R6Ui.tile('Taso', num(d.level), '', d.hoursPlayed != null ? `${num(d.hoursPlayed)} h pelattu` : null) : null));
      if (profile && profile.data.banned && profile.data.banned.isBanned) out.push(h('div', null, h('span', { class: 'chip warn', text: 'Ubisoftin porttikielto voimassa' })));
      // Epätavalliset tilastot kausitilastoista
      out.push(h('div', { class: 'row arz-susp' }, h('span', { class: 'sub', text: 'Ubisoftin kausitilastoista (Arenyze):' }),
        summary.suspicion ? Suspicion.node(summary.suspicion, { showNone: true, open: summary.suspicion.level !== 'none' }) : h('span', { class: 'sub', text: 'Indikaattori on pois päältä (Asetukset > Herkkyys).' })));
      // Rank-pisteiden historia (profiili)
      out.push(h('div', { class: 'arz-history' }, h('div', { class: 'sub', text: 'Rank-pisteiden kehitys' }),
        profile ? historyChart(profile.data) : (profileErr ? h('div', { class: 'sub warn', text: `Historiaa ei voitu hakea: ${msg(profileErr)}` }) : (busyProfile ? skel('100%', 120) : h('div', { class: 'chart chart-empty', text: 'Ei vielä tarpeeksi dataa' })))));
      const st = seasonTable(d.seasons || []);
      out.push(h('div', { class: 'two-col stack-narrow' },
        h('div', null, h('div', { class: 'sub', text: 'Parhaat operaattorit (ranked)' }), d.operators && d.operators.length ? opTable(d.operators) : h('div', { class: 'sub', text: 'Ei operaattoritietoja.' })),
        h('div', null, h('div', { class: 'sub', text: 'Kaudet' }), st || h('div', { class: 'sub', text: 'Ei kausitietoja.' }))));
      out.push(h('div', { class: 'sub', text: NOTE }));
      return out;
    }
    function draw() { fill(box, head(), body()); }

    // mode: 'view' (välimuisti, noudattaa pehmeää rajaa) | 'refresh' (Päivitä: ohittaa TTL:n ja rajan)
    async function load(mode) {
      const my = ++token;
      if (!String(name || '').trim()) { err = Object.assign(new Error('Pelaajan nimeä ei ole asetettu.'), { code: 'BAD_INPUT' }); busy = false; draw(); return; }
      busy = true; err = null; profileErr = null;
      draw();
      try { summary = await lookup({ name, platform, kind: 'summary', mode }); } catch (e) { if (my !== token) return; err = e; summary = null; }
      if (my !== token) return;
      busy = false;
      busyProfile = !!summary;
      draw();
      if (summary) {
        try { profile = await lookup({ name, platform, kind: 'profile', mode }); } catch (e) { if (my !== token) return; profileErr = e; profile = null; }
        if (my !== token) return;
        busyProfile = false;
        draw();
      }
    }
    sections.add(self);
    load('view');
    return box;
  }
  // Pääprosessi ilmoittaa haun valmistumisesta: päivitä näkyvät osiot välimuistista (ei verkkokutsua tuoreelle tulokselle).
  window.api.onArenyzeUpdate(() => {
    for (const s of Array.from(sections)) { if (!s.box.isConnected) sections.delete(s); else s.soft(); }
  });

  window.ArzUi = { init, section, liveCell, rankChip, ageText, lookup, PLATFORMS, msg };
})();
