'use strict';
// Oma profiili: oman tilin tilastot ja kehitys peleittäin (OW2, Rocket League, R6).
// create(ctx) = kooste (kaikki pelit); create(ctx, { game }) = yhden pelin "Oma profiili" -välilehti (kirjautumiskortti, uloskirjaus).
(function () {
  const { h, fill, num, dec, pct, wrClass, dateTime, img, skel, ROLE_FI } = U;

  const ROLE_CLS = { tank: 0, damage: 1, support: 2, open: 3 };
  const RL_CLS = { duel: 0, doubles: 1, standard: 2, other: 3 };
  const RL_PLATFORM = { epic: 'Epic Games', steam: 'Steam', psn: 'PlayStation', xbox: 'Xbox', switch: 'Switch' };
  const ROMAN = ['I', 'II', 'III', 'IV'];

  const pc = (n) => `${Number.isInteger(n) ? n : String(Math.round(n * 10) / 10).replace('.', ',')} %`;
  function levels(n) {
    if (n == null) return '–';
    if (n === 0) return 'ei muutosta';
    const a = Math.abs(n);
    return `${n > 0 ? '+' : '−'}${a} ${a === 1 ? 'taso' : 'tasoa'}`;
  }
  const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;

  function tile(label, value, cls, sub) {
    return h('div', { class: 'tile' }, h('div', { class: 'tl', text: label }), h('div', { class: `tv ${cls || ''}`, text: value }), sub ? h('div', { class: 'ts', text: sub }) : null);
  }
  function select(options, value, onChange) {
    const sel = h('select', { class: 'input' }, options.map(([v, l]) => h('option', { value: String(v) }, l)));
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function create(ctx, opts = {}) {
    const game = opts.game || null;   // 'ow' | 'rl' | 'r6' | null (kooste)
    let editing = false;              // "Vaihda profiili" auki
    let data = null;
    let token = 0;
    let owLoading = false;
    const rlForm = { playlist: 'standard', rank: '8', division: '1', mmr: '', nextMmr: '' };

    const body = h('div', { class: 'view-pane own-dash' });
    const refreshBtn = h('button', { class: 'btn ghost small', type: 'button', onclick: () => refreshAll() }, 'Päivitä');
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Oma profiili' }), refreshBtn), body);

    // ---- Yhteiset osat
    function addCard(title) {
      return h('div', { class: 'card add-card' },
        h('h2', { text: title }),
        h('p', { text: 'Lisää oma profiili asetuksista' }),
        h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto('settings') }, 'Avaa asetukset'));
    }
    function secHead(game, ...chips) {
      return h('div', { class: 'row sec-head' }, h('h2', { class: 'sec-title', text: game }), chips);
    }
    const chip = (t) => h('span', { class: 'chip', text: t });

    // ---- Overwatch 2
    function progressBlock(r) {
      const pr = r.progress;
      const out = [];
      if (pr && !pr.stale) {
        out.push(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pr.lastPercent) },
          h('div', { class: 'bar-fill' })));
        out.push(h('div', { class: 'rc-need', text: `${pc(pr.remaining)} jäljellä` }));
        if (pr.winsNeeded != null) {
          out.push(h('div', { class: 'rc-wins', text: `noin ${num(pr.winsNeeded)} voittoa seuraavaan rankiin (arvio)` }));
          out.push(h('div', { class: 'sub', text: `Arvio: ~${dec(pr.perWin, 1)} %-yks. / voitto, ${pr.samples} jaksoa omista merkinnöistäsi.` }));
        } else {
          out.push(h('div', { class: 'sub', text: 'Voittoarvio tulee, kun kirjaat edistymisen vähintään kahdesti saman rankin sisällä ja pelien välillä on voittoja.' }));
        }
      } else if (pr && pr.stale) {
        out.push(h('div', { class: 'banner small', text: 'Rankki on vaihtunut viimeisen merkinnän jälkeen. Kirjaa uusi edistyminen.' }));
      } else {
        out.push(h('div', { class: 'sub', text: 'Edistymisprosenttia ei saa automaattisesti (Blizzardin julkinen profiili ei kerro sitä). Kirjaa se käsin pelistä.' }));
      }
      const input = h('input', { class: 'input pct-input', type: 'number', min: '0', max: '100', step: '0.1', placeholder: '0–100', 'aria-label': `Edistyminen % (${ROLE_FI[r.role]})` });
      const form = h('form', { class: 'row pct-form', onsubmit: async (e) => {
        e.preventDefault();
        const v = Number(String(input.value).replace(',', '.'));
        if (input.value.trim() === '' || !Number.isFinite(v) || v < 0 || v > 100) { U.toast('Edistymisen pitää olla luku 0–100.', 'err'); return; }
        try {
          await U.unwrap(window.api.profileOwProgress({ role: r.role, percent: v }));
          U.toast('Edistyminen tallennettu.');
          load();
        } catch (err) { U.toast(U.errMsg(err), 'err'); }
      } },
      h('label', { class: 'sub', text: 'Edistyminen %' }), input, h('button', { class: 'btn small', type: 'submit' }, 'Tallenna'));
      out.push(form);
      if (r.entries.length) {
        out.push(h('ul', { class: 'entries' }, r.entries.slice(0, 3).map((e) => h('li', null,
          h('span', { class: 'mono', text: pc(e.percent) }),
          h('span', { class: 'sub', text: `${e.label} · ${dateTime(e.ts)}` }),
          h('button', { class: 'btn ghost small', type: 'button', title: 'Poista merkintä', 'aria-label': 'Poista merkintä', onclick: async () => {
            try { await U.unwrap(window.api.profileOwProgressDelete(e.id)); load(); } catch (err) { U.toast(U.errMsg(err), 'err'); }
          } }, 'Poista')))));
      }
      const wrap = h('div', { class: 'rc-progress' }, out);
      const fillEl = wrap.querySelector('.bar-fill');
      if (fillEl && pr) fillEl.style.width = `${Math.max(0, Math.min(100, pr.lastPercent))}%`;
      return wrap;
    }

    function roleCard(r) {
      const cur = r.current;
      const head = h('div', { class: 'rc-top' }, r.roleIcon ? img(r.roleIcon, 'role', ROLE_FI[r.role]) : null, h('div', { class: 'rl', text: ROLE_FI[r.role] || r.role }));
      if (!cur) return h('div', { class: 'card ow-rank-card' }, head, h('div', { class: 'rv', text: 'Ei sijoitusta' }), h('div', { class: 'sub', text: 'Pelaa sijoituspelit tälle roolille.' }));
      return h('div', { class: 'card ow-rank-card' }, head,
        h('div', { class: 'rc-main' }, r.rankIcon ? img(r.rankIcon, 'tier', cur.label) : null,
          h('div', null, h('div', { class: 'rv big', text: cur.label }),
            h('div', { class: 'sub rc-next', text: r.atTop ? 'Ylin rankki saavutettu' : `Seuraava: ${r.next.label}` }))),
        r.atTop ? null : progressBlock(r));
    }

    function deltaCard(title, dl) {
      if (!dl) return h('div', { class: 'card' }, h('h2', { text: title }), h('div', { class: 'sub', text: 'Ei vielä mittauksia.' }));
      const ranks = Object.entries(dl.rankChange).filter(([, v]) => v != null);
      return h('div', { class: 'card' }, h('h2', { text: title }),
        h('div', { class: 'delta-grid' },
          h('div', null, h('div', { class: 'tl', text: 'Voitot' }), h('div', { class: 'dv win', text: signed(dl.wins) })),
          h('div', null, h('div', { class: 'tl', text: 'Häviöt' }), h('div', { class: 'dv loss', text: signed(dl.losses) })),
          h('div', null, h('div', { class: 'tl', text: 'Pelit' }), h('div', { class: 'dv', text: signed(dl.games) }))),
        ranks.length ? h('ul', { class: 'entries' }, ranks.map(([role, v]) => h('li', null,
          h('span', { text: ROLE_FI[role] || role }), h('span', { class: `mono ${v > 0 ? 'win' : v < 0 ? 'loss' : ''}`, text: levels(v) })))) : h('div', { class: 'sub', text: 'Ei rankkimuutoksia.' }),
        dl.partial ? h('div', { class: 'sub', text: `Laskettu ensimmäisestä mittauksesta (${dateTime(dl.since)}).` }) : null,
        dl.seasonChanged ? h('div', { class: 'sub', text: 'Kausi vaihtui jakson aikana.' }) : null);
    }

    function owCharts(d) {
      const o = d.ow;
      const snaps = o.snapshots;
      const label = (v) => (d.ladder[v] ? d.ladder[v].label : String(v));
      const markers = [];
      for (let i = 1; i < snaps.length; i++) {
        if (snaps[i].season != null && snaps[i - 1].season != null && snaps[i].season !== snaps[i - 1].season) markers.push({ x: snaps[i].ts, label: `Kausi ${snaps[i].season}` });
      }
      const roleKeys = o.roles.map((r) => r.role);
      const rankSeries = roleKeys.map((role) => ({
        name: ROLE_FI[role] || role, cls: ROLE_CLS[role], step: true,
        points: snaps.filter((s) => s.ranks[role]).map((s) => ({ x: s.ts, y: s.ranks[role].value, title: `${dateTime(s.ts)}: ${ROLE_FI[role]} ${label(s.ranks[role].value)}` })),
      }));
      const wr = [{ name: 'Voitto-%', cls: 4, points: snaps.filter((s) => Number.isFinite(s.winrate)).map((s) => ({ x: s.ts, y: s.winrate, title: `${dateTime(s.ts)}: ${pct(s.winrate)}` })) }];
      const kd = [{ name: 'K/D', cls: 3, points: snaps.filter((s) => Number.isFinite(s.kd)).map((s) => ({ x: s.ts, y: s.kd, title: `${dateTime(s.ts)}: K/D ${dec(s.kd)}` })) }];
      return [
        h('div', { class: 'card' }, h('h2', { text: 'Rankki ajan mittaan' }),
          Charts.lineChart({ series: rankSeries, xKind: 'time', yTicks: d.ladder, yPad: 0.6, markers, label: 'Rankki ajan mittaan' })),
        h('div', { class: 'two-col' },
          h('div', { class: 'card' }, h('h2', { text: 'Voitto-% ajan mittaan' }),
            Charts.lineChart({ series: wr, xKind: 'time', width: 520, height: 240, yFormat: (v) => `${Math.round(v)} %`, markers, label: 'Voitto-prosentti ajan mittaan' })),
          h('div', { class: 'card' }, h('h2', { text: 'K/D ajan mittaan' }),
            Charts.lineChart({ series: kd, xKind: 'time', width: 520, height: 240, yFormat: (v) => dec(v), markers, label: 'K/D ajan mittaan' }))),
      ];
    }

    function owSection(d) {
      const o = d.ow, p = o.profile;
      const loading = owLoading || (!o.fetchedAt && !o.error);
      const out = [secHead('Overwatch 2', chip(o.platform === 'pc' ? 'PC' : 'Konsoli'), o.season != null ? chip(`Kausi ${o.season}`) : null,
        o.fetchedAt ? h('span', { class: 'sub', text: `Päivitetty ${dateTime(o.fetchedAt)}` }) : null)];
      out.push(h('div', { class: 'card profile-head' },
        p && p.namecard ? img(p.namecard, 'namecard') : null,
        p ? img(p.avatar, 'avatar', p.name) : null,
        h('div', null, h('div', { class: 'ph-name', text: p ? p.name : o.battletag }), h('div', { class: 'sub', text: p ? (p.title || o.battletag) : o.battletag }),
          p && p.hasStats ? h('div', { class: 'row', style: null }, Suspicion.node(p.suspicion, { showNone: true })) : null)));
      if (o.error) {
        out.push(h('div', { class: 'errbox' }, h('h3', { text: o.error.code === 'NOT_FOUND' ? 'Pelaajaa ei löytynyt' : 'Profiilin haku epäonnistui' }),
          h('div', { text: U.errMsg(o.error) }),
          o.snapshots.length ? h('div', { class: 'sub', text: 'Näytetään viimeksi tallennettu data.' }) : null));
      } else if (loading) {
        out.push(h('div', { class: 'banner', text: 'Haetaan profiilia…' }));
      } else if (p && !p.hasStats) {
        out.push(h('div', { class: 'banner', text: p.isPrivate
          ? 'Profiili on yksityinen. Aseta se julkiseksi (Overwatch: Asetukset > Sosiaalinen > Profiilin näkyvyys), niin tilastot ja rankit näkyvät.'
          : 'Kilpailullisia tilastoja ei löytynyt valitulle alustalle. Tarkista alusta asetuksista.' }));
      }
      out.push(h('div', { class: 'rank-grid' }, o.roles.map(roleCard)));
      if (o.tiles) {
        const t = o.tiles;
        out.push(h('div', { class: 'tiles' },
          tile('Voitot', num(t.wins), 'win'), tile('Häviöt', num(t.losses), 'loss'), tile('Voitto-%', pct(t.winrate), wrClass(t.winrate)),
          tile('K/D', dec(t.kd), '', 'tapot / kuolemat'), tile('Eniten tappoja pelissä', num(t.mostElims)), tile('Pelit', num(t.games), '', 'kilpailullinen')));
      }
      if (p && p.hasStats) out.push(Suspicion.accuracyCard(p.accuracy));
      out.push(h('div', { class: 'two-col' }, deltaCard('Tällä viikolla', o.deltas.week), deltaCard('Tässä kuussa', o.deltas.month)));
      out.push(owCharts(d));
      return h('section', { class: 'game-section ow-section' }, out);
    }

    // ---- Rocket League
    function rlRankForm(d) {
      const host = h('div');
      const latest = (key) => { const pl = d.rl.playlists.find((x) => x.key === key); return pl && pl.entries.length ? pl.entries[pl.entries.length - 1] : null; };
      function draw() {
        const ssl = Number(rlForm.rank) === d.rlSsl;
        const mmr = h('input', { class: 'input', type: 'number', min: '0', max: '9999', step: '1', value: rlForm.mmr, placeholder: 'esim. 1050', 'aria-label': 'MMR (valinnainen)' });
        const next = h('input', { class: 'input', type: 'number', min: '0', max: '9999', step: '1', value: rlForm.nextMmr, placeholder: 'esim. 1100', 'aria-label': 'Seuraavan rajan MMR (valinnainen)' });
        mmr.addEventListener('input', () => { rlForm.mmr = mmr.value; });
        next.addEventListener('input', () => { rlForm.nextMmr = next.value; });
        const form = h('form', { class: 'form-grid rl-form', onsubmit: async (e) => {
          e.preventDefault();
          try {
            await U.unwrap(window.api.profileRlRank({ playlist: rlForm.playlist, rank: Number(rlForm.rank), division: Number(rlForm.division), mmr: rlForm.mmr, nextMmr: rlForm.nextMmr }));
            U.toast('Rankki tallennettu.');
            load();
          } catch (err) { U.toast(U.errMsg(err), 'err'); }
        } },
        h('label', { text: 'Pelilista' }), U.seg(d.rlPlaylists, rlForm.playlist, (v) => {
          rlForm.playlist = v;
          const l = latest(v);
          if (l) Object.assign(rlForm, { rank: String(l.rank), division: String(l.division), mmr: l.mmr != null ? String(l.mmr) : '', nextMmr: l.nextMmr != null ? String(l.nextMmr) : '' });
          draw();
        }),
        h('label', { text: 'Rankki' }), select(d.rlRanks.map((n, i) => [i, n]), rlForm.rank, (v) => { rlForm.rank = v; draw(); }),
        h('label', { text: 'Divisioona' }), ssl ? h('span', { class: 'sub', text: 'Supersonic Legendillä ei ole divisioonia' })
          : select([1, 2, 3, 4].map((n) => [n, ROMAN[n - 1]]), rlForm.division, (v) => { rlForm.division = v; }),
        h('label', { text: 'MMR (valinnainen)' }), mmr,
        h('label', { text: 'Seuraavan rajan MMR (valinnainen)' }), next,
        h('span'), h('div', null, h('button', { class: 'btn', type: 'submit' }, 'Tallenna rankki')));
        fill(host, form);
      }
      draw();
      return host;
    }

    function rlPlaylistCard(d, pl) {
      const cur = pl.current;
      const lines = [h('div', { class: 'rv big', text: cur.label }),
        cur.mmr != null ? h('div', { class: 'sub', text: `${num(cur.mmr)} MMR · kirjattu ${dateTime(cur.ts)}` }) : h('div', { class: 'sub', text: `Kirjattu ${dateTime(cur.ts)}` }),
        h('div', { class: 'sub rc-next', text: pl.atTop ? 'Ylin rankki saavutettu' : `Seuraava: ${pl.next.label}` })];
      if (pl.need) {
        const n = pl.need;
        if (n.need === 0) lines.push(h('div', { class: 'rc-need', text: 'Seuraavan rajan MMR on jo saavutettu.' }));
        else {
          lines.push(h('div', { class: 'rc-need', text: `+${num(n.need)} MMR tarvitaan` }));
          lines.push(h('div', { class: 'rc-wins', text: `noin ${num(n.winsNeeded)} voittoa (arvio, ${n.derived ? `~${dec(n.gain, 1)} MMR/voitto omista merkinnöistäsi` : `~${d.rlDefaultGain} MMR/voitto`})` }));
        }
      } else if (!pl.atTop) {
        lines.push(h('div', { class: 'sub', text: 'Lisää MMR ja "Seuraavan rajan MMR" (näet sen yhteisön sivustoilta), niin lasken tarvittavat voitot.' }));
      }
      lines.push(h('ul', { class: 'entries' }, pl.entries.slice(-4).reverse().map((e) => h('li', null,
        h('span', { class: 'mono', text: e.label }),
        h('span', { class: 'sub', text: `${e.mmr != null ? `${num(e.mmr)} MMR · ` : ''}${dateTime(e.ts)}` }),
        h('button', { class: 'btn ghost small', type: 'button', title: 'Poista merkintä', 'aria-label': 'Poista merkintä', onclick: async () => {
          try { await U.unwrap(window.api.profileRlRankDelete(e.id)); load(); } catch (err) { U.toast(U.errMsg(err), 'err'); }
        } }, 'Poista')))));
      return h('div', { class: 'card rl-rank-card' }, h('h2', { text: pl.label }), lines);
    }

    function rlSection(d) {
      const r = d.rl, s = r.summary;
      const out = [secHead('Rocket League', chip(r.name), chip(RL_PLATFORM[r.platform] || r.platform))];
      if (s.counted === 0) {
        out.push(h('div', { class: 'banner', text: s.total > 0
          ? 'Otteluita on tallennettu, mutta niistä ei löytynyt omaa nimeäsi. Tarkista nimi asetuksista.'
          : 'Ei vielä otteluita. Ne tallentuvat automaattisesti, kun pelaat Rocket Leaguea sovelluksen ollessa auki ja Stats API on käytössä.' }));
      }
      const st = r.streak;
      out.push(h('div', { class: 'tiles' },
        tile('Voitot', num(s.wins), 'win', `${s.counted} ottelua`), tile('Häviöt', num(s.losses), 'loss'), tile('Voitto-%', pct(s.winrate), wrClass(s.winrate)),
        tile('Maalit / peli', dec(s.goalsPerGame)), tile('Torjunnat / peli', dec(s.savesPerGame)),
        tile('10 viimeisen voitto-%', pct(r.last10.winrate), wrClass(r.last10.winrate), r.last10.games ? `${r.last10.wins} / ${r.last10.games} voittoa` : null),
        tile('Putki', st ? num(st.count) : '–', st ? (st.type === 'win' ? 'win' : 'loss') : '', st ? (st.type === 'win' ? 'voittoa putkeen' : 'tappiota putkeen') : null)));
      out.push(h('div', { class: 'two-col' },
        h('div', { class: 'card' }, h('h2', { text: 'Voitto-% (liukuva, 10 peliä)' }),
          Charts.lineChart({ series: [{ name: 'Voitto-%', cls: 4, points: r.series.winrate.map((p) => ({ x: p.i, y: p.value, title: `Peli ${p.i} (${dateTime(p.ts)}): ${pct(p.value)}` })) }], xKind: 'index', width: 520, height: 240, yFormat: (v) => `${Math.round(v)} %`, label: 'Liukuva voitto-prosentti' })),
        h('div', { class: 'card' }, h('h2', { text: 'Maalit / peli (liukuva, 10 peliä)' }),
          Charts.lineChart({ series: [{ name: 'Maalit / peli', cls: 3, points: r.series.goals.map((p) => ({ x: p.i, y: p.value, title: `Peli ${p.i} (${dateTime(p.ts)}): ${dec(p.value)} maalia/peli` })) }], xKind: 'index', width: 520, height: 240, yFormat: (v) => dec(v, 1), label: 'Liukuva maalit per peli' }))));

      out.push(h('div', { class: 'card' }, h('h2', { text: 'Rankki (kirjataan käsin)' }),
        h('p', { class: 'sub', text: 'Rocket Leaguen Stats API ei kerro rankkia tai MMR:ää, joten kirjaa ne itse pelistä. MMR-arvion saat, kun lisäät myös seuraavan rajan MMR:n.' }),
        rlRankForm(d)));
      const withData = r.playlists.filter((pl) => pl.current);
      if (withData.length) {
        out.push(h('div', { class: 'rank-grid' }, withData.map((pl) => rlPlaylistCard(d, pl))));
        out.push(h('div', { class: 'card' }, h('h2', { text: 'Rankki ajan mittaan' }),
          Charts.lineChart({
            series: r.playlists.map((pl) => ({ name: pl.label, cls: RL_CLS[pl.key], step: true, points: pl.entries.map((e) => ({ x: e.ts, y: e.value, title: `${dateTime(e.ts)}: ${pl.label} ${e.label}${e.mmr != null ? ` · ${num(e.mmr)} MMR` : ''}` })) })),
            xKind: 'time', yTicks: d.rlLadder, yPad: 2, label: 'Rankki ajan mittaan',
          })));
      }
      return h('section', { class: 'game-section rl-section' }, out);
    }

    // ---- R6
    // Tilastot tulevat omista ottelutallenteista (R6Own hakee ne itse ja päivittyy r6:update-tapahtumista).
    const r6own = R6Own.create(ctx);
    // Oma Arenyze-osio (rank, RP, rank-historia): sama osio kuin pelaajapaneelissa, luodaan uudelleen vain nimen vaihtuessa.
    let arzNode = null, arzName = '';
    function r6Section(d) {
      r6own.reload();
      if (!arzNode || arzName !== d.r6.name) { arzName = d.r6.name; arzNode = window.ArzUi ? ArzUi.section(d.r6.name) : null; }
      return h('section', { class: 'game-section r6-section' }, secHead('Rainbow Six Siege', chip(d.r6.name), chip('Match Replay')), arzNode, r6own.el);
    }

    // ---- Kokonaisuus
    // Pelikohtainen välilehti: kirjautumiskortti tai sama osio kuin koosteessa + tilirivi.
    function accountBar(g, d) {
      const who = g === 'ow' ? d.ow.battletag : g === 'rl' ? d.rl.name : d.r6.name;
      return h('div', { class: 'card account-bar' }, h('div', { class: 'row' },
        h('span', { class: 'sub', text: 'Kirjautunut profiiliin:' }), h('strong', { text: who }),
        h('span', { class: 'spacer-x' }),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { editing = true; render(); } }, 'Vaihda profiili'),
        h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (await LinkCard.unlink(ctx, g)) { editing = false; load(); } } }, 'Kirjaudu ulos')));
    }
    function renderGame() {
      const d = data, g = game;
      if (!d[g].configured || editing) {
        if (body.querySelector('.link-card')) return; // lomake jo auki: taustapäivitys ei saa tyhjentää syötettyä tekstiä
        fill(body, LinkCard.create(ctx, g, {
          onSaved: () => { editing = false; load(); },
          onCancel: d[g].configured ? () => { editing = false; render(); } : null,
        }).el);
        return;
      }
      fill(body, accountBar(g, d), g === 'ow' ? owSection(d) : g === 'rl' ? rlSection(d) : r6Section(d));
    }
    function render() {
      const d = data;
      if (game) { renderGame(); return; }
      fill(body,
        d.ow.configured ? owSection(d) : addCard('Overwatch 2'),
        d.rl.configured ? rlSection(d) : addCard('Rocket League'),
        d.r6.configured ? r6Section(d) : addCard('Rainbow Six Siege'));
    }

    async function load() {
      const my = ++token;
      try {
        const next = await U.unwrap(window.api.profileGet());
        if (my !== token) return;
        data = next;
        render();
        ensureOw();
      } catch (e) {
        if (my !== token) return;
        fill(body, h('div', { class: 'errbox' }, h('h3', { text: 'Oman profiilin lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    // Jos profiilia ei ole vielä haettu tässä istunnossa, hae se (pääprosessin haku jaetaan).
    async function ensureOw() {
      const o = data && data.ow;
      if (!o || !o.configured || o.fetchedAt || o.error || owLoading || (game && game !== 'ow')) return;
      owLoading = true;
      try { await U.unwrap(window.api.profileOwRefresh()); } catch (_) { /* virhe näkyy kortissa latauksen jälkeen */ }
      owLoading = false;
      load();
    }
    async function refreshAll() {
      refreshBtn.disabled = true;
      try {
        if (data && data.ow.configured && (!game || game === 'ow')) {
          try { await U.unwrap(window.api.profileOwRefresh()); } catch (e) { U.toast(U.errMsg(e), 'err'); }
        }
        await load();
      } finally { refreshBtn.disabled = false; }
    }

    window.api.onProfileUpdate(() => { if (!el.hidden) load(); });
    // R6-nimi voi täyttyä itsestään, kun ensimmäinen ottelutallenne luetaan.
    window.api.onR6Update((d) => { if (d && d.settingsChanged && !el.hidden && (!game || game === 'r6')) load(); });
    fill(body, skel('100%', 120), skel('100%', 200));
    return { el, onShow: load, reload: load };
  }

  window.OwnProfile = { create };
})();
