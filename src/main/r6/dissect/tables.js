'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/header.go, operator_string.go, map_string.go, operator_roles.go,
// matchtype_string.go, gamemode_string.go, matchupdatetype_string.go, version.go.
const OPERATOR_NAMES = {
  359656345734: 'Recruit',
  92270642682: 'Castle',
  104189664704: 'Aruni',
  161289666230: 'Kaid',
  174977508820: 'Mozzie',
  92270642708: 'Pulse',
  104189664390: 'Ace',
  92270642214: 'Echo',
  378305069945: 'Azami',
  391752120891: 'Solis',
  92270644215: 'Capitao',
  92270644189: 'Zofia',
  92270644267: 'Dokkaebi',
  104189662920: 'Warden',
  92270644319: 'Mira',
  92270642344: 'Sledge',
  104189664273: 'Melusi',
  92270642526: 'Bandit',
  92270642188: 'Valkyrie',
  92270644059: 'Rook',
  92270641980: 'Kapkan',
  291191151607: 'Zero',
  104189664038: 'Iana',
  92270642656: 'Ash',
  92270642136: 'Blackbeard',
  288200867444: 'Osa',
  373711624351: 'Thorn',
  92270642604: 'Jager',
  104189663920: 'Kali',
  92270642760: 'Thermite',
  288200866821: 'Brava',
  104189663607: 'Amaru',
  92270642292: 'Ying',
  92270642266: 'Lesion',
  92270644007: 'Doc',
  104189661861: 'Lion',
  92270642032: 'Fuze',
  92270642396: 'Smoke',
  92270644293: 'Vigil',
  92270642318: 'Mute',
  104189663698: 'Goyo',
  104189663803: 'Wamai',
  92270644163: 'Ela',
  92270644033: 'Montagne',
  104189663024: 'Nokk',
  104189662071: 'Alibi',
  104189661965: 'Finka',
  92270644241: 'Caveira',
  161289666248: 'Nomad',
  288200867351: 'Thunderbird',
  384797789346: 'Sens',
  92270642578: 'IQ',
  92270642539: 'Blitz',
  92270642240: 'Hibana',
  104189662384: 'Maverick',
  328397386974: 'Flores',
  92270642474: 'Buck',
  92270644111: 'Twitch',
  174977508808: 'Gridlock',
  92270642422: 'Thatcher',
  92270642084: 'Glaz',
  92270644345: 'Jackal',
  374667788042: 'Grim',
  291437347686: 'Tachanka',
  104189664155: 'Oryx',
  92270642500: 'Frost',
  104189662175: 'Maestro',
  104189662280: 'Clash',
  288200867339: 'Fenrir',
  395943091136: 'Ram',
  288200867549: 'Tubarao',
  374667787816: 'Deimos',
  409899350463: 'Striker',
  409899350403: 'Sentry',
  386098331713: 'Skopos',
  386098331923: 'Rauora',
  374667787937: 'Denari',
  // Y11 operators. Ids from Animuxs/r6-stats-app and prestonwillis10/r6-dissect (MIT); roles verified on
  // Y11S3 replays (Solid Snake: 19 rounds on the attacking team, Noor: 1 round on the defending team).
  444310693746: 'Solid Snake',
  456757346397: 'Noor',
};
const MAP_NAMES = {
  837214085: 'ClubHouse',
  1378191338: 'KafeDostoyevsky',
  1460220617: 'Kanal',
  1767965020: 'Yacht',
  2609218856: 'PresidentialPlane',
  2609221242: 'ConsulateY7',
  2697268122: 'BartlettU',
  42090092951: 'Coastline',
  53627213396: 'Tower',
  88107330328: 'Villa',
  126196841359: 'Fortress',
  127951053400: 'HerefordBase',
  199824623654: 'ThemePark',
  231702797556: 'Oregon',
  237873412352: 'House',
  259816839773: 'Chalet',
  276279025182: 'Skyscraper',
  305979357167: 'Border',
  329867321446: 'Favela',
  355496559878: 'Bank',
  362605108559: 'Outback',
  365284490964: 'EmeraldPlains',
  270063334510: 'StadiumBravo',
  378595635123: 'NighthavenLabs',
  379218689149: 'Consulate',
  388073319671: 'Lair',
  405306299908: 'Stadium2020',
  413779563590: 'BankY10',
  407987100456: 'BorderY10',
  407558616688: 'ChaletY10',
  407193663917: 'ClubHouseY10',
  413845419788: 'KafeDostoyevskyY10',
  417890697769: 'LairY10',
  418119057546: 'NighthavenLabsY10',
  418126004176: 'ConsulateY10',
  // Ids of the Y10 rework maps below: Animuxs/r6-stats-app (MIT).
  398899676157: 'FortressY10',
  436375283234: 'CoastlineY10',
  409325881472: 'VillaY10',
  423767322185: 'TowerY10',
  // Identified from the bomb site / spawn names inside Y11S3 replays (not from game files); the Y10/Y11
  // suffix of these reworks is inferred from the id order.
  434715462383: 'OregonY10', // sites: 2F Kids' Dorms + Dorms Main Hall, B Laundry Room + Supply Room, 1F Kitchen + Dining Hall
  441825219764: 'OutbackY11', // sites: 2F Laundry + Piano Room, 2F Party Room + Office; spawns: Fuel Pumps, Camping
  441408792952: 'KanalY11', // sites: 2F Server Room + Radar Room, B1 Kayaks + Supply Room; spawns: Sailboats, Floating Dock
  // 419965653950 stays unknown: sites 2F Cigar Room + Pool, B CCTV + Vault Checkpoint; spawns: Poolside, Garden Ruins
};
const OPERATOR_ROLES = {
  104189661861: 'Attack',
  104189661965: 'Attack',
  104189662071: 'Defense',
  104189662175: 'Defense',
  104189662280: 'Defense',
  104189662384: 'Attack',
  104189662920: 'Defense',
  104189663024: 'Attack',
  104189663607: 'Attack',
  104189663698: 'Defense',
  104189663803: 'Defense',
  104189663920: 'Attack',
  104189664038: 'Attack',
  104189664155: 'Defense',
  104189664273: 'Defense',
  104189664390: 'Attack',
  104189664704: 'Defense',
  161289666230: 'Defense',
  161289666248: 'Attack',
  174977508808: 'Attack',
  174977508820: 'Defense',
  288200866821: 'Attack',
  288200867339: 'Defense',
  288200867351: 'Defense',
  288200867444: 'Attack',
  288200867549: 'Defense',
  291191151607: 'Attack',
  291437347686: 'Defense',
  328397386974: 'Attack',
  373711624351: 'Defense',
  374667787816: 'Attack',
  374667787937: 'Defense',
  374667788042: 'Attack',
  378305069945: 'Defense',
  384797789346: 'Attack',
  386098331713: 'Defense',
  386098331923: 'Attack',
  391752120891: 'Defense',
  395943091136: 'Attack',
  409899350403: 'Defense',
  409899350463: 'Attack',
  444310693746: 'Attack', // Solid Snake
  456757346397: 'Defense', // Noor
  92270641980: 'Defense',
  92270642032: 'Attack',
  92270642084: 'Attack',
  92270642136: 'Attack',
  92270642188: 'Defense',
  92270642214: 'Defense',
  92270642240: 'Attack',
  92270642266: 'Defense',
  92270642292: 'Attack',
  92270642318: 'Defense',
  92270642344: 'Attack',
  92270642396: 'Defense',
  92270642422: 'Attack',
  92270642474: 'Attack',
  92270642500: 'Defense',
  92270642526: 'Defense',
  92270642539: 'Attack',
  92270642578: 'Attack',
  92270642604: 'Defense',
  92270642656: 'Attack',
  92270642682: 'Defense',
  92270642708: 'Defense',
  92270642760: 'Attack',
  92270644007: 'Defense',
  92270644033: 'Attack',
  92270644059: 'Defense',
  92270644111: 'Attack',
  92270644163: 'Defense',
  92270644189: 'Attack',
  92270644215: 'Attack',
  92270644241: 'Defense',
  92270644267: 'Attack',
  92270644293: 'Defense',
  92270644319: 'Defense',
  92270644345: 'Attack',
};

