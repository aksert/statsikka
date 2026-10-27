'use strict';
// Rainbow Six Siege: Live-peli. Kaksi lähdettä:
//  - Overwolf GEP (jos käytössä): rosteri näkyy heti ottelun alussa, ennen ensimmäisen kierroksen tallennetta. GEP on live-lähde ottelun ajan.
//  - Ottelutallenteet: käynnissä oleva (tai viimeisin) ottelu; päivittyy jokaisen kierroksen jälkeen. Antaa mm. päänlaukaukset ja HS-%.
// GEP-pelaajat yhdistetään tallenteiden historiaan player_id:llä (= tallenteen profileID).
(function () {
  const { h, fill, skel } = U;
  const R = R6Ui;

  const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (_m, a, b) => a + b.toUpperCase());
  const kdOf = (k, d) => (Number(d) > 0 ? Math.round((Number(k) / Number(d)) * 100) / 100 : Number(k) || 0);

  // GEP-rosteri -> samanmuotoinen "ottelu" kuin tallenteista (R6Ui.scoreboard / liveSummary käyttävät sitä).
  function gepMatch(g) {
    const players = (g.roster || []).map((p) => ({
      username: p.name, profileID: p.playerId, key: p.key, isOwn: !!p.isOwn, teamIndex: p.team === 'orange' ? 1 : 0,
      operators: p.operator ? [{ name: p.operator, rounds: 0 }] : [],
      kills: p.kills == null ? 0 : p.kills, deaths: p.deaths == null ? 0 : p.deaths, assists: p.assists == null ? 0 : p.assists, score: p.score == null ? 0 : p.score,
      kd: kdOf(p.kills, p.deaths), hsPercent: p.replay ? p.replay.hsPercent : null, health: p.health, hist: p.hist, prev: p.prev, suspicion: p.suspicion, arz: p.arz,
    }));
    const sc = g.score || {};
    return {
      name: g.key, players, teams: [{ score: Number(sc.blue) || 0 }, { score: Number(sc.orange) || 0 }], ownTeamIndex: 0,
      hasScore: players.some((p) => p.score > 0), hasAssists: players.some((p) => p.assists > 0), hasHealth: players.some((p) => p.health != null), hasArz: players.some((p) => !!p.arz),
      prevMatch: g.prevMatch || null, roundsParsed: Number(g.round) || 0,
      map: g.map ? { name: titleCase(g.map) } : null, gamemode: g.mode ? { name: titleCase(g.mode) } : null, matchType: null,
    };
  }
  // Arenyze-sarakkeen selite pistetaulun alle (vain kun sarake on näkyvissä).
  const arzNote = (m) => (m.hasArz ? h('div', { class: 'sub arz-note', text: '"Ranked (Arenyze)" näyttää pelaajan rankin, rank-pisteet, kauden K/D:n ja voitot–häviöt Ubisoftin kausitilastoista (Arenyze-rajapinta, ei ottelukohtaista historiaa). Tulokset haetaan kerran ottelua kohden ja tallennetaan välimuistiin 6 h; kuukauden pehmeä raja suojaa kutsubudjettia (Asetukset). Merkki ei ole todiste huijaamisesta.' }) : null);
  function killFeed(g) {
    const last = (g.killFeed || []).slice(-8).reverse();
    if (!last.length) return null;
    return h('div', { class: 'card r6-feed' }, h('h2', { text: 'Tappofeed' }),
      last.map((k) => h('div', { class: 'sub', text: `${k.attacker || '?'} → ${k.victim || '?'}${k.headshot ? ' (päähän)' : ''}${k.weapon ? ` · ${k.weapon.replace(/_/g, ' ')}` : ''}` })));
  }

  function create(ctx) {
    const statusBox = h('div');
    const body = h('div', { class: 'view-pane' });
    // Ilman Overwolf GEP:iä R6-pelaajat tulevat vasta 1. kierroksen tallenteesta: kerrotaan se ja mistä asia korjataan.
    const gepHint = U.gepHint('Pelaajat näkyvät heti ottelun alussa, kun Overwolf-kehittäjäavain on asetettu (Asetukset → Overwolf). Ilman sitä R6-pelaajat näkyvät 1. kierroksen jälkeen.', () => ctx.openOverwolfSettings());
    const updateGepHint = () => { gepHint.hidden = !(ctx.gepActive && ctx.gepActive('r6') === false); };
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Live-peli' }), statusBox), gepHint, body);
    let timer = null;
    let token = 0;
    let dirty = true;
    let lastData = null;
    let gepShown = false;

    const gepLive = () => { const s = ctx.gep && ctx.gep(); return s && s.r6 && s.r6.live ? s.r6 : null; };

    // Peli on käynnissä mutta ottelutallennetta ei vielä ole: R6 kirjoittaa tallenteen vasta 1. kierroksen päätyttyä.
    function waitingBanner(d) {
      const running = ctx.gameState && ctx.gameState().r6;
      if (!running || d.active) return null;
      return h('div', { class: 'banner r6-waiting', role: 'status' },
        h('strong', { text: 'Peli käynnissä – ottelun tiedot näkyvät 1. kierroksen jälkeen.' }),
        h('div', { class: 'sub', text: 'Rainbow Six tallentaa ottelun vasta kierroksen päätyttyä (noin 3–4 min ottelun alusta). Näkymä päivittyy ja avautuu itsestään, kun ensimmäinen kierros on tallentunut.' }));
    }

    function drawGep(g) {
      gepShown = true;
      const m = gepMatch(g);
      const replayRounds = lastData && lastData.active && lastData.match ? lastData.match.roundsParsed : 0;
      const round = g.round != null ? g.round : (replayRounds || null);
      fill(statusBox, h('span', { class: 'status-pill' }, h('span', { class: `status-dot ${g.active ? 'connected' : 'waiting'}` }),
        g.active ? 'Käynnissä' : 'Ottelu alkamassa', h('span', { class: 'sub', text: 'Live: Overwolf GEP' })));
      fill(body,
        h('div', { class: 'scorebar r6-scorebar' },
          h('div', { class: 'side blue' }, h('span', { class: 'sn', text: 'Oma tiimi' }), h('span', { class: 'sc mono', text: String(m.teams[0].score) })),
          h('div', { class: 'mid' },
            h('div', { class: 'clock mono', text: round == null ? 'Kierros –' : `Kierros ${round}` }),
            h('div', { class: 'meta', text: R.metaText(m) || '–' })),
          h('div', { class: 'side orange' }, h('span', { class: 'sn', text: 'Vastustaja' }), h('span', { class: 'sc mono', text: String(m.teams[1].score) }))),
        R.liveSummary(m),
        R.scoreboard(m, { history: true }),
        arzNote(m),
        killFeed(g),
        h('div', { class: 'sub', text: 'Live-tiedot (tapot, kuolemat, pisteet, terveys) tulevat Overwolfin Game Events Providerilta. "Aiemmin" näyttää, montako ottelua olet pelannut pelaajan kanssa tai häntä vastaan sekä hänen tilastonsa kaikista tallenteistasi; HS-% täydentyy tallenteesta kierrosten tallentuessa. "Edellinen" -merkki kertoo, oliko pelaaja edellisessä ottelussasi kanssasi vai vastaan.' }));
    }

    function draw(d) {
      lastData = d;
      const gl = gepLive();
      if (gl) { drawGep(gl); return; }
      gepShown = false;
      const m = d.match;
      const empty = R.emptyState({ scanning: d.scanning, matchCount: d.hasData ? 1 : 0, dirFound: d.dirFound }, ctx);
      const waiting = waitingBanner(d);
      if (!m || empty) {
        fill(statusBox);
        fill(body, waiting, empty || h('div', { class: 'empty' }, h('h3', { text: 'Ei ottelua' })));
        return;
      }
      fill(statusBox, h('span', { class: 'status-pill' }, h('span', { class: `status-dot ${d.active ? 'connected' : ''}` }),
        d.active ? 'Käynnissä' : 'Viimeisin ottelu', h('span', { class: 'sub', text: m.ts ? R.dateTime(m.ts) : '' })));
      const oi = m.ownTeamIndex === 0 || m.ownTeamIndex === 1 ? m.ownTeamIndex : 0;
      const known = m.ownTeamIndex === 0 || m.ownTeamIndex === 1;
      const sc = (i) => (m.teams[i] && Number.isFinite(m.teams[i].score) ? m.teams[i].score : 0);
      const rounds = m.roundsParsed;
      m.hasArz = (m.players || []).some((p) => !!p.arz);
      fill(body,
        waiting,
        h('div', { class: 'scorebar r6-scorebar' },
          h('div', { class: 'side blue' }, h('span', { class: 'sn', text: known ? 'Oma tiimi' : 'Tiimi 1' }), h('span', { class: 'sc mono', text: String(sc(oi)) })),
          h('div', { class: 'mid' },
            h('div', { class: 'clock mono', text: `Kierros ${rounds}` }),
            h('div', { class: 'meta', text: R.metaText(m) || '–' })),
          h('div', { class: 'side orange' }, h('span', { class: 'sn', text: known ? 'Vastustaja' : 'Tiimi 2' }), h('span', { class: 'sc mono', text: String(sc(1 - oi)) }))),
        d.active ? null : h('div', { class: 'banner', text: `Ottelu päättyi: ${R.resultText(m.result)} (${R.scoreText(m, true)}).` }),
        R.liveSummary(m),
        R.scoreboard(m, { history: true }),
        arzNote(m),
        h('div', { class: 'sub', text: `"Aiemmin" näyttää, montako ottelua olet pelannut pelaajan kanssa tai häntä vastaan sekä hänen tilastonsa kaikista tallenteistasi. "Edellinen" -merkki kertoo, oliko pelaaja edellisessä ottelussasi kanssasi vai vastaan. Perustuu vain omiin ottelutallenteisiisi.${m.hasAdv ? ' KOST, Entry (tapot–kuolemat), Trade ja Clutch lasketaan tämän ottelun jo tallentuneista kierroksista.' : ''}` }));
    }

    async function load() {
      const my = ++token;
      dirty = false;
      updateGepHint();
      try {
        const d = await U.unwrap(window.api.r6Live());
        if (my !== token) return;
        draw(d);
      } catch (e) {
        if (my !== token) return;
        fill(body, h('div', { class: 'errbox' }, h('h3', { text: 'Live-näkymän lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    if (ctx.onGame) ctx.onGame(() => { if (lastData && R.visible(el)) draw(lastData); });
    // GEP-päivitys (rajoitettu 250 ms pääprosessissa): piirrä uudelleen; kun GEP-ottelu päättyy, palaa tallennenäkymään.
    if (ctx.onGep) ctx.onGep(() => {
      updateGepHint();
      if (!R.visible(el)) { dirty = true; return; }
      const gl = gepLive();
      if (gl) drawGep(gl);
      else if (gepShown) { if (lastData) draw(lastData); load(); }
    });
    const onUpdate = () => {
      dirty = true;
      if (!R.visible(el)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    };
    window.api.onR6Update(onUpdate);
    window.api.onArenyzeUpdate(onUpdate); // Arenyze-haku valmistui: GEP-rivit tulevat gep:update-tapahtumana, tallennenäkymä ladataan uudelleen

    fill(body, skel('100%', 90), skel('100%', 240));
    return { el, onShow: load, reload: load, isDirty: () => dirty };
  }

  window.R6Live = { create };
})();
