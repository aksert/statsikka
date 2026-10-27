'use strict';
// Overwatch 2: käsin syötettävä lobby (oma tiimi + viholliset).
(function () {
  const { h, fill, num, dec, pct, wrClass, rankText, img, skel } = U;
  const SLOTS = 5;
  const STORE_KEY = 'statsikka.lobby';
  const TAG_RE = /^[^\s#]{2,24}[#-]\d{3,8}$/u;

  function loadSaved() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && Array.isArray(v.ally) && Array.isArray(v.enemy)) {
        const fix = (a) => Array.from({ length: SLOTS }, (_, i) => (typeof a[i] === 'string' ? a[i].slice(0, 40) : ''));
        return { ally: fix(v.ally), enemy: fix(v.enemy) };
      }
    } catch (_) { /* ei tallennettua */ }
    return { ally: Array(SLOTS).fill(''), enemy: Array(SLOTS).fill('') };
  }
  function save(names) { try { localStorage.setItem(STORE_KEY, JSON.stringify(names)); } catch (_) { /* ohita */ } }

  function parseNames(text) {
    return String(text || '').split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean).slice(0, SLOTS);
  }

  function stat(label, value, cls) {
    return h('div', null, h('div', { class: 'l', text: label }), h('div', { class: `v ${cls || ''}`, text: value }));
  }

  const tagId = (t) => String(t || '').trim().replace('#', '-').toLowerCase();
  const ROLE_ICON = { tank: 'Tankki', damage: 'Vahinko', support: 'Tuki' };

  // Overwolf GEP:n live-luvut yhdelle pelaajalle (hero, K/D/A, vahinko, paranto).
  function liveStrip(p) {
    if (!p) return null;
    const kda = `${U.num(p.kills)} / ${U.num(p.deaths)} / ${U.num(p.assists)}`;
    return h('div', { class: 'live-strip', title: 'Live-tiedot Overwolf GEP:ltä' },
      p.hero ? h('span', { class: 'chip hero', text: `${p.hero}${p.role ? ` · ${ROLE_ICON[p.role]}` : ''}` }) : null,
      h('span', { class: 'chip mono', text: `K/D/A ${kda}` }),
      p.damage != null ? h('span', { class: 'chip mono', text: `Vahinko ${U.num(p.damage)}` }) : null,
      p.healed ? h('span', { class: 'chip mono', text: `Paranto ${U.num(p.healed)}` }) : null,
      p.mitigated ? h('span', { class: 'chip mono', text: `Torjuttu ${U.num(p.mitigated)}` }) : null);
  }
  const MODE_FI = { competitive: 'Kilpailullinen', quickplay: 'Pikapeli' }, PLAT_FI = { pc: 'PC', console: 'Konsoli' };

  function playerCard(p, onOpen, chip) {
    const t = p.tiles;
    const best = p.bestRank;
    return h('div', { class: 'pcard', role: 'button', tabindex: '0', title: 'Avaa koko profiili', onclick: onOpen, onkeydown: (e) => { if (e.key === 'Enter') onOpen(); } },
      h('div', { class: 'pcard-top' },
        img(p.avatar, 'avatar sm', p.name),
        h('div', { class: 'nm', text: p.name }),
        chip,
        h('div', { class: 'row', style: null },
          p.ranks.map((r) => img(r.roleIcon, 'ri', U.ROLE_FI[r.role])),
          best ? img(best.rankIcon, 'rk', rankText(best)) : null),
        h('span', { class: 'sub', text: best ? rankText(best) : 'Ei sijoitusta' })),
      Suspicion.node(p.suspicion, { compact: true }),
      p.hasStats
        ? [h('div', { class: 'pstats' },
          stat('Voitto-%', pct(t.winrate), wrClass(t.winrate)),
          stat('V / H', `${num(t.wins)} / ${num(t.losses)}`),
          stat('K/D', dec(t.kd)),
          stat('Eniten tappoja', num(t.mostElims))),
        h('div', { class: 'pheroes' }, p.heroes.slice(0, 3).map((x) => h('span', { class: 'chip' }, img(x.portrait, '', x.name), `${x.name} · ${num(x.games)}`)))]
        : h('div', { class: 'banner', text: p.isPrivate ? 'Profiili on yksityinen' : 'Ei tilastoja valitulle tilalle / alustalle' }));
  }

  function create(ctx) {
    const names = loadSaved();
    const profiles = { ally: Array(SLOTS).fill(null), enemy: Array(SLOTS).fill(null) }; // { state:'loading'|'ok'|'err', ... }
    let mode = 'competitive';
    let platform = 'pc';
    let busy = false;
    let defaults = null;
    let prevSession = null;      // edellinen lobby (istunto) viimeisimmän "Hae kaikki" -haun aikaan
    let prevMap = new Map();     // tagId -> 'ally' | 'enemy'
    // Overwolf GEP: live-rosteri täyttää lobbyn ja haku ajetaan kerran ottelua kohden.
    let live = new Map();        // tagId -> GEP-pelaaja (live-luvut)
    let appliedKey = '';         // ottelu, jonka rosterin nimet on viimeksi täytetty
    let appliedSig = '';         // viimeksi täytetyt nimet (merkkijonona): käyttäjän muokkaamia nimiä ei ylikirjoiteta saman ottelun aikana
    let autoFetchedKey = '';     // ottelu, jonka "Hae kaikki" on jo ajettu automaattisesti
    let autoTimer = null;
    let gepOw = null;

    function setPrev(prev) {
      prevSession = prev || null;
      prevMap = new Map();
      if (prev) {
        for (const t of prev.enemy || []) prevMap.set(tagId(t), 'enemy');
        for (const t of prev.ally || []) prevMap.set(tagId(t), 'ally');
      }
    }
    function chipFor(tag) {
      const side = prevSession && prevMap.get(tagId(tag));
      if (!side) return null;
      const title = `Edellisessä lobbyssa (${U.dateTime(prevSession.ts)}, ${MODE_FI[prevSession.mode] || ''}, ${PLAT_FI[prevSession.platform] || ''}): ${side === 'ally' ? 'kanssasi' : 'vastustajana'}`;
      return PlayerPanel.prevChip(side, title);
    }

    const hint = h('div', { class: 'banner ow-hint', hidden: true, role: 'status', text: 'Overwatch käynnissä – liitä pelaajien nimet' });
    const gepBox = h('div', { class: 'banner small gep-live', hidden: true, role: 'status' });
    // Ilman Overwolf GEP:iä lobby täytetään käsin: kerrotaan, miten pelaajat saadaan näkyviin heti ottelun alussa.
    const gepHint = U.gepHint('Pelaajat täyttyvät lobbyyn heti ottelun alussa, kun Overwolf-kehittäjäavain on asetettu (Asetukset → Overwolf). Ilman sitä liitä pelaajien nimet käsin.', () => ctx.openOverwolfSettings());
    const cols = {};
    ['ally', 'enemy'].forEach((team) => {
      const inputs = Array.from({ length: SLOTS }, (_, i) => h('input', {
        class: 'input slot-input', type: 'text', maxlength: '40', placeholder: `Pelaaja ${i + 1} (Nimi#1234)`, value: names[team][i], spellcheck: 'false',
        oninput: (e) => {
          names[team][i] = e.target.value.trim(); save(names);
          if (profiles[team][i] && profiles[team][i].state !== 'loading') { profiles[team][i] = null; renderCards(); } // vanha kortti ei vastaa enää nimeä
        },
        onkeydown: (e) => { if (e.key === 'Enter') fetchAll(); },
      }));
      const area = h('textarea', { class: 'input', placeholder: 'Liitä nimet pilkulla tai rivinvaihdolla eroteltuna', rows: '2', 'aria-label': 'Liitä nimet' });
      const fillBtn = h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
        const list = parseNames(area.value);
        if (!list.length) { U.toast('Ei nimiä liitettäväksi.', 'err'); return; }
        for (let i = 0; i < SLOTS; i++) { names[team][i] = list[i] || ''; inputs[i].value = names[team][i]; profiles[team][i] = null; }
        save(names); area.value = ''; renderCards();
      } }, 'Täytä paikat');
      cols[team] = { inputs, area, live: Array.from({ length: SLOTS }, () => h('div', { class: 'slot-live' })), cards: Array.from({ length: SLOTS }, () => h('div', { class: 'slot-card' })), sum: h('div') };
      cols[team].el = h('div', { class: `team-col ${team}` },
        h('h2', { text: team === 'ally' ? 'Oma tiimi' : 'Viholliset' }),
        h('label', { class: 'sub', text: 'Liitä nimet' }), area, h('div', null, fillBtn),
        inputs.map((inp, i) => h('div', { class: 'slot' }, inp, cols[team].live[i], cols[team].cards[i])),
        cols[team].sum);
    });

    const modeSeg = U.seg(OwProfile.MODES, mode, (v) => { mode = v; });
    const platSeg = U.seg(OwProfile.PLATFORMS, platform, (v) => { platform = v; });
    const fetchBtn = h('button', { class: 'btn', type: 'button', onclick: () => fetchAll() }, 'Hae kaikki');
    const clearBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      ['ally', 'enemy'].forEach((t) => { for (let i = 0; i < SLOTS; i++) { names[t][i] = ''; cols[t].inputs[i].value = ''; profiles[t][i] = null; } });
      save(names); renderCards();
    } }, 'Tyhjennä');

    const el = h('div', { class: 'view-pane' },
      hint,
      gepBox,
      gepHint,
      h('h1', { class: 'page-title', text: 'Live-lobby' }),
      h('div', { class: 'sub', text: 'Syötä pelaajien BattleTagit käsin tai ota käyttöön Overwolf GEP (Asetukset): silloin lobby täyttyy ja haetaan automaattisesti ottelun alussa. Nimet muistetaan seuraavaa kertaa varten.' }),
      h('div', { class: 'row' }, modeSeg, platSeg, fetchBtn, clearBtn),
      h('div', { class: 'lobby-grid' }, cols.ally.el, cols.enemy.el));

    function renderCards() {
      ['ally', 'enemy'].forEach((team) => {
        const ok = [];
        for (let i = 0; i < SLOTS; i++) {
          const st = profiles[team][i];
          const host = cols[team].cards[i];
          if (!st) { fill(host); continue; }
          if (st.state === 'loading') fill(host, h('div', { class: 'pcard state' }, skel('60%', 16), skel('100%', 34)));
          else if (st.state === 'err') fill(host, h('div', { class: 'pcard state err' }, st.message,
            st.retry ? h('div', null, h('button', { class: 'btn ghost small', onclick: () => fetchOne(team, i) }, 'Yritä uudelleen')) : null));
          else {
            fill(host, playerCard(st.profile, () => ctx.openProfile(names[team][i], { mode, platform, from: 'lobby' }), chipFor(names[team][i])));
            if (st.profile.hasStats) ok.push(st.profile.tiles);
          }
        }
        const avg = (k) => { const v = ok.map((t) => t[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
        fill(cols[team].sum, ok.length ? h('div', { class: 'team-sum' },
          h('div', null, h('div', { class: 'l', text: 'Keskimääräinen voitto-%' }), h('div', { class: `v ${wrClass(avg('winrate'))}`, text: pct(avg('winrate')) })),
          h('div', null, h('div', { class: 'l', text: 'Keskimääräinen K/D' }), h('div', { class: 'v', text: dec(avg('kd')) })),
          h('div', null, h('div', { class: 'l', text: 'Pelaajia datalla' }), h('div', { class: 'v', text: `${ok.length} / ${names[team].filter(Boolean).length}` }))) : null);
      });
      renderLive();
    }

    // Live-liuskat päivitetään erikseen (ei korttien uudelleenpiirtoa: auki olevat perusteet säilyvät).
    function renderLive() {
      ['ally', 'enemy'].forEach((team) => { for (let i = 0; i < SLOTS; i++) fill(cols[team].live[i], liveStrip(live.get(tagId(names[team][i])))); });
    }

    async function fetchOne(team, i) {
      const name = names[team][i];
      if (!name) { profiles[team][i] = null; return; }
      if (!TAG_RE.test(name)) { profiles[team][i] = { state: 'err', message: 'Anna BattleTag muodossa Nimi#1234.' }; renderCards(); return; }
      profiles[team][i] = { state: 'loading' };
      renderCards();
      try {
        const p = await U.unwrap(window.api.owProfile({ ref: name.replace('#', '-'), gamemode: mode, platform }));
        profiles[team][i] = { state: 'ok', profile: p };
      } catch (e) {
        profiles[team][i] = { state: 'err', message: U.errMsg(e), retry: e.code !== 'NOT_FOUND' && e.code !== 'BAD_INPUT' };
      }
      renderCards();
    }

    async function fetchAll() {
      if (busy) return;
      const has = names.ally.some(Boolean) || names.enemy.some(Boolean);
      if (!has) { U.toast('Syötä ainakin yksi BattleTag.', 'err'); return; }
      busy = true; fetchBtn.disabled = true;
      // Kirjaa lobby (kohtaamishistoria) ja hae edellinen lobby "Edellinen"-merkkejä varten ENNEN korttien hakua. Virhe ei estä hakua.
      const valid = (arr) => arr.filter((t) => TAG_RE.test(t));
      try {
        const r = await U.unwrap(window.api.owLobbyRecord({ mode, platform, ally: valid(names.ally), enemy: valid(names.enemy) }));
        setPrev(r.prev);
      } catch (_) { setPrev(null); }
      const jobs = [];
      ['ally', 'enemy'].forEach((team) => { for (let i = 0; i < SLOTS; i++) if (names[team][i]) jobs.push(fetchOne(team, i)); });
      await Promise.all(jobs); // pääprosessin rajoitin pitää rinnakkaisuuden 3:ssa
      busy = false; fetchBtn.disabled = false;
    }

    // ---- Overwolf GEP: rosteri -> lobby (oma tiimi / viholliset), live-luvut korteille ja automaattinen "Hae kaikki" kerran ottelua kohden
    const sigOf = (a, e) => `${a.join('|')}//${e.join('|')}`;
    function setSlots(team, list) {
      let changed = false;
      for (let i = 0; i < SLOTS; i++) {
        const v = list[i] || '';
        if (names[team][i] === v) continue;
        names[team][i] = v; cols[team].inputs[i].value = v; profiles[team][i] = null; // vanha kortti ei vastaa enää nimeä
        changed = true;
      }
      return changed;
    }
    function scheduleAuto(key) {
      clearTimeout(autoTimer);
      if (autoFetchedKey === key) return;
      autoTimer = setTimeout(() => {
        if (autoFetchedKey === key || !gepOw || gepOw.key !== key) return;
        if (busy) { scheduleAuto(key); return; }
        if (!names.ally.some(Boolean) && !names.enemy.some(Boolean)) return;
        autoFetchedKey = key;
        fetchAll();
      }, 1500); // rosteri täyttyy hiljalleen latausruudulla: odotetaan, että se on vakiintunut
    }
    function onGep(snap) {
      const g = snap && snap.ow;
      gepOw = g && g.live ? g : null;
      live = new Map();
      if (gepOw) {
        for (const p of gepOw.roster) if (p.battletag && !p.isLocal) live.set(tagId(p.battletag), p);
        const lb = gepOw.lobby || { ally: [], enemy: [] };
        const sig = sigOf(lb.ally, lb.enemy);
        const curSig = sigOf(names.ally.filter(Boolean), names.enemy.filter(Boolean));
        // Uusi ottelu tai käyttäjä ei ole muokannut automaattisesti täytettyjä nimiä -> päivitä paikat.
        if (gepOw.key !== appliedKey || curSig === appliedSig) {
          if (sig !== curSig) { const a = setSlots('ally', lb.ally), e = setSlots('enemy', lb.enemy); save(names); if (a || e) renderCards(); }
          appliedKey = gepOw.key; appliedSig = sig;
        }
        if (lb.ally.length + lb.enemy.length > 0) scheduleAuto(gepOw.key);
      }
      renderLive();
      updateHint();
    }
    function ownLine(g) {
      const me = g.roster.find((p) => p.isLocal);
      const meta = [g.map, g.mode, g.gameType ? g.gameType.replace(/_/g, ' ').toLowerCase() : ''].filter(Boolean).join(' · ');
      const skipped = g.lobby && g.lobby.skipped ? ` ${g.lobby.skipped} pelaajan BattleTag ei välity (ei haettavissa).` : '';
      return [h('strong', { text: 'Live: Overwolf GEP' }), ` – ${g.active ? 'ottelu käynnissä' : 'ottelu alkamassa'}${meta ? ` (${meta})` : ''}. `,
        me ? `Sinä: ${me.hero || '–'} · K/D/A ${U.num(me.kills)} / ${U.num(me.deaths)} / ${U.num(me.assists)}${me.damage != null ? ` · vahinko ${U.num(me.damage)}` : ''}.` : '', skipped];
    }
    renderCards();
    function updateHint() {
      const ow = !!(ctx.gameState && ctx.gameState().ow);
      hint.hidden = !ow || !!gepOw;
      gepBox.hidden = !gepOw;
      gepHint.hidden = !(ctx.gepActive && ctx.gepActive('ow') === false);
      if (gepOw) fill(gepBox, ownLine(gepOw)); else fill(gepBox);
    }
    if (ctx.onGame) ctx.onGame(updateHint);
    if (ctx.onGep) { ctx.onGep(onGep); if (ctx.gep && ctx.gep()) onGep(ctx.gep()); }
    updateHint();
    return {
      el,
      applySettings(s) {
        const d = `${s.owPlatform}|${s.owGamemode}`;
        if (d === defaults) return;
        defaults = d;
        platform = s.owPlatform; platSeg.set(platform);
        mode = s.owGamemode || 'competitive'; modeSeg.set(mode);
      },
      onShow() { updateHint(); },
    };
  }

  window.OwLobby = { create };
})();
