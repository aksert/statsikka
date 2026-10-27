'use strict';
// Taustatila, tray-valikko ja pelin käynnistyksen automaattinen avaus: puhdas logiikka ilman Electron-riippuvuuksia (testattavissa node:lla).
// Ikkunaa ei koskaan tuoda eteen pelin käynnistyessä: avaus tehdään showInactive():llä (ei kohdistusta, ei vilkutusta, ei ilmoituksia).
const { GAMES } = require('./game-detect');
const OWL = require('./overwolf');

const HIDDEN_ARG = '--hidden';
const GAME_NAMES = Object.freeze({ ow: 'Overwatch 2', rl: 'Rocket League', r6: 'Rainbow Six Siege' });
const TRAY_GAMES = Object.freeze(['ow', 'rl', 'r6']);
const TRAY_TOOLTIP = 'Statsikka';

// Käynnistysreuna: kutsuu onLaunch(peli) vain kun peliprosessi ilmestyy (ei -> kyllä). Ensimmäinen havainto on lähtötilanne (ei tapahtumaa),
// joten jo käynnissä oleva peli ei avaa ikkunaa Statsikan käynnistyessä. Pelin sulkeutuminen ja uusi käynnistys on uusi tapahtuma.
function createLaunchWatcher(onLaunch) {
  let prev = null;
  return {
    update(state) {
      const cur = {};
      for (const g of GAMES) cur[g] = !!(state && state[g]);
      const launched = prev ? GAMES.filter((g) => cur[g] && !prev[g]) : [];
      prev = cur;
      for (const g of launched) onLaunch(g);
    },
    reset() { prev = null; },
  };
}

// Päätös pelin käynnistyessä. action: 'show' (ikkuna piilossa / pienennetty: showInactive + siirtymä), 'navigate' (ikkuna jo näkyvissä: vain siirtymä) tai 'none'.
// Kirjoituksen aikaisten suojien (lomake, vahvistusikkuna, pelaajapaneeli) arviointi on rendererissä, koska vain se tietää kohdistuksen.
function decideLaunch({ enabled, hasWindow, visible, minimized }) {
  if (!enabled || !hasWindow) return { action: 'none', wasHidden: false };
  const hidden = !visible || !!minimized;
  return { action: hidden ? 'show' : 'navigate', wasHidden: hidden };
}

const isHiddenStart = (argv) => (argv || []).includes(HIDDEN_ARG);
// --hidden vaikuttaa vain, kun ikkunaan pääsee takaisin trayn kautta (muuten ikkuna jäisi tavoittamattomiin).
const shouldStartHidden = ({ argv, runInBackground, trayOk }) => isHiddenStart(argv) && !!runInBackground && !!trayOk;
// Sulkeminen piilottaa ikkunan trayhin, ellei olla lopettamassa.
const shouldHideOnClose = ({ quitting, runInBackground, trayOk }) => !quitting && !!runInBackground && !!trayOk;
// Toinen käynnistys (esim. Kaynnista.bat) tuo ikkunan esiin; Windowsin automaattikäynnistys (--hidden) ei.
const shouldRevealOnSecondInstance = (argv) => !isHiddenStart(argv);

// Windowsin mukana käynnistyminen: ow-electronilla execPath on ow-electron-binääri. GEP-kanava mukaan, jos se on käytössä ja ajoympäristö on ow-electron.
function buildLoginItem({ enabled, execPath, appPath, devChannel, hasOverwolf }) {
  const args = [String(appPath), HIDDEN_ARG];
  if (devChannel && hasOverwolf) args.push(OWL.CHANNEL_ARG);
  return { openAtLogin: !!enabled, path: String(execPath), args };
}
// app.getLoginItemSettings()-tulos -> todellinen tila (Tehtävienhallinnassa pois kytketty kohde ei käynnisty).
const loginEnabled = (li) => !!(li && li.openAtLogin && li.executableWillLaunchAtLogin !== false);

// Ctrl+Q (tai Cmd+Q) lopettaa sovelluksen kokonaan.
const isQuitKey = (input) => !!input && input.type === 'keyDown' && !!(input.control || input.meta) && !input.alt && !input.shift && String(input.key || '').toLowerCase() === 'q';

// Tray-valikon rakenne: Avaa, pelikohtaiset pikavalinnat, Lopeta.
function buildTrayTemplate({ onOpen, onGame, onQuit }) {
  return [
    { label: 'Avaa Statsikka', click: () => onOpen() },
    { type: 'separator' },
    ...TRAY_GAMES.map((g) => ({ label: GAME_NAMES[g], click: () => onGame(g) })),
    { type: 'separator' },
    { label: 'Lopeta', click: () => onQuit() },
  ];
}

module.exports = {
  HIDDEN_ARG, GAME_NAMES, TRAY_GAMES, TRAY_TOOLTIP,
  createLaunchWatcher, decideLaunch, isHiddenStart, shouldStartHidden, shouldHideOnClose, shouldRevealOnSecondInstance,
  buildLoginItem, loginEnabled, isQuitKey, buildTrayTemplate,
};
