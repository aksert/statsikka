'use strict';
// "Kirjaudu omaan profiiliin": oman profiilin yhdistäminen nimellä (ei salasanaa). Kirjoittaa samat asetukset kuin
// Asetukset > Omat profiilit, joten asetukset ovat yhden totuuden lähde. Jaetut apurit ovat myös asetusnäkymän käytössä.
(function () {
  const { h, fill } = U;

  const TAG_RE = /^([\p{L}\p{N}_]{2,24})[#-](\d{3,8})$/u;
  const RL_PLATFORMS = [['epic', 'Epic Games'], ['steam', 'Steam'], ['psn', 'PlayStation'], ['xbox', 'Xbox'], ['switch', 'Switch']];
  const normTag = (t) => String(t || '').trim().replace('-', '#').toLowerCase();
  const NOTE = 'Salasanaa ei tarvita eikä kysytä – profiili yhdistetään nimellä.';
  const GAME_NAME = { ow: 'Overwatch 2', rl: 'Rocket League', r6: 'Rainbow Six Siege' };

  async function persist(ctx, patch) {
    const s = await U.unwrap(window.api.setSettings(patch));
    ctx.onSettings(s);
    return s;
  }

  // Vahvistus, kun jo asetettu OW-profiili vaihtuu toiseen BattleTagiin / alustaan (historia nollautuu).
  async function confirmOwChange(cur, patch) {
    const tagChanged = patch.battletag !== undefined && patch.battletag !== '' && normTag(patch.battletag) !== normTag(cur.battletag);
    const platChanged = patch.platform !== undefined && patch.platform !== cur.platform;
    if (cur.battletag && (tagChanged || platChanged)) {
      return U.confirmDialog('Vaihdetaanko oma OW-profiili?', 'Kehityshistoria (rankit ja tilastot ajan mittaan) nollataan, kun BattleTag tai alusta vaihtuu.', 'Vaihda');
    }
    return true;
  }

  // "Tarkista": hakee profiilin ja näyttää tuloksen out-elementissä.
  async function checkOw(out, tag, platform) {
    const t = String(tag).trim();
    if (!TAG_RE.test(t)) { U.toast('Virheellinen BattleTag. Muoto: Nimi#1234.', 'err'); return; }
    fill(out, U.skel(260, 40));
    try {
      const p = await U.unwrap(window.api.owProfile({ ref: t.replace('#', '-'), gamemode: 'competitive', platform }));
      const note = p.isPrivate ? 'Profiili on yksityinen. Aseta se julkiseksi, niin tilastot näkyvät.'
        : !p.hasStats ? 'Profiili löytyi, mutta kilpailullisia tilastoja ei löytynyt tälle alustalle.'
          : p.bestRank ? `Profiili löytyi. Paras rankki: ${U.rankText(p.bestRank)}.` : 'Profiili löytyi (ei sijoitusta tällä alustalla).';
      fill(out, h('div', { class: 'row check-ok' }, U.img(p.avatar, 'avatar sm', p.name),
        h('div', null, h('div', { text: p.name }), h('div', { class: 'sub', text: p.title || '' }), h('div', { class: p.hasStats ? 'sub' : 'sub warn', text: note }))));
    } catch (e) {
      fill(out, h('div', { class: 'errbox' }, h('div', { text: e.code === 'NOT_FOUND' ? 'Pelaajaa ei löytynyt tai profiili on yksityinen. Tarkista BattleTag (isot ja pienet kirjaimet ratkaisevat).' : U.errMsg(e) })));
    }
  }

  // "Kirjaudu ulos": tyhjentää pelin profiiliasetuksen sovelluksen sisäisen vahvistuksen jälkeen.
  async function unlink(ctx, game) {
    const text = game === 'ow'
      ? 'Oma OW-profiili irrotetaan. Tallennettu kehityshistoria säilyy, jos yhdistät saman BattleTagin ja alustan uudelleen; toisen profiilin yhdistäminen nollaa sen.'
      : game === 'rl'
        ? 'Oma nimi poistetaan asetuksista. Tallennetut ottelut ja rankkimerkinnät säilyvät, mutta ne lasketaan sinun omiksesi vasta kun nimi asetetaan uudelleen.'
        : 'Ubisoft-nimi poistetaan asetuksista eikä sitä täytetä automaattisesti uudelleen. Tallennetut ottelut säilyvät; Pelaajat, Ottelut ja Live-peli toimivat edelleen.';
    const ok = await U.confirmDialog(`Kirjaudu ulos: ${GAME_NAME[game]}?`, text, 'Kirjaudu ulos');
    if (!ok) return false;
    const patch = game === 'ow' ? { owProfile: { battletag: '' } } : game === 'rl' ? { rlOwnName: '' } : { r6Name: '' };
    try { await persist(ctx, patch); U.toast('Kirjauduttu ulos.'); return true; } catch (e) { U.toast(U.errMsg(e), 'err'); return false; }
  }

  // Kirjautumiskortti. opts: { onSaved(), onCancel() | null }
  function create(ctx, game, opts = {}) {
    const el = h('div', { class: 'card link-card', data: { game } });
    let settings = null;

    function frame(...fields) {
      return [
        h('h2', { text: opts.onCancel ? `Vaihda profiili: ${GAME_NAME[game]}` : 'Kirjaudu omaan profiiliin' }),
        h('p', { class: 'sub', text: NOTE }),
        ...fields,
      ];
    }
    function cancelBtn() {
      return opts.onCancel ? h('button', { class: 'btn ghost', type: 'button', onclick: () => opts.onCancel() }, 'Peruuta') : null;
    }
    async function save(patch, fn) {
      try {
        if (fn && !(await fn())) return;
        await persist(ctx, patch);
        U.toast('Profiili tallennettu.');
        if (opts.onSaved) opts.onSaved();
      } catch (e) { U.toast(U.errMsg(e), 'err'); }
    }

    function drawOw() {
      const op = settings.owProfile;
      const tag = h('input', { class: 'input', type: 'text', maxlength: '40', value: op.battletag, placeholder: 'BattleTag, esim. TeKrop#2217', spellcheck: 'false', 'aria-label': 'BattleTag' });
      const plat = U.seg(OwProfile.PLATFORMS, op.platform, () => {});
      const out = h('div', { class: 'check-out' });
      const form = h('form', { class: 'link-form', onsubmit: (e) => {
        e.preventDefault();
        const t = tag.value.trim();
        if (!TAG_RE.test(t)) { U.toast('Virheellinen BattleTag. Muoto: Nimi#1234.', 'err'); return; }
        const patch = { battletag: t, platform: plat.get() };
        save({ owProfile: patch }, () => confirmOwChange(op, patch));
      } },
      h('div', { class: 'form-grid' }, h('label', { text: 'BattleTag' }), tag, h('label', { text: 'Alusta' }), plat),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => checkOw(out, tag.value, plat.get()) }, 'Tarkista'),
        h('button', { class: 'btn', type: 'submit' }, 'Tallenna'), cancelBtn()),
      out);
      fill(el, frame(form));
    }
    function drawRl() {
      const name = h('input', { class: 'input', type: 'text', maxlength: '64', value: settings.rlOwnName, placeholder: 'Pelinimesi Rocket Leaguessa', spellcheck: 'false', 'aria-label': 'Pelinimi' });
      const plat = h('select', { class: 'input', 'aria-label': 'Alusta' }, RL_PLATFORMS.map(([v, l]) => h('option', { value: v }, l)));
      plat.value = settings.rlPlatform;
      const form = h('form', { class: 'link-form', onsubmit: (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { U.toast('Anna pelinimesi.', 'err'); return; }
        save({ rlOwnName: n, rlPlatform: plat.value });
      } },
      h('div', { class: 'form-grid' }, h('label', { text: 'Pelinimi' }), name, h('label', { text: 'Alusta (tiedoksi)' }), plat),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Tallenna'), cancelBtn()));
      fill(el, frame(form, h('p', { class: 'sub', text: 'Nimi tunnistaa sinut live-pistetaulukossa ja laskee voitot historiaan.' })));
    }
    function drawR6() {
      const name = h('input', { class: 'input', type: 'text', maxlength: '32', value: settings.r6Name, placeholder: 'Ubisoft-nimi', spellcheck: 'false', 'aria-label': 'Ubisoft-nimi' });
      const form = h('form', { class: 'link-form', onsubmit: (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { U.toast('Anna Ubisoft-nimesi.', 'err'); return; }
        save({ r6Name: n });
      } },
      h('div', { class: 'form-grid' }, h('label', { text: 'Ubisoft-nimi' }), name),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Tallenna'), cancelBtn()));
      fill(el, frame(form, h('p', { class: 'sub', text: 'Tilastot lasketaan omista ottelutallenteistasi (Match Replay). Nimi täyttyy yleensä automaattisesti, kun ensimmäinen ottelu on tallentunut; sinut tunnistetaan tallenteen omistajana, ei nimen perusteella.' })));
    }

    fill(el, h('h2', { text: 'Kirjaudu omaan profiiliin' }), U.skel(260, 40));
    U.unwrap(window.api.getSettings()).then((s) => {
      settings = s;
      if (game === 'ow') drawOw(); else if (game === 'rl') drawRl(); else drawR6();
    }).catch((e) => fill(el, h('div', { class: 'errbox' }, h('div', { text: U.errMsg(e) }))));
    return { el };
  }

  window.LinkCard = { create, unlink, checkOw, confirmOwChange, persist, TAG_RE, RL_PLATFORMS, NOTE, GAME_NAME };
})();
