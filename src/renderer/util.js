'use strict';
// Yhteiset apufunktiot. Ei innerHTML:ää: kaikki sisältö luodaan DOM-solmuina / textContent-arvoina.
(function () {
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'data') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function fill(el, ...children) { clear(el); append(el, children); return el; }

  // ---- Muotoilu
  const nf = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => (n == null || !Number.isFinite(Number(n)) ? '–' : nf0.format(n));
  const dec = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '–' : (d === 1 ? nf1 : d === 2 ? nf2 : nf).format(n));
  const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '–' : `${nf1.format(n)} %`);
  function mmss(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function duration(sec) {
    const s = Math.floor(Number(sec) || 0);
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
    return `${Math.max(1, Math.round(s / 60))} min`;
  }
  function wrClass(v) {
    if (v == null || !Number.isFinite(Number(v))) return 'wr-neutral';
    return v >= 55 ? 'wr-good' : v < 45 ? 'wr-bad' : 'wr-neutral';
  }
  function dateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const DIVISION_FI = { bronze: 'Pronssi', silver: 'Hopea', gold: 'Kulta', platinum: 'Platina', diamond: 'Timantti', master: 'Mestari', grandmaster: 'Suurmestari', champion: 'Champion' };
  const ROLE_FI = { tank: 'Tankki', damage: 'Vahinko', support: 'Tuki', open: 'Avoin' };
  const rankText = (r) => (r ? `${DIVISION_FI[r.division] || r.division} ${r.tier || ''}`.trim() : 'Ei sijoitusta');

  // ---- Komponentit
  function img(src, cls, alt = '') {
    const el = h('img', { class: cls, alt, loading: 'lazy', referrerpolicy: 'no-referrer' });
    el.addEventListener('error', () => { el.style.visibility = 'hidden'; });
    if (typeof src === 'string' && /^https:\/\//.test(src)) el.src = src; else el.style.visibility = 'hidden';
    return el;
  }
  function skel(w, hgt) {
    const el = h('div', { class: 'skel' });
    el.style.width = typeof w === 'number' ? `${w}px` : (w || '100%');
    el.style.height = `${hgt || 16}px`;
    return el;
  }
  function seg(options, value, onChange) {
    const wrap = h('div', { class: 'seg', role: 'group' });
    const btns = options.map(([val, label]) => h('button', {
      type: 'button', class: val === value ? 'on' : '', onclick: () => set(val, true),
    }, label));
    function set(val, emit) {
      value = val;
      options.forEach(([v], i) => btns[i].classList.toggle('on', v === val));
      if (emit && onChange) onChange(val);
    }
    append(wrap, btns);
    wrap.set = (v) => set(v, false);
    wrap.get = () => value;
    return wrap;
  }
  // opts.action = { label, onClick }: toastiin tulee nappi; opts.ms = näyttöaika (oletus 3 s, virhe 6 s).
  function toast(msg, kind, opts) {
    const root = document.getElementById('toasts');
    const el = h('div', { class: `toast ${kind === 'err' ? 'err' : ''}` }, h('span', { class: 'toast-text', text: msg }));
    const act = opts && opts.action;
    if (act) {
      el.appendChild(h('button', { class: 'btn ghost small toast-action', type: 'button', onclick: () => { el.remove(); act.onClick(); } }, act.label));
    }
    root.appendChild(el);
    setTimeout(() => el.remove(), (opts && opts.ms) || (kind === 'err' ? 6000 : 3000));
  }
  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const done = (v) => { back.remove(); resolve(v); };
      const ok = h('button', { class: 'btn danger', onclick: () => done(true) }, okLabel || 'Vahvista');
      const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) done(false); } },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
          h('h3', { text: title }), h('div', { class: 'sub', text: text }),
          h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Peruuta'), ok)));
      root.appendChild(back);
      ok.focus();
    });
  }

  // Infoliuska live-näkymän yläreunaan, kun Overwolf GEP ei ole käytössä: teksti ja nappi Asetuksiin (Overwolf-kortti). Piilossa kunnes päivitetään.
  function gepHint(text, onOpen) {
    return h('div', { class: 'gep-hint', hidden: true, role: 'note' },
      h('span', { class: 'sub', text }),
      h('button', { class: 'btn ghost small', type: 'button', onclick: onOpen }, 'Avaa asetukset'));
  }

  // ---- IPC
  async function unwrap(promise) {
    const r = await promise;
    if (r && r.ok) return r.data;
    const e = new Error((r && r.error && r.error.message) || 'Tuntematon virhe.');
    e.code = r && r.error ? r.error.code : 'ERROR';
    e.retryAfter = r && r.error ? r.error.retryAfter : 0;
    throw e;
  }
  function errMsg(e) {
    switch (e && e.code) {
      case 'NOT_FOUND': return 'Pelaajaa ei löytynyt. Tarkista BattleTag (isot ja pienet kirjaimet ratkaisevat).';
      case 'RATE_LIMIT': return `Liikaa pyyntöjä palvelimelle${e.retryAfter ? `. Yritä uudelleen noin ${Math.ceil(e.retryAfter)} s kuluttua` : ''}.`;
      case 'TIMEOUT': return 'Palvelin ei vastannut ajoissa (15 s). Yritä uudelleen.';
      case 'NETWORK': return 'Verkkovirhe: palvelimeen ei saatu yhteyttä. Tarkista internet-yhteys.';
      case 'BAD_INPUT': return e.message;
      default: return e && e.message ? e.message : 'Tuntematon virhe.';
    }
  }

  window.U = { h, append, clear, fill, num, dec, pct, mmss, duration, wrClass, dateTime, DIVISION_FI, ROLE_FI, rankText, img, skel, seg, toast, confirmDialog, gepHint, unwrap, errMsg };
})();
