'use strict';
// WebSocket-asiakas Rocket Leaguen Stats API:lle (main-prosessissa, Node/Electronin globaali WebSocket).
const { parseFrames } = require('./rl-core');

const RECONNECT_MS = 3000;

function createRlClient({ getPort, tracker, onStatus, WebSocketImpl }) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  let ws = null;
  let timer = null;
  let stopped = false;
  let open = false;
  let status = 'disconnected';

  const decoder = new TextDecoder();

  function setStatus(s) {
    if (s !== status) { status = s; onStatus(s); }
  }

  async function toText(data) {
    if (typeof data === 'string') return data;
    if (data && typeof data.text === 'function') return data.text();   // Blob
    if (data instanceof ArrayBuffer) return decoder.decode(data);
    if (ArrayBuffer.isView(data)) return decoder.decode(data);
    return String(data);
  }

  function refreshStatus() {
    if (!open) setStatus('disconnected');
    else setStatus(tracker.hasMatch ? 'connected' : 'waiting');
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, RECONNECT_MS);
  }

  function connect() {
    if (stopped || !WS) { if (!WS) setStatus('disconnected'); return; }
    let sock;
    try {
      sock = new WS(`ws://127.0.0.1:${getPort()}`);
    } catch (_) {
      setStatus('disconnected');
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => { open = true; refreshStatus(); };
    sock.onmessage = async (ev) => {
      try {
        const text = await toText(ev.data);
        for (const m of parseFrames(text)) tracker.handle(m);
        refreshStatus();
      } catch (_) { /* viallinen kehys ohitetaan */ }
    };
    const onEnd = () => {
      if (ws !== sock) return;
      ws = null; open = false;
      tracker.resetMatch();
      refreshStatus();
      tracker.onChange('Disconnected');
      scheduleReconnect();
    };
    sock.onclose = onEnd;
    sock.onerror = () => { /* close-tapahtuma seuraa */ };
  }

  function reconnect() {
    if (timer) { clearTimeout(timer); timer = null; }
    const old = ws;
    ws = null; open = false;
    if (old) { try { old.close(); } catch (_) { /* ei väliä */ } }
    refreshStatus();
    connect();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (ws) { try { ws.close(); } catch (_) { /* ei väliä */ } }
  }

  return { connect, reconnect, stop, getStatus: () => status, refreshStatus };
}

module.exports = { createRlClient, RECONNECT_MS };
