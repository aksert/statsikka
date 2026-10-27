'use strict';
// Järjestelmän ilmaisinalueen (tray) kuvake. Electron-luokat annetaan sisään, jotta savutesti voi korvata Trayn tekaistulla
// (oikeaa kuvaketta ei näytetä testissä) ja silti ajaa saman koodin: kuvakkeen lataus, tooltip, valikko ja kaksoisnapsautus.
const BG = require('./background');

function createTrayController({ Tray, Menu, nativeImage, iconPath, handlers, log = () => {} }) {
  let tray = null;
  const alive = () => !!tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed());
  return {
    exists: alive,
    // Palauttaa true, kun kuvake on olemassa. Virhe (esim. kuvake puuttuu) ei kaada sovellusta: silloin ikkunan sulkeminen lopettaa sovelluksen.
    create() {
      if (alive()) return true;
      try {
        const img = nativeImage.createFromPath(iconPath); // tray@2x.png löytyy samasta kansiosta ja valitaan tarkkuuden mukaan
        if (!img || img.isEmpty()) throw new Error(`Tray-kuvaketta ei voitu ladata: ${iconPath}`);
        tray = new Tray(img);
        tray.setToolTip(BG.TRAY_TOOLTIP);
        tray.setContextMenu(Menu.buildFromTemplate(BG.buildTrayTemplate(handlers)));
        tray.on('double-click', () => handlers.onOpen());
        return true;
      } catch (e) {
        log(`Tray-kuvakkeen luonti epäonnistui: ${e && e.message ? e.message : e}`);
        tray = null;
        return false;
      }
    },
    destroy() {
      if (alive()) { try { tray.destroy(); } catch (_) { /* ei väliä */ } }
      tray = null;
    },
    get: () => tray,
  };
}

module.exports = { createTrayController };
