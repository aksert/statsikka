'use strict';
// Käynnistin (npm start / Kaynnista.bat): ajaa Statsikan Overwolfin ow-electronilla (GEP-live-tiedot) ja putoaa tavalliseen Electroniin,
// jos ow-electron ei käynnisty lainkaan (kaatuu heti nollasta poikkeavalla koodilla). Silloin Statsikka toimii kuten ennenkin, mutta ilman GEP:iä.
// Lisäargumentit (esim. --smoke-test) välitetään eteenpäin.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = ['.', ...process.argv.slice(2)];
const QUICK_FAIL_MS = 6000;

function resolveExe(name) {
  try { const p = require(name); return typeof p === 'string' && fs.existsSync(p) ? p : null; } catch (_) { return null; }
}
function run(exe, env = process.env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(exe, args, { cwd: root, stdio: 'inherit', windowsHide: false, env });
    const fwd = (sig) => process.on(sig, () => { try { child.kill(sig); } catch (_) { /* ei väliä */ } });
    ['SIGINT', 'SIGTERM'].forEach(fwd);
    child.on('error', () => resolve({ code: 1, ms: Date.now() - t0, spawnError: true }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, ms: Date.now() - t0 }));
  });
}

(async () => {
  const ow = resolveExe('@overwolf/ow-electron');
  const plain = resolveExe('electron');
  if (!ow && !plain) { console.error('Ei löydy ow-electronia eikä electronia: aja npm install.'); process.exit(1); }
  let env = process.env;
  if (ow) {
    const r = await run(ow);
    if (r.code === 0 || r.ms >= QUICK_FAIL_MS || !plain) process.exit(r.code);
    console.error(`ow-electron ei käynnistynyt (koodi ${r.code}, ${r.ms} ms). Käynnistetään tavallisella Electronilla: Overwolf GEP ei ole käytössä.`);
    // Asetusten Overwolf-kortti näyttää syyn (src/main/gep.js).
    env = { ...process.env, STATSIKKA_OW_FALLBACK: `koodi ${r.code}, ${r.ms} ms` };
  }
  const r2 = await run(plain, env);
  process.exit(r2.code);
})();
