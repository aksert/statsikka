'use strict';
// Pelaajapaneeli: oikealta liukuva sivupaneeli (ei erillinen ikkuna), jota kaikki pelinäkymät käyttävät. Paneelissa on pino:
// toisen pelaajan avaaminen paneelista (esim. ottelun pistetaulusta) lisää kerroksen ja "Takaisin" palaa edelliseen.
// Lisäksi pieni "Edellinen: kanssa / vastaan" -merkki, jota live-näkymät ja lobby käyttävät.
(function () {
  const { h, fill, skel } = U;

  let root = null, titleEl = null, subEl = null, bodyEl = null, backBtn = null, closeBtn = null;
  const stack = []; // { id, title, sub, load, render, data }
  let token = 0;
  let lastFocus = null;

  function ensure() {
    if (root) return;
    backBtn = h('button', { class: 'btn ghost small', type: 'button', onclick: () => back() }, 'Takaisin');
    closeBtn = h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Sulje pelaajapaneeli', onclick: () => close() }, 'Sulje');
    titleEl = h('h2', { class: 'drawer-title' });
    subEl = h('div', { class: 'sub' });
    bodyEl = h('div', { class: 'drawer-body' });
    root = h('div', { class: 'drawer-back', hidden: true, onclick: (e) => { if (e.target === root) close(); } },
      h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pelaajan tiedot' },
        h('header', { class: 'drawer-head' }, backBtn, h('div', { class: 'drawer-titles' }, titleEl, subEl), closeBtn),
        bodyEl));
    document.body.appendChild(root);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); } });
  }
  const isOpen = () => !!root && !root.hidden;
  const top = () => stack[stack.length - 1];

  function paint() {
    const t = top();
    if (!t) return;
    const my = ++token;
    titleEl.textContent = t.title || 'Pelaaja';
    subEl.textContent = t.sub || '';
    backBtn.hidden = stack.length < 2;
    if (t.data !== undefined) { show(t, t.data); return; }
    fill(bodyEl, skel('100%', 90), skel('100%', 160), skel('100%', 200));
    Promise.resolve().then(t.load).then((data) => {
      t.data = data;
      if (my === token && top() === t) show(t, data);
    }, (e) => {
      if (my !== token || top() !== t) return;
      fill(bodyEl, h('div', { class: 'errbox' }, h('h3', { text: 'Pelaajan tietoja ei voitu ladata' }), h('div', { text: U.errMsg(e) }),
        h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { t.data = undefined; paint(); } }, 'Yritä uudelleen'))));
    });
  }
  function show(t, data) {
    const api = { setTitle: (s) => { t.title = s; if (top() === t) titleEl.textContent = s; }, setSub: (s) => { t.sub = s; if (top() === t) subEl.textContent = s; } };
    fill(bodyEl, t.render(data, api));
    bodyEl.scrollTop = 0;
  }

  // spec: { id, title, sub, load(): Promise<data>, render(data, api): Node | Node[] }
  function open(spec) {
    ensure();
    if (!isOpen()) { lastFocus = document.activeElement; stack.length = 0; }
    const t = top();
    if (t && t.id === spec.id) { t.data = undefined; paint(); return; } // sama pelaaja uudelleen: päivitä
    stack.push({ ...spec, data: undefined });
    root.hidden = false;
    paint();
    closeBtn.focus({ preventScroll: true });
  }
  function back() {
    if (stack.length < 2) { close(); return; }
    stack.pop();
    paint();
  }
  function close() {
    if (!root) return;
    token++;
    stack.length = 0;
    root.hidden = true;
    fill(bodyEl);
    if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') { try { lastFocus.focus({ preventScroll: true }); } catch (_) { /* ei väliä */ } }
  }

  const SIDE_TEXT = { with: 'kanssa', against: 'vastaan', ally: 'kanssa', enemy: 'vastaan' };
  // Pieni "Edellinen: kanssa / vastaan" -merkki pelaajan nimen viereen. title = ottelun tiedot (kartta / tulos).
  function prevChip(side, title) {
    const s = side === 'ally' ? 'with' : side === 'enemy' ? 'against' : side;
    if (s !== 'with' && s !== 'against') return null;
    return h('span', { class: `prev-chip ${s}`, title: title || 'Oli edellisessä ottelussa', text: `Edellinen: ${SIDE_TEXT[s]}` });
  }
  // Ottelun yhteenveto chipin tooltipiin: "Bank · Ranked · Voitto, 2. 7. 14:03".
  function prevTitle(info, side, resultText) {
    if (!info) return 'Oli edellisessä ottelussa';
    const parts = [info.map || info.arenaName, info.type || info.playlistName, resultText].filter(Boolean).join(' · ');
    const when = info.ts || info.endedAt ? U.dateTime(info.ts || info.endedAt) : '';
    return `Edellinen ottelu (${SIDE_TEXT[side] || ''}${when ? `, ${when}` : ''}): ${parts || '–'}`;
  }

  window.PlayerPanel = { open, back, close, isOpen, prevChip, prevTitle };
})();
