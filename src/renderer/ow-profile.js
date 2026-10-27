'use strict';
// Overwatch 2: pelaajahaku ja profiilisivu.
(function () {
  const { h, fill, num, dec, pct, wrClass, duration, dateTime, DIVISION_FI, ROLE_FI, rankText, img, skel } = U;

  const MODES = [['competitive', 'Kilpailullinen'], ['quickplay', 'Pikapeli']];
  const PLATFORMS = [['pc', 'PC'], ['console', 'Konsoli']];

  function tile(label, value, opts = {}) {
    return h('div', { class: `tile ${opts.big ? 'big' : ''}` },
      h('div', { class: 'tl', text: label }),
      h('div', { class: `tv ${opts.cls || ''}`, text: value }),
      opts.sub ? h('div', { class: 'ts', text: opts.sub }) : null);
  }

  function rankBox(role, r) {
    return h('div', { class: 'rank' },
      r && r.roleIcon ? img(r.roleIcon, 'role', ROLE_FI[role]) : null,
      r && r.rankIcon ? img(r.rankIcon, 'tier', rankText(r)) : null,
      h('div', null,
        h('div', { class: 'rl', text: ROLE_FI[role] || role }),
        h('div', { class: 'rv', text: rankText(r) })));
  }

  function renderProfile(p) {
    const byRole = {};
    p.ranks.forEach((r) => { byRole[r.role] = r; });
    const roleKeys = ['tank', 'damage', 'support'];
    if (byRole.open) roleKeys.push('open');

    const head = h('div', { class: 'card profile-head' },
      p.namecard ? img(p.namecard, 'namecard') : null,
      img(p.avatar, 'avatar', p.name),
      h('div', null,
        h('h1', { text: p.name }),
        h('div', { class: 'sub', text: p.title || 'Ei titteliä' }),
        h('div', { class: 'row', style: null },
          p.endorsement ? h('span', { class: 'chip', text: `Tuki-taso ${p.endorsement.level}` }) : null,
          h('span', { class: 'chip', text: p.platform === 'pc' ? 'PC' : 'Konsoli' }),
          h('span', { class: 'chip', text: p.gamemode === 'competitive' ? 'Kilpailullinen' : 'Pikapeli' }),
          p.season ? h('span', { class: 'chip', text: `Kausi ${p.season}` }) : null,
          p.ranks.length && p.rankPlatform !== p.platform ? h('span', { class: 'chip', text: `Sijoitukset: ${p.rankPlatform === 'pc' ? 'PC' : 'Konsoli'}` }) : null),
        Suspicion.node(p.suspicion, { showNone: true })),
      h('div', { class: 'ranks' }, roleKeys.map((k) => rankBox(k, byRole[k]))));

    const out = [head];
    if (!p.hasStats) {
      out.push(h('div', { class: 'banner' },
        p.isPrivate
          ? 'Profiili on yksityinen. Tilastot näkyvät vasta, kun pelaaja asettaa profiilinsa julkiseksi (Overwatch: Asetukset > Sosiaalinen > Profiilin näkyvyys).'
          : `Tilastoja ei löytynyt valitulle pelitilalle ja alustalle (${p.gamemode === 'competitive' ? 'Kilpailullinen' : 'Pikapeli'}, ${p.platform === 'pc' ? 'PC' : 'Konsoli'}). Kokeile toista valintaa. Jos profiili on yksityinen, tilastoja ei voi hakea.`));
      return out;
    }
    const t = p.tiles;
    out.push(h('div', { class: 'tiles' },
      tile('Voitot', num(t.wins), { cls: 'win', big: true }),
      tile('Häviöt', num(t.losses), { cls: 'loss', big: true }),
      tile('Voitto-%', pct(t.winrate), { cls: wrClass(t.winrate), big: true }),
      tile('K/D', dec(t.kd), { big: true, sub: 'tapot / kuolemat' }),
      tile('KDA', dec(t.kda), { big: true }),
      tile('Pelit', num(t.games), { sub: t.timePlayed ? `Peliaika ${duration(t.timePlayed)}` : null }),
      tile('Eniten tappoja pelissä', num(t.mostElims)),
      tile('Pisin tappoputki', num(t.bestStreak)),
      tile('Eniten final blowseja pelissä', num(t.mostFinalBlows))));

    out.push(Suspicion.accuracyCard(p.accuracy));
    const roleTable = h('div', { class: 'card' }, h('h2', { text: 'Roolit' }),
      p.roles.length ? h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Rooli', 'Pelit', 'Voitto-%', 'KDA', 'Peliaika'].map((x) => h('th', { text: x })))),
        h('tbody', null, p.roles.map((r) => h('tr', null,
          h('td', { text: ROLE_FI[r.role] || r.role }), h('td', { text: num(r.games) }),
          h('td', { class: wrClass(r.winrate), text: pct(r.winrate) }), h('td', { text: dec(r.kda) }),
          h('td', { text: duration(r.timePlayed) }))))) : h('div', { class: 'sub', text: 'Ei roolitietoja.' }));

    const top = p.heroes.slice(0, 10);
    const heroTable = h('div', { class: 'card' }, h('h2', { text: 'Parhaat hahmot (pelatun ajan mukaan)' }),
      top.length ? h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Hahmo', 'Peliaika', 'Pelit', 'Voitto-%', 'KDA'].map((x) => h('th', { text: x })))),
        h('tbody', null, top.map((x) => h('tr', null,
          h('td', null, h('div', { class: 'hero-cell' }, img(x.portrait, '', x.name), h('span', { text: x.name }))),
          h('td', { text: duration(x.timePlayed) }), h('td', { text: num(x.games) }),
          h('td', { class: wrClass(x.games > 0 ? x.winrate : null), text: x.games > 0 ? pct(x.winrate) : '–' }),
          h('td', { text: dec(x.kda) }))))) : h('div', { class: 'sub', text: 'Ei hahmotietoja.' }));
    out.push(h('div', { class: 'two-col stack-narrow' }, roleTable, heroTable));
    return out;
  }

  const SIDE_FI = { ally: 'Kanssasi', enemy: 'Vastaan' };
  const NOTE = 'Overwatchin julkinen profiili ei sisällä otteluhistoriaa – näytetään uran tilastot ja omat kohtaamisesi.';

  // "Kohtaamiset": lobbyt, joissa BattleTag on esiintynyt (Live-lobbyn "Hae kaikki" tallentaa jokaisen lobbyn).
  function encountersCard(p) {
    const body = h('div');
    const card = h('div', { class: 'card enc-card' }, h('h2', { text: 'Kohtaamiset' }), h('div', { class: 'sub', text: NOTE }), body);
    const tag = p.id && /^[^%|]+-\d+$/.test(p.id) ? p.id.replace(/-(\d+)$/, '#$1') : null;
    if (!tag) { fill(body, h('div', { class: 'sub', text: 'Kohtaamisia ei voi etsiä tälle profiilille. Hae pelaaja BattleTagilla (Nimi#1234).' })); return { card, load: async () => {} }; }
    fill(body, skel('100%', 40));
    return {
      card,
      async load() {
        try {
          const d = await U.unwrap(window.api.owEncounters(tag));
          if (!d.total) { fill(body, h('div', { class: 'sub enc-empty', text: 'Ei aiempia kohtaamisia tallennetuissa lobbyissa.' })); return; }
          fill(body,
            h('div', { class: 'row enc-summary' },
              h('span', { class: 'chip', text: `Yhteensä ${d.total}` }), h('span', { class: 'chip', text: `Kanssasi ${d.with}` }), h('span', { class: 'chip', text: `Vastaan ${d.against}` })),
            h('table', { class: 't enc-table' },
              h('thead', null, h('tr', null, ['Päivä', 'Puoli', 'Pelitila', 'Alusta'].map((c) => h('th', { text: c })))),
              h('tbody', null, d.items.map((x) => h('tr', null,
                h('td', { text: dateTime(x.ts) }), h('td', null, h('span', { class: `chip side-${x.side === 'ally' ? 'with' : 'against'}`, text: SIDE_FI[x.side] })),
                h('td', { text: x.mode === 'competitive' ? 'Kilpailullinen' : 'Pikapeli' }), h('td', { text: x.platform === 'pc' ? 'PC' : 'Konsoli' }))))));
        } catch (e) { fill(body, h('div', { class: 'sub warn', text: U.errMsg(e) })); }
      },
    };
  }

  function create(ctx) {
    let mode = 'competitive';
    let backTo = null; // 'lobby', kun profiili avattiin lobbysta
    let platform = 'pc';
    let token = 0;
    let lastRef = null;

    const input = h('input', { class: 'input', type: 'text', placeholder: 'BattleTag, esim. TeKrop#2217', maxlength: '40', spellcheck: 'false', 'aria-label': 'BattleTag' });
    const modeSeg = U.seg(MODES, mode, (v) => { mode = v; refetch(); });
    const platSeg = U.seg(PLATFORMS, platform, (v) => { platform = v; refetch(); });
    const result = h('div', { class: 'view-pane', style: null });
    const recent = h('div', { class: 'row' });

    const form = h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); submit(); } },
      input, modeSeg, platSeg, h('button', { class: 'btn', type: 'submit' }, 'Hae'));

    const backBar = h('div', { class: 'row back-bar', hidden: true },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { backBar.hidden = true; backTo = null; ctx.goto('ow', 'lobby'); } }, 'Takaisin lobbyyn'));
    const el = h('div', { class: 'view-pane' },
      backBar,
      h('h1', { class: 'page-title', text: 'Pelaajahaku' }),
      h('div', { class: 'card' }, form, recent),
      result);

    function getRecent() { try { return JSON.parse(localStorage.getItem('statsikka.recent') || '[]'); } catch (_) { return []; } }
    function pushRecent(tag) {
      try {
        const list = [tag, ...getRecent().filter((x) => x.toLowerCase() !== tag.toLowerCase())].slice(0, 8);
        localStorage.setItem('statsikka.recent', JSON.stringify(list));
      } catch (_) { /* localStorage ei käytettävissä */ }
      drawRecent();
    }
    function drawRecent() {
      const list = getRecent();
      fill(recent, list.length ? h('span', { class: 'sub', text: 'Viimeisimmät:' }) : null,
        list.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { input.value = t; submit(); } }, t)));
    }

    function showLoading() {
      fill(result,
        h('div', { class: 'card', style: null }, h('div', { class: 'row' }, skel(84, 84), h('div', { style: null }, skel(220, 26), h('div', { style: null }, skel(140, 14))))),
        h('div', { class: 'tiles' }, Array.from({ length: 9 }, () => skel('100%', 86))),
        h('div', { class: 'two-col' }, skel('100%', 220), skel('100%', 220)));
    }
    function showError(e) {
      fill(result, h('div', { class: 'errbox' }, h('h3', { text: e.code === 'NOT_FOUND' ? 'Pelaajaa ei löytynyt' : 'Haku epäonnistui' }), h('div', { text: U.errMsg(e) }),
        e.code !== 'NOT_FOUND' && lastRef ? h('div', { style: null }, h('button', { class: 'btn ghost small', onclick: () => load(lastRef) }, 'Yritä uudelleen')) : null));
    }

    async function load(ref, display) {
      const my = ++token;
      lastRef = ref;
      showLoading();
      try {
        const p = await U.unwrap(window.api.owProfile({ ref, gamemode: mode, platform }));
        if (my !== token) return;
        const enc = encountersCard(p);
        fill(result, renderProfile(p), enc.card);
        enc.load();
        if (/^[^%|]+[#-]\d+$/.test(ref)) pushRecent(display || ref.replace(/-(\d+)$/, '#$1'));
      } catch (e) {
        if (my !== token) return;
        showError(e);
      }
    }
    function refetch() { if (lastRef) load(lastRef); }

    async function submit() {
      backBar.hidden = true; backTo = null; // uusi haku käsin: ei enää "lobbysta avattu"
      const q = input.value.trim();
      if (!q) { U.toast('Anna BattleTag, esim. Nimi#1234.', 'err'); return; }
      if (/[#-]\d{3,8}$/.test(q)) { load(q.replace('#', '-'), q); return; }
      const my = ++token;
      lastRef = null; // uusi haku: pelitilan / alustan vaihto ei saa palauttaa edellistä profiilia hakutulosten tilalle
      fill(result, h('div', { class: 'tiles' }, Array.from({ length: 4 }, () => skel('100%', 70))));
      try {
        const list = await U.unwrap(window.api.owSearch(q));
        if (my !== token) return;
        if (list.length === 0) {
          fill(result, h('div', { class: 'empty' }, h('h3', { text: 'Ei hakutuloksia' }), h('div', { text: 'Kokeile BattleTagia muodossa Nimi#1234.' })));
        } else {
          fill(result, h('div', { class: 'section-title', text: `Löytyi ${list.length} pelaajaa. Valitse:` }),
            h('div', { class: 'suggestions' }, list.map((s) => h('button', { class: 'suggestion', type: 'button', onclick: () => load(s.id, s.name) },
              img(s.avatar, 'avatar sm', s.name),
              h('div', null, h('div', { text: s.name }), h('div', { class: 'sub', text: s.isPublic ? (s.title || 'Julkinen profiili') : 'Yksityinen profiili' }))))));
        }
      } catch (e) {
        if (my !== token) return;
        showError(e);
      }
    }

    fill(result, h('div', { class: 'empty' }, h('h3', { text: 'Hae pelaaja' }), h('div', { text: 'Kirjoita BattleTag (Nimi#1234). Profiilin pitää olla julkinen.' })));
    drawRecent();

    let defaults = null; // viimeksi sovelletut oletukset: tallennus muualla ei saa nollata käsin valittua tilaa
    return {
      el,
      applySettings(s) {
        const d = `${s.owPlatform}|${s.owGamemode}`;
        if (d === defaults) return;
        defaults = d;
        platform = s.owPlatform; platSeg.set(platform);
        mode = s.owGamemode || 'competitive'; modeSeg.set(mode);
      },
      open(ref, opts) {
        backTo = opts && opts.from === 'lobby' ? 'lobby' : null;
        backBar.hidden = !backTo;
        if (opts && opts.mode) { mode = opts.mode; modeSeg.set(mode); }
        if (opts && opts.platform) { platform = opts.platform; platSeg.set(platform); }
        input.value = ref.replace(/-(\d+)$/, '#$1');
        load(ref.replace('#', '-'), input.value);
      },
      getOptions: () => ({ mode, platform }),
      onShow() { input.focus(); },
    };
  }

  window.OwProfile = { create, MODES, PLATFORMS, renderProfile };
})();
