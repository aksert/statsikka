'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/site.go.

const { RECRUIT, operatorRole } = require('./tables');

const CURRENT_SITE_PATTERN = [0xfc, 0xc6, 0xa8, 0x60, 0x01];

function readSpawn(r) {
  const location = r.string();
  r.skip(150);
  const pattern = r.bytes(5);
  if (!location.includes('<br/>')) return;
  let isCurrent = true;
  for (let i = 0; i < 5; i++) if (pattern[i] !== CURRENT_SITE_PATTERN[i]) isCurrent = false;
  const h = r.header;
  if (h.site === '' || isCurrent) {
    const formatted = location.replace('<br/>', ', ');
    for (const p of h.players) {
      const defenseTeam = h.teams[p.teamIndex].role === 'Defense';
      const defenseRole = p.operator !== RECRUIT && p.operator !== 0 && operatorRole(p.operator) === 'Defense';
      if (defenseTeam || defenseRole) p.spawn = formatted;
    }
    h.site = formatted;
  }
}

module.exports = { readSpawn };
