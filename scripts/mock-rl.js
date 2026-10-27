'use strict';
// Rocket League Stats API -simulaattori: ws://127.0.0.1:49130 (3v3). Käynnistys: npm run mock-rl
const { WebSocketServer } = require('ws');

// Oletus 49130 eikä pelin 49124: käynnissä oleva oikea Statsikka ei saa yhdistää mockiin ja tallentaa testiotteluita historiaan.
const PORT = Number(process.env.MOCK_RL_PORT || 49130);
const MATCH_SECONDS = Number(process.env.MOCK_RL_MATCH_SECONDS || 60);
const TICK_MS = 200; // 5 Hz

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => console.log(`[mock-rl] kuuntelee ws://127.0.0.1:${PORT}`));
wss.on('error', (e) => { console.error('[mock-rl] virhe:', e.message); process.exit(1); });
wss.on('connection', (ws) => {
  console.log('[mock-rl] asiakas yhdistetty');
});

function send(obj, only) {
  const txt = JSON.stringify(obj);
  for (const c of only ? [only] : wss.clients) if (c.readyState === 1) c.send(txt);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const NAMES = {
  0: [['Akseli', 'Epic|8a1f2b3c4d5e6f708192a3b4c5d6e7f8|0'], ['BlueBolt', 'Steam|76561198000000001|0'], ['Kaasu', 'Steam|76561198000000002|0']],
  1: [['OrangeFox', 'Steam|76561198000000003|0'], ['Salama', 'Epic|11112222333344445555666677778888|0'], ['Pylväs', 'PS5|PSN_Pylvas|0']],
};
const ARENAS = ['Stadium_P', 'Park_P', 'cs_p', 'EuroStadium_P', 'NeoTokyo_P', 'UtopiaStadium_P'];

let match = null;
let timers = [];

function newMatch() {
  const players = [];
  for (const team of [0, 1]) for (const [Name, PrimaryId] of NAMES[team]) {
    players.push({ Name, PrimaryId, Shortcut: players.length + 1, TeamNum: team, Score: 0, Goals: 0, Shots: 0, Assists: 0, Saves: 0, Touches: 0, CarTouches: 0, Demos: 0 });
  }
  match = {
    guid: `MOCK${Date.now().toString(16).toUpperCase()}${Math.floor(rnd(0, 65535)).toString(16).toUpperCase()}`,
    players, scores: [0, 0], time: 300, arena: pick(ARENAS), started: Date.now(), ended: false, hasWinner: false, winner: null,
  };
  return match;
}

function updateState() {
  const m = match;
  send({
    Event: 'UpdateState',
    Data: {
      MatchGuid: m.guid,
      Players: m.players.map((p) => ({ ...p })),
      Game: {
        Teams: [
          { Name: 'Blue', TeamNum: 0, Score: m.scores[0], ColorPrimary: '0044FF', ColorSecondary: '002266' },
          { Name: 'Orange', TeamNum: 1, Score: m.scores[1], ColorPrimary: 'FF8800', ColorSecondary: '884400' },
        ],
        PlaylistId: 13, TimeSeconds: Math.max(0, Math.round(m.time)), bOvertime: false,
        Ball: { Speed: Math.round(rnd(0, 2800)), TeamNum: 255 },
        bReplay: false, bHasWinner: m.hasWinner, Winner: m.winner === null ? '' : (m.winner === 0 ? 'Blue' : 'Orange'),
        Arena: m.arena, bHasTarget: false, Target: { Name: '', Shortcut: 0, TeamNum: 255 },
      },
    },
  });
}

function ref(p) { return { Name: p.Name, Shortcut: p.Shortcut, TeamNum: p.TeamNum }; }

function randomEvent() {
  const m = match;
  const p = pick(m.players);
  const r = Math.random();
  if (r < 0.14) {
    const mates = m.players.filter((x) => x.TeamNum === p.TeamNum && x !== p);
    const a = Math.random() < 0.6 ? pick(mates) : null;
    p.Goals++; p.Shots++; p.Score += 100; m.scores[p.TeamNum]++;
    if (a) { a.Assists++; a.Score += 50; }
    send({ Event: 'GoalScored', Data: { MatchGuid: m.guid, GoalSpeed: rnd(900, 3300), GoalTime: m.time, ImpactLocation: { X: 0, Y: 5120, Z: 300 }, Scorer: ref(p), Assister: a ? ref(a) : undefined, BallLastTouch: { Player: ref(p), Speed: 2000 } } });
    send({ Event: 'StatfeedEvent', Data: { MatchGuid: m.guid, EventName: 'Goal', Type: 'Goal', MainTarget: ref(p) } });
  } else if (r < 0.38) {
    p.Saves++; p.Score += 50;
    send({ Event: 'StatfeedEvent', Data: { MatchGuid: m.guid, EventName: Math.random() < 0.2 ? 'EpicSave' : 'Save', Type: 'Save', MainTarget: ref(p) } });
  } else if (r < 0.52) {
    const foes = m.players.filter((x) => x.TeamNum !== p.TeamNum);
    const v = pick(foes);
    p.Demos++; p.Score += 25;
    send({ Event: 'StatfeedEvent', Data: { MatchGuid: m.guid, EventName: 'Demolish', Type: 'Demolition', MainTarget: ref(p), SecondaryTarget: ref(v) } });
  } else {
    p.Shots++; p.Score += 20;
    send({ Event: 'StatfeedEvent', Data: { MatchGuid: m.guid, EventName: 'Shot', Type: 'Shot', MainTarget: ref(p) } });
  }
}

function run() {
  const m = newMatch();
  console.log(`[mock-rl] uusi ottelu ${m.guid} (${m.arena})`);
  send({ Event: 'MatchCreated', Data: { MatchGuid: m.guid } });
  send({ Event: 'MatchInitialized', Data: { MatchGuid: m.guid } });
  send({ Event: 'CountdownBegin', Data: { MatchGuid: m.guid } });
  send({ Event: 'RoundStarted', Data: { MatchGuid: m.guid } });
  let lastEvt = 0;
  const tick = setInterval(() => {
    if (m.ended) return;
    m.time -= (300 / MATCH_SECONDS) * (TICK_MS / 1000);
    for (const p of m.players) { p.Touches += Math.random() < 0.4 ? 1 : 0; p.CarTouches = p.Touches; }
    if (Date.now() - lastEvt > 1200) { lastEvt = Date.now(); randomEvent(); }
    updateState();
    send({ Event: 'ClockUpdatedSeconds', Data: { MatchGuid: m.guid, TimeSeconds: Math.max(0, Math.round(m.time)), bOvertime: false } });
    if (Date.now() - m.started >= MATCH_SECONDS * 1000) finish(m, tick);
  }, TICK_MS);
  timers.push(tick);
}

function finish(m, tick) {
  m.ended = true;
  clearInterval(tick);
  if (m.scores[0] === m.scores[1]) { m.scores[Math.random() < 0.5 ? 0 : 1]++; }
  m.winner = m.scores[0] > m.scores[1] ? 0 : 1;
  m.hasWinner = true; m.time = 0;
  updateState();
  send({ Event: 'MatchEnded', Data: { MatchGuid: m.guid, WinnerTeamNum: m.winner } });
  send({ Event: 'PodiumStart', Data: { MatchGuid: m.guid } });
  console.log(`[mock-rl] ottelu päättyi ${m.scores[0]}-${m.scores[1]}`);
  setTimeout(() => {
    send({ Event: 'MatchDestroyed', Data: { MatchGuid: m.guid } });
    match = null;
    setTimeout(run, 4000);
  }, 3000);
}

run();
process.on('SIGINT', () => { timers.forEach(clearInterval); wss.close(() => process.exit(0)); });
