'use strict';
// Sovelluksen runko: sivupalkki, välilehdet, näkymien elinkaari.
(function () {
  const { h } = U;
  const viewRoot = document.getElementById('view');
  const tabsEl = document.getElementById('tabs');
  const noticeEl = document.getElementById('notice');
  const dot = document.getElementById('rl-dot');

  // Pelien tila: käynnissä (prosessi) ja ottelu käynnissä. Päivittyy pääprosessin game:state-tapahtumista.
  const gameState = { r6: false, ow: false, rl: false, match: { r6: false, ow: false, rl: false } };
  const gameSubs = [];
  // Overwolf GEP -tilannekuva (R6 / OW live-rosterit). Päivittyy pääprosessin gep:update-tapahtumista (rajoitettu 250 ms).
  let gepSnap = null;
  const gepSubs = [];

  const ctx = {
    gameState: () => gameState,
    onGame(cb) { gameSubs.push(cb); },
    gep: () => gepSnap,
    onGep(cb) { gepSubs.push(cb); },
    // Onko Overwolf GEP käytössä (valmis / peli käynnissä tai pelin live-ottelu seurannassa)? null = tila ei ole vielä tiedossa.
    gepActive(game) {
      if (!gepSnap) return null;
      const st = gepSnap.status && gepSnap.status.state;
      return st === 'ready' || st === 'game-running' || !!(gepSnap[game] && gepSnap[game].live);
    },
    goto(game, tab) { go(game, tab); },
    openOverwolfSettings() { go('settings'); const c = document.querySelector('.ow-settings'); if (c) c.scrollIntoView({ block: 'start' }); },
    openProfile(ref, opts) { go('ow', 'profile'); views.ow_profile.open(ref, opts); },
    onSettings(s) { views.ow_profile.applySettings(s); views.ow_lobby.applySettings(s); },
  };

  const views = {
    own_profile: OwnProfile.create(ctx),
    own_ow: OwnProfile.create(ctx, { game: 'ow' }),
    own_rl: OwnProfile.create(ctx, { game: 'rl' }),
    own_r6: OwnProfile.create(ctx, { game: 'r6' }),
    ow_profile: OwProfile.create(ctx),
    ow_lobby: OwLobby.create(ctx),
    rl_live: RlLive.create(ctx),
    rl_history: RlHistory.create(ctx),
    rl_players: RlPlayers.create(ctx),
    r6_live: R6Live.create(ctx),
    r6_matches: R6Matches.create(ctx),
    r6_players: R6Players.create(ctx),
    r6_check: R6Check.create(ctx),
    settings: SettingsView.create(ctx),
  };
  for (const v of Object.values(views)) { v.el.hidden = true; viewRoot.appendChild(v.el); }

  const GAMES = {
    me: { tabs: [['dash', 'Oma profiili', 'own_profile']] },
    ow: { tabs: [['me', 'Oma profiili', 'own_ow'], ['profile', 'Pelaajahaku', 'ow_profile'], ['lobby', 'Live-lobby', 'ow_lobby']] },
    rl: { tabs: [['me', 'Oma profiili', 'own_rl'], ['live', 'Live-peli', 'rl_live'], ['history', 'Historia', 'rl_history'], ['players', 'Pelaajat', 'rl_players']] },
    r6: { tabs: [['me', 'Oma profiili', 'own_r6'], ['live', 'Live-peli', 'r6_live'], ['matches', 'Ottelut', 'r6_matches'], ['players', 'Pelaajat', 'r6_players'], ['check', 'Pelaajan tarkistus', 'r6_check']] },
    settings: { tabs: [['settings', 'Asetukset', 'settings']] },
  };
  const state = { game: 'me', tab: { me: 'dash', ow: 'me', rl: 'me', r6: 'me', settings: 'settings' } };

  function go(game, tab) {
    if (!GAMES[game]) return;
    state.game = game;
    if (tab) state.tab[game] = tab;
    document.body.dataset.game = game;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.game === game));
    const cfg = GAMES[game];
    tabsEl.replaceChildren(...cfg.tabs.map(([id, label]) => h('button', {
      class: `tab ${id === state.tab[game] ? 'active' : ''}`, role: 'tab', type: 'button', onclick: () => go(game, id),
    }, label)));
    tabsEl.style.visibility = cfg.tabs.length > 1 ? 'visible' : 'hidden';
    const key = cfg.tabs.find((t) => t[0] === state.tab[game])[2];
    for (const [k, v] of Object.entries(views)) v.el.hidden = k !== key;
    views[key].onShow();
  }

  document.getElementById('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) go(b.dataset.game); });
  document.querySelector('.sidebar > .nav-item[data-game="settings"]').addEventListener('click', () => go('settings'));

  // ---- Rocket League -päivitykset
  const STATUS_TITLE = { connected: 'Yhdistetty', waiting: 'Odotetaan peliä', disconnected: 'Ei yhteyttä' };
  let lastGuid = null;
  let rlHasMatch = false;
  let rlStatus = 'disconnected';
  function onRl(d) {
    rlStatus = d.status;
    updateDots();
    dot.title = STATUS_TITLE[d.status] || '';
    views.rl_live.update(d);
    const guid = d.match ? d.match.guid : null;
    rlHasMatch = !!d.match;
    updateDots();
    if (lastGuid && !guid && state.game === 'rl' && state.tab.rl === 'history') views.rl_history.reload();
    lastGuid = guid;
  }
  window.api.onRlUpdate(onRl);
  U.unwrap(window.api.rlState()).then(onRl).catch(() => {});

  // ---- Rainbow Six Siege -päivitykset (ottelutallenteet): sivupalkin piste palaa, kun ottelu on käynnissä
  const r6dot = document.getElementById('r6-dot');
  let r6Active = false;
  function onR6(d) {
    r6Active = !!(d && d.activeName);
    updateDots();
  }
  window.api.onR6Update(onR6);
  U.unwrap(window.api.r6Status()).then((s) => onR6({ activeName: s.active })).catch(() => {});

  // Sivupalkin pisteet: vihreä = ottelu käynnissä, keltainen = peli käynnissä mutta ei ottelua.
  const owdot = document.getElementById('ow-dot');
  function dotClass(match, running) { return match ? 'connected' : running ? 'waiting' : ''; }
  function updateDots() {
    const rlMatch = gameState.match.rl || rlHasMatch;
    const rlRun = gameState.rl || rlStatus === 'connected' || rlStatus === 'waiting';
    dot.className = `status-dot ${dotClass(rlMatch, rlRun)}`;
    dot.title = rlMatch ? 'Ottelu käynnissä' : rlRun ? 'Peli käynnissä, ei ottelua' : (STATUS_TITLE[rlStatus] || '');
    const r6m = r6Active || gameState.match.r6;
    r6dot.className = `status-dot ${dotClass(r6m, gameState.r6)}`;
    r6dot.title = r6m ? 'Ottelu käynnissä' : gameState.r6 ? 'Peli käynnissä, ei ottelua' : 'Ei käynnissä olevaa ottelua';
    owdot.className = `status-dot ${dotClass(gameState.match.ow, gameState.ow)}`;
    owdot.title = gameState.match.ow ? 'Ottelu käynnissä' : gameState.ow ? 'Overwatch käynnissä, ei ottelua (ottelun alku tunnistetaan vain Overwolf GEP:llä)' : 'Overwatch ei käynnissä';
  }

  // ---- Pelien tila ja automaattinen siirtyminen live-näkymään (vain sovelluksen sisäinen näkymänvaihto, ei ikkunan esiintuontia)
  function applyGame(g) {
    if (!g) return;
    for (const k of ['r6', 'ow', 'rl']) { gameState[k] = !!g[k]; gameState.match[k] = !!(g.match && g.match[k]); }
    updateDots();
    gameSubs.forEach((cb) => { try { cb(gameState); } catch (_) { /* ei väliä */ } });
  }
  window.api.onGameState(applyGame);
  U.unwrap(window.api.gameState()).then(applyGame).catch(() => {});

  const typing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  };
  const GAME_NAME = { r6: 'Rainbow Six Siege', rl: 'Rocket League', ow: 'Overwatch 2' };
  const LIVE_TAB = { r6: 'live', rl: 'live', ow: 'lobby' };
  window.api.onGameMatchStart(async (e) => {
    const game = e && e.game;
    if (game !== 'r6' && game !== 'rl' && game !== 'ow') return;
    let auto = true;
    try { auto = (await U.unwrap(window.api.getSettings())).autoLive !== false; } catch (_) { /* oletus: päällä */ }
    if (!auto) return;
    // Ei kesken kirjoittamisen eikä vahvistusikkunan tai pelaajapaneelin ollessa auki.
    if (typing() || document.querySelector('#modal-root .modal') || PlayerPanel.isOpen()) return;
    if (state.game === game && state.tab[game] === LIVE_TAB[game]) return;
    go(game, LIVE_TAB[game]);
    U.toast(`Ottelu alkoi (${GAME_NAME[game]}) – siirryttiin live-näkymään.`);
  });

  // ---- Pelin käynnistyminen (peliprosessi ilmestyi): pääprosessi avasi ikkunan tarvittaessa ilman kohdistusta (showInactive) ja pyytää siirtymään pelin live-näkymään.
  // Näkyvässä ikkunassa noudatetaan samoja suojia kuin ottelun alussa (ei kesken kirjoittamisen, vahvistusikkunan tai pelaajapaneelin ollessa auki).
  // Piilosta avatussa ikkunassa vanha kohdistus voi olla jäänyt kenttään, joten kirjoitussuojaa ei käytetä; pelaajapaneeli suljetaan, jotta live-näkymä näkyy.
  window.api.onGameLaunch((e) => {
    const game = e && e.game;
    if (game !== 'r6' && game !== 'rl' && game !== 'ow') return;
    const wasHidden = !!(e && e.wasHidden);
    if (!wasHidden && (typing() || document.querySelector('#modal-root .modal') || PlayerPanel.isOpen())) return;
    if (wasHidden) PlayerPanel.close();
    if (state.game === game && state.tab[game] === LIVE_TAB[game]) return;
    go(game, LIVE_TAB[game]);
    U.toast(`Peli käynnistyi (${GAME_NAME[game]}) – avattiin live-näkymä.`);
  });
  // Tray-valikon pelikohtainen pikavalinta (käyttäjän oma toimi): suoraan pelin live-näkymään.
  window.api.onAppOpenGame((e) => {
    const game = e && e.game;
    if (game !== 'r6' && game !== 'rl' && game !== 'ow') return;
    PlayerPanel.close();
    go(game, LIVE_TAB[game]);
  });

  // ---- Overwolf GEP
  function applyGep(s) {
    if (!s) return;
    gepSnap = s;
    gepSubs.forEach((cb) => { try { cb(s); } catch (_) { /* ei väliä */ } });
  }
  window.api.onGepUpdate(applyGep);
  U.unwrap(window.api.gepState()).then(applyGep).catch(() => {});

  // ---- Ilmoitus nopeusrajoituksesta
  let noticeTimer = null;
  window.api.onOwNotice((n) => {
    if (n && n.type === 'rate-limit') {
      noticeEl.hidden = false;
      noticeEl.textContent = `Palvelin rajoitti pyyntöjä. Yritetään uudelleen ${Math.ceil(n.retryAfter)} s kuluttua…`;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, Math.max(3000, n.retryAfter * 1000 + 1500));
    }
  });

  // ---- Päivitys ladattu: ilmoitus kerran per versio koko sovelluksessa (Asetusten Päivitykset-kortti näyttää tilan erikseen)
  let toastedUpdate = null;
  function onUpdater(s) {
    if (!s || s.state !== 'downloaded' || !s.latest || toastedUpdate === s.latest) return;
    toastedUpdate = s.latest;
    U.toast(`Statsikan versio ${s.latest} on ladattu – päivitys asentuu, kun suljet sovelluksen.`, null, {
      ms: 15000,
      action: { label: 'Päivitä nyt', onClick: () => { U.unwrap(window.api.updaterInstall()).catch((e) => U.toast(U.errMsg(e), 'err')); } },
    });
  }
  window.api.onUpdaterState(onUpdater);
  U.unwrap(window.api.updaterState()).then(onUpdater).catch(() => {});

  // ---- Asetukset käyttöön
  U.unwrap(window.api.getSettings()).then((s) => ctx.onSettings(s)).catch(() => {});

  // Ulkoiset linkit: vain https, pääprosessi avaa oletusselaimessa
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (/^https:\/\//.test(a.href)) window.api.openExternal(a.href);
  });

  // Arenyze-osiot (pelaajapaneeli, oma profiili) ohjaavat avaimen puuttuessa Asetusten Arenyze-korttiin.
  ArzUi.init({ openSettings() { PlayerPanel.close(); go('settings'); const c = document.querySelector('.arz-settings'); if (c) c.scrollIntoView({ block: 'start' }); } });

  go('me');
})();
