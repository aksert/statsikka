'use strict';
// Rocket League: otteluhistoria ja koonnit.
(function () {
  const { h, fill, num, dec, pct, wrClass, dateTime, skel } = U;
  const PAGE = 50;

  function tile(label, value, cls, sub) {
    return h('div', { class: 'tile' }, h('div', { class: 'tl', text: label }), h('div', { class: `tv ${cls || ''}`, text: value }), sub ? h('div', { class: 'ts', text: sub }) : null);
  }

  function create() {
    const body = h('div', { class: 'view-pane' });
    const el = h('div', { class: 'view-pane' }, h('div', { class: 'row' }, h('h1', { class: 'page-title', text: 'Historia' })), body);
    let data = null;
    let shown = PAGE;
    const open = new Set();

    function matchEl(m) {
      const blue = m.teams.find((t) => t.teamNum === 0) || { score: 0 };
      const orange = m.teams.find((t) => t.teamNum === 1) || { score: 0 };
      const resText = m.result === 'win' ? 'Voitto' : m.result === 'loss' ? 'Tappio' : 'Ei tulosta';
      const me = m.players.find((p) => p.isOwn);
      const isOpen = open.has(m.guid);
      const head = h('button', { class: 'match-head', type: 'button', 'aria-expanded': String(isOpen), onclick: () => { if (open.has(m.guid)) open.delete(m.guid); else open.add(m.guid); render(); } },
        h('span', { class: 'sub', text: dateTime(m.endedAt) }),
        h('span', null, h('div', { text: m.playlistName || 'Ottelu' }), h('div', { class: 'sub', text: m.arenaName || '' })),
        h('span', { class: 'mono', text: `${blue.score} – ${orange.score}${m.overtime ? ' (JA)' : ''}` }),
        h('span', { class: `res ${m.result || 'na'}`, text: resText }),
        h('span', { class: 'sub mono', text: me ? `${me.goals} maalia · ${me.saves} torjuntaa · ${me.score} p` : 'Oma pelaaja ei mukana' }));
      return h('div', { class: 'match' }, head,
        isOpen ? h('div', { class: 'match-body' }, RlLive.teamTable(0, m.players, false), RlLive.teamTable(1, m.players, false)) : null);
    }

    function render() {
      if (!data) return;
      const s = data.summary;
      const sub = (n) => `${n} ottelua`;
      fill(body,
        s.counted === 0 && s.total > 0 ? h('div', { class: 'banner', text: 'Otteluita on tallennettu, mutta omaa pelaajaa ei löytynyt. Aseta "Oma nimi" Asetuksissa, niin voitot ja tilastot lasketaan.' }) : null,
        h('div', { class: 'tiles' },
          tile('Voitot', num(s.wins), 'win', sub(s.counted)),
          tile('Häviöt', num(s.losses), 'loss'),
          tile('Voitto-%', pct(s.winrate), wrClass(s.winrate)),
          tile('Maalit / peli', dec(s.goalsPerGame)),
          tile('Torjunnat / peli', dec(s.savesPerGame)),
          tile('Laukaukset / peli', dec(s.shotsPerGame)),
          tile('Paras peli', s.bestGame ? `${num(s.bestGame.score)} p` : '–', '', s.bestGame ? `${s.bestGame.goals} maalia` : null),
          tile('Eniten maaleja pelissä', s.mostGoals ? num(s.mostGoals.goals) : '–'),
          tile('MVP-määrä', num(s.mvps), '', 'korkein pistemäärä voittajatiimissä')),
        h('div', { class: 'row' },
          h('span', { class: 'sub', text: `${s.total} tallennettua ottelua` }),
          h('button', { class: 'btn ghost small', onclick: reload }, 'Päivitä'),
          h('button', { class: 'btn danger small', disabled: s.total === 0, onclick: clearAll }, 'Tyhjennä historia')),
        data.matches.length
          ? [data.matches.slice(0, shown).map(matchEl),
            data.matches.length > shown ? h('div', null, h('button', { class: 'btn ghost', onclick: () => { shown += PAGE; render(); } }, `Näytä lisää (${data.matches.length - shown})`)) : null]
          : h('div', { class: 'empty' }, h('h3', { text: 'Ei vielä otteluita' }),
            h('div', { text: 'Ottelut tallentuvat automaattisesti, kun pelaat Rocket Leaguea sovelluksen ollessa auki ja Stats API on käytössä.' })));
    }

    async function reload() {
      try {
        data = await U.unwrap(window.api.rlHistory());
        render();
      } catch (e) {
        fill(body, h('div', { class: 'errbox' }, h('h3', { text: 'Historian lataus epäonnistui' }), h('div', { text: U.errMsg(e) })));
      }
    }
    async function clearAll() {
      const ok = await U.confirmDialog('Tyhjennä historia?', 'Kaikki tallennetut Rocket League -ottelut poistetaan pysyvästi. Tätä ei voi perua.', 'Tyhjennä');
      if (!ok) return;
      try { await U.unwrap(window.api.rlClearHistory()); U.toast('Historia tyhjennetty.'); shown = PAGE; open.clear(); reload(); } catch (e) { U.toast(U.errMsg(e), 'err'); }
    }

    fill(body, skel('100%', 90), skel('100%', 200));
    return { el, onShow: reload, reload };
  }

  window.RlHistory = { create };
})();
