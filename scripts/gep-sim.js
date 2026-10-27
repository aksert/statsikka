'use strict';
// Keinotekoiset Overwolf GEP -viestit testejä varten (selftest + savutesti). Muoto on sama kuin ow-electronin
// `new-info-update` / `new-game-event` -tapahtumissa: { gameId, feature, category, key, value }; roster-arvot ovat JSON-merkkijonoja.
// Ei verkkoa, ei Overwolfia, ei pelejä. Käyttö: const { play } = require('./gep-sim'); play(feedApi, sekvenssi).
const R6_ID = 10826;
const OW_ID = 10844;

const info = (gameId, feature, category, key, value) => ({ kind: 'info', game: gameId, msg: { gameId, feature, category, key, value } });
const event = (gameId, feature, key, value) => ({ kind: 'event', game: gameId, msg: { gameId, feature, key, value } });

// ---- Rainbow Six Siege ----------------------------------------------------------------------------------------
const R6_OPERATORS = ['JACKAL', 'ASH', 'THERMITE', 'SLEDGE', 'CAVEIRA', 'JAGER', 'IQ', 'DOKKAEBI', 'MIRA', 'CAPITAO'];
// p: { id, name, local, team: 'Blue' | 'Orange', operator, kills, deaths, assists, score }
function r6PlayerJson(p, i) {
  return JSON.stringify({
    player: p.name, is_anonymous: !!p.anonymous, suffix: p.anonymous ? 355 : undefined, player_id: p.id, is_local: !!p.local, team: p.team,
    operator: p.operator || R6_OPERATORS[i % R6_OPERATORS.length], kills: p.kills || 0, deaths: p.deaths || 0, score: p.score || 0, assists: p.assists || 0, ping: 30 + i,
  });
}
// 10 pelaajaa: 5 Blue (paikallinen ensin) + 5 Orange. known = [{ id, name }] (enintään 8: ensimmäinen on paikallinen pelaaja), loput keksitään (tuntemattomia).
function r6Players(known) {
  const list = [];
  for (let i = 0; i < 10; i++) {
    const k = known && known[i];
    list.push({
      id: k ? k.id : `00000000-0000-4000-8000-0000000000${String(10 + i)}`, name: k ? k.name : `GepUusi${i}`, local: i === 0, team: i < 5 ? 'Blue' : 'Orange',
      anonymous: !k && i === 9, kills: (i * 3) % 7, deaths: (i * 5) % 4, assists: i % 3, score: 100 + i * 37,
    });
  }
  return list;
}
function r6Roster(players) {
  return players.map((p, i) => info(R6_ID, 'roster', 'players', `roster_${i}`, r6PlayerJson(p, i)));
}
// Ottelun alku: vaihe, rosteri (ennen match_start-tapahtumaa, kuten oikeassa pelissä), ottelutiedot, pisteet, alkutapahtumat ja terveyspäivityksiä.
function r6Start(players) {
  return [
    info(R6_ID, 'game_info', 'game_info', 'phase', 'operator_select'),
    ...r6Roster(players),
    info(R6_ID, 'match_info', 'match_info', 'map_id', 'KAFE DOSTOYEVSKY'),
    info(R6_ID, 'match_info', 'match_info', 'game_mode', '{"playlist": "RANKED" , "game_type": "ESSENTIALS" , "mode_name" : "BOMB"}'),
    info(R6_ID, 'match_info', 'match_info', 'match_id', '18F5D014-3FB9-0510-9083-DF555E39AD2B'),
    info(R6_ID, 'match_info', 'match_info', 'pseudo_match_id', '9800ba24-7da7-4e3a-8ab1-a74405780444'),
    info(R6_ID, 'match', 'match', 'score', '{"blue":"0","orange":"0"}'),
    event(R6_ID, 'match_info', 'match_start', ''),
    info(R6_ID, 'match', 'round', 'number', '1'),
    event(R6_ID, 'match', 'roundStart', ''),
    info(R6_ID, 'roster', 'player', 'health', '120'),
  ];
}
// Kierroksen jälkeen: pisteet, tappoja/kuolemia (osapäivitys paikalliselle pelaajalle ja rosterin päivitys), tappofeed.
function r6Progress(players) {
  const p0 = { ...players[0], kills: 5, deaths: 2, assists: 1, score: 640 };
  return [
    info(R6_ID, 'match', 'match', 'score', '{"blue":"1","orange":"0"}'),
    info(R6_ID, 'match', 'round', 'number', '2'),
    info(R6_ID, 'roster', 'players', 'roster_0', r6PlayerJson(p0, 0)),
    info(R6_ID, 'roster', 'player', 'kills', '6'),
    info(R6_ID, 'roster', 'player', 'health', '70'),
    event(R6_ID, 'match_info', 'kill_feed', '{"attacker":"overwolfqa","victim":"overwolfPTW","weapon_type":"assault_rifle","headshot":true}'),
  ];
}
const r6End = () => [event(R6_ID, 'match_info', 'match_end', ''), event(R6_ID, 'match', 'matchOutcome', 'victory')];

