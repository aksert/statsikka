'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, arg) => ipcRenderer.invoke(channel, arg);
const subscribe = (channel, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),

  owSearch: (name) => call('ow:search', name),
  owProfile: (arg) => call('ow:profile', arg),
  onOwNotice: (cb) => subscribe('ow:notice', cb),
  owLobbyRecord: (arg) => call('ow:lobby:record', arg),
  owEncounters: (tag) => call('ow:encounters', tag),

  gameState: () => call('game:state'),
  onGameState: (cb) => subscribe('game:state', cb),
  onGameMatchStart: (cb) => subscribe('game:matchStart', cb),
  onGameLaunch: (cb) => subscribe('game:launch', cb),
  onAppOpenGame: (cb) => subscribe('app:openGame', cb),

  gepState: () => call('gep:state'),
  gepDiag: () => call('gep:diag'),
  onGepUpdate: (cb) => subscribe('gep:update', cb),
  overwolfStatus: () => call('overwolf:status'),
  overwolfEnable: (arg) => call('overwolf:enable', arg),
  overwolfClear: () => call('overwolf:clear'),

  profileGet: () => call('profile:get'),
  profileOwRefresh: () => call('profile:ow:refresh'),
  profileOwProgress: (arg) => call('profile:ow:progress', arg),
  profileOwProgressDelete: (id) => call('profile:ow:progress:delete', id),
  profileOwHistoryReset: () => call('profile:ow:history:reset'),
  profileRlRank: (arg) => call('profile:rl:rank', arg),
  profileRlRankDelete: (id) => call('profile:rl:rank:delete', id),
  onProfileUpdate: (cb) => subscribe('profile:update', cb),

  r6Assess: (arg) => call('r6:assess', arg),
  r6Status: () => call('r6:status'),
  r6Own: (arg) => call('r6:own', arg),
  r6Matches: (arg) => call('r6:matches', arg),
  r6Match: (name) => call('r6:match', name),
  r6Live: () => call('r6:live'),
  r6Players: (arg) => call('r6:players', arg),
  r6Player: (id) => call('r6:player', id),
  r6Rescan: () => call('r6:rescan'),
  r6PickDir: () => call('r6:pickDir'),
  onR6Update: (cb) => subscribe('r6:update', cb),

  arenyzeStatus: () => call('arenyze:status'),
  arenyzeTest: (arg) => call('arenyze:test', arg),
  arenyzeClearKey: () => call('arenyze:clearKey'),
  arenyzeUsage: () => call('arenyze:usage'),
  arenyzeClearCache: () => call('arenyze:clearCache'),
  arenyzeLookup: (arg) => call('arenyze:lookup', arg),
  onArenyzeUpdate: (cb) => subscribe('arenyze:update', cb),

  rlState: () => call('rl:state'),
  onRlUpdate: (cb) => subscribe('rl:update', cb),
  rlHistory: () => call('rl:history'),
  rlPlayer: (key) => call('rl:player', key),
  rlPlayers: (arg) => call('rl:players', arg),
  rlClearHistory: () => call('rl:history:clear'),
  rlDetect: () => call('rl:detect'),
  rlPickDir: () => call('rl:pickDir'),
  rlInspect: (dir) => call('rl:inspect', dir),
  rlEnable: (dir) => call('rl:enable', dir),

  updaterState: () => call('updater:state'),
  updaterCheck: () => call('updater:check'),
  updaterInstall: () => call('updater:install'),
  onUpdaterState: (cb) => subscribe('updater:state', cb),

  appInfo: () => call('app:info'),
  clearCache: () => call('app:clearCache'),
  openExternal: (url) => call('app:openExternal', url),
  copyText: (text) => call('app:copy', text),
});