// 13 is not in upstream: single 5v5 round, free operator choice with repeated operators, respawns, team score = kills
// (e.g. 79:62) -> a team deathmatch style arcade playlist (name inferred from replay data).
const MATCH_TYPES = { 1: 'QuickMatch', 2: 'Ranked', 3: 'CustomGameLocal', 4: 'CustomGameOnline', 8: 'Standard', 9: 'Unranked', 13: 'TeamDeathmatch' };
const GAME_MODES = { 327933806: 'Bomb', 1983085217: 'SecureArea', 2838806006: 'Hostage', 400168582901: 'QuickMatchBomb', 32905809967: 'TeamDeathmatch' };
const MATCH_UPDATE_TYPES = ['Kill', 'Death', 'DefuserPlantStart', 'DefuserPlantComplete', 'DefuserDisableStart',
  'DefuserDisableComplete', 'LocateObjective', 'OperatorSwap', 'Battleye', 'PlayerLeave', 'Other'];
const T = { Kill: 0, Death: 1, DefuserPlantStart: 2, DefuserPlantComplete: 3, DefuserDisableStart: 4,
  DefuserDisableComplete: 5, LocateObjective: 6, OperatorSwap: 7, Battleye: 8, PlayerLeave: 9, Other: 10 };

const RECRUIT = 359656345734;

// Code versions (version.go)
const V = {
  Y7S1: 6884476, Y7S2: 7040830, Y7S4: 7338571, Y8S1: 7408213, Y8S2: 7601998, Y8S3: 7762708, Y8S4: 7921866,
  Y9S1: 8111697, Y9S1Update3: 8211379, Y9S2: 8303162, Y9S3: 8506016, Y9S4: 8673114, Y10S1: 8825661,
};

/** 'Attack' | 'Defense' | 'Unknown' (upstream panics for unknown IDs; we never throw). */
function operatorRole(id) {
  return OPERATOR_ROLES[id] || 'Unknown';
}
function operatorName(id) {
  return OPERATOR_NAMES[id] || `Operaattori ${id}`;
}
function mapName(id) {
  return MAP_NAMES[id] || `Kartta ${id}`;
}
function matchTypeName(id) {
  return MATCH_TYPES[id] || `MatchType(${id})`;
}
function gameModeName(id) {
  return GAME_MODES[id] || `GameMode(${id})`;
}
function matchUpdateTypeName(id) {
  return MATCH_UPDATE_TYPES[id] || `MatchUpdateType(${id})`;
}

module.exports = {
  OPERATOR_NAMES, MAP_NAMES, OPERATOR_ROLES, MATCH_TYPES, GAME_MODES, T, V, RECRUIT,
  operatorRole, operatorName, mapName, matchTypeName, gameModeName, matchUpdateTypeName,
};