// ---- Overwatch 2 ------------------------------------------------------------------------------------------------
// p: { name, tag, local, teammate, team: 0 | 1, hero, role, k, d, a, dmg, healed, mit }; tag puuttuu -> ei battlenet_tag-kenttää
function owPlayerJson(p) {
  const o = {
    player_name: p.name, is_local: !!p.local, hero_name: p.hero, hero_role: p.role, team: p.team, kills: p.k || 0, deaths: p.d || 0, damage: p.dmg || 0, assists: p.a || 0,
    healed: p.healed || 0, mitigated: p.mit || 0, hero_id: 121, is_teammate: !!p.teammate,
  };
  if (p.tag) o.battlenet_tag = p.tag;
  return JSON.stringify(o);
}
// Oikeita julkisia BattleTageja (TeKrop#2217) ja keinotekoisia profiileja savutestin koukusta (Synth/Priv) sekä järjetön tunnus.
const OW_PLAYERS = [
  { name: 'SMOKEOWN', tag: 'SmokeOwn#9999', local: true, teammate: true, team: 0, hero: 'ANA', role: 'SUPPORT', k: 12, d: 3, a: 8, dmg: 2500.5, healed: 9000.25, mit: 0 },
  { name: 'SYNTH', tag: 'Synth#1111', teammate: true, team: 0, hero: 'WIDOWMAKER', role: 'DAMAGE', k: 9, d: 4, a: 2, dmg: 4100, healed: 0, mit: 0 },
  { name: 'SYNTH2', tag: 'Synth#2222', teammate: true, team: 0, hero: 'REINHARDT', role: 'TANK', k: 5, d: 6, a: 3, dmg: 3000, healed: 0, mit: 8100 },
  { name: 'SYNTH3', tag: 'Synth#3333', teammate: true, team: 0, hero: 'LUCIO', role: 'SUPPORT', k: 2, d: 5, a: 11, dmg: 900, healed: 7000, mit: 0 },
  { name: 'TEKROP', tag: 'TeKrop#2217', teammate: true, team: 0, hero: 'SOLDIER_76', role: 'DAMAGE', k: 7, d: 3, a: 1, dmg: 3500, healed: 0, mit: 0 },
  { name: 'PRIV', tag: 'Priv#4444', teammate: false, team: 1, hero: '', role: '', k: 4, d: 8, a: 2, dmg: 2000, healed: 0, mit: 0 },
  { name: 'ZZQXKV', tag: 'Zzqxkv#99999', teammate: false, team: 1, hero: '', role: '', k: 6, d: 7, a: 0, dmg: 2600, healed: 0, mit: 0 },
  { name: 'ANONYYMI', teammate: false, team: 1, hero: '', role: '', k: 1, d: 9, a: 3, dmg: 1200, healed: 0, mit: 0 }, // ei BattleTagia: ei haettavissa
];
function owRoster(players) {
  return players.map((p, i) => info(OW_ID, 'roster', 'roster', `roster_${i}`, owPlayerJson(p)));
}
function owStart(players = OW_PLAYERS) {
  return [
    info(OW_ID, 'game_info', 'game_info', 'game_state', 'loading_screen_start'),
    info(OW_ID, 'game_info', 'game_info', 'battle_tag', players[0].tag),
    ...owRoster(players),
    info(OW_ID, 'game_info', 'game_info', 'game_mode', '0020'),
    info(OW_ID, 'game_info', 'match_info', 'game_type', 'UNRANKED'),
    info(OW_ID, 'match_info', 'match_info', 'map', '3603'),
    info(OW_ID, 'match_info', 'match_info', 'match_id', '602871308'),
    event(OW_ID, 'match_info', 'match_start', ''),
    info(OW_ID, 'game_info', 'game_info', 'game_state', 'match_in_progress'),
  ];
}
function owProgress(players = OW_PLAYERS) {
  const p0 = { ...players[0], k: 15, d: 3, a: 9, dmg: 3100, healed: 12500 };
  return [
    info(OW_ID, 'roster', 'roster', 'roster_0', owPlayerJson(p0)),
    event(OW_ID, 'match_info', 'kill_feed', '{"attacker":"brandy","victim":"SpectralSoul","is_attacker_teammate":false,"is_victim_teammate":false,"attacker_hero_name":"GENJI","victim_hero_name":"SOJOURN"}'),
  ];
}
const owEnd = () => [event(OW_ID, 'match_info', 'match_end', ''), info(OW_ID, 'match_info', 'match_info', 'match_outcome', 'victory')];

// feed = { info(game, msg), event(game, msg) }; seq = taulukko edellä olevista. Palauttaa toistettujen viestien määrän.
function play(feed, seq) {
  for (const s of seq) {
    if (s.kind === 'info') feed.info(s.game, s.msg); else feed.event(s.game, s.msg);
  }
  return seq.length;
}

module.exports = {
  R6_ID, OW_ID, R6_OPERATORS, OW_PLAYERS, info, event,
  r6PlayerJson, r6Players, r6Roster, r6Start, r6Progress, r6End, owPlayerJson, owRoster, owStart, owProgress, owEnd, play,
};
