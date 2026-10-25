// Servidor WebSocket: estado ao vivo + replay individual por cliente.
// Heartbeat ping/pong de 30s e descarte de cliente lento (> 4MB em buffer).
import { WebSocketServer, WebSocket } from 'ws';
import { DB_PATH } from '../shared/config.js';
import { openDb, latestSnapshot } from './db.js';
import { latestMarketRows } from './markets.js';
import { ReplaySession } from './replay.js';
import bus from './bus.js';

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED = 4 * 1024 * 1024;
const MAX_PAYLOAD = 1024 * 1024;

function parsePayload(row) {
  if (!row) return null;
  try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

function stateNow(db) {
  return parsePayload(latestSnapshot(db));
}

function marketsNow(db) {
  return latestMarketRows(db);
}

/** Epoch ms ou ISO -> ISO; null se invalido. */
function toIso(value) {
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Cria o servidor WebSocket sobre um http.Server existente.
 * @param {{server: import('node:http').Server, db?: object, bus?: object, dbPath?: string}} deps
 */
export function createWs({ server, db, bus: events = bus, dbPath } = {}) {
  if (!server) throw new Error('createWs: server obrigatorio');
  if (!db) throw new Error('createWs: db obrigatorio');

  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD, path: '/ws' });
  const sockets = new Map();

  function send(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      // Cliente lento: descarta em vez de acumular memoria.
      try { ws.terminate(); } catch { /* ja fechado */ }
      return false;
    }
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(msg, onlyLive = true) {
    for (const entry of sockets.values()) {
      if (onlyLive && entry.replay.mode !== 'live') continue;
      send(entry.ws, msg);
    }
  }

  wss.on('connection', (ws) => {
    const entry = {
      ws,
      alive: true,
      replay: new ReplaySession({ db, send: (msg) => send(ws, msg) }),
    };
    sockets.set(ws, entry);

    send(ws, {
      type: 'hello',
      serverTime: new Date().toISOString(),
      mode: 'live',
      state: stateNow(db),
      markets: marketsNow(db),
      replay: entry.replay.state,
    });

    ws.on('pong', () => { entry.alive = true; });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send(ws, { type: 'error', message: 'json invalido' });
        return;
      }
      const type = msg?.type;

      if (type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
      if (type === 'live') {
        entry.replay.toLive();
        // Ao voltar ao vivo, entrega o estado atual na hora.
        const state = stateNow(db);
        if (state) send(ws, { type: 'snapshot', state, changes: [], ts: state.ts ?? new Date().toISOString() });
        return;
      }
      if (type === 'speed') {
        entry.replay.setSpeed(msg.x);
        return;
      }
      if (type === 'seek') {
        const ts = toIso(msg.t);
        if (!ts) {
          send(ws, { type: 'error', message: 'seek: t invalido' });
          return;
        }
        entry.replay.seek(ts);
        return;
      }
      send(ws, { type: 'error', message: `tipo desconhecido: ${type ?? '-'}` });
    });

    ws.on('close', () => {
      entry.replay.stop();
      sockets.delete(ws);
    });
    ws.on('error', () => { entry.replay.stop(); });
  });

  const onSnapshot = ({ state, changes }) => {
    if (!state) return;
    broadcast({ type: 'snapshot', state, changes: changes ?? [], ts: state.ts ?? new Date().toISOString() });
  };

  const onMarkets = (payload) => {
    broadcast({ type: 'markets', markets: payload, ts: payload?.ts ?? new Date().toISOString() });
  };

  const onError = (err) => {
    broadcast({ type: 'error', message: err?.message ?? String(err) }, false);
  };

  const heartbeat = setInterval(() => {
    for (const entry of sockets.values()) {
      if (!entry.alive) {
        try { entry.ws.terminate(); } catch { /* ja fechado */ }
        sockets.delete(entry.ws);
        continue;
      }
      entry.alive = false;
      try { entry.ws.ping(); } catch { /* ignora */ }
      if (entry.ws.bufferedAmount > MAX_BUFFERED) {
        try { entry.ws.terminate(); } catch { /* ignora */ }
        sockets.delete(entry.ws);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  events.on('snapshot', onSnapshot);
  events.on('markets', onMarkets);
  events.on('error', onError);

  let closing = null;
  const close = () => {
    if (closing) return closing;
    clearInterval(heartbeat);
    events.off('snapshot', onSnapshot);
    events.off('markets', onMarkets);
    events.off('error', onError);
    const pending = [...sockets.values()];
    for (const entry of pending) {
      entry.replay.stop();
      try { entry.ws.close(1001, 'servidor encerrando'); } catch { /* ignora */ }
    }
    sockets.clear();
    // Nao deixa o shutdown preso em handshake lento.
    const force = setTimeout(() => {
      wss.clients.forEach((client) => {
        try { client.terminate(); } catch { /* ignora */ }
      });
    }, 250);
    force.unref?.();
    closing = new Promise((resolve) => wss.close(() => {
      clearTimeout(force);
      resolve();
    }));
    return closing;
  };

  server.once('close', () => { close(); });

  return { wss, close, clients: sockets };
}

/** Monta o WS no servidor (usado por index.js; abre o banco se nao vier). */
export function attach(server, deps = {}) {
  const owned = !deps.db;
  const db = deps.db ?? openDb(deps.dbPath ?? DB_PATH);
  const instance = createWs({ server, db, bus: deps.bus ?? bus });
  instance.owned = owned;
  if (owned) {
    server.once('close', () => {
      try { db.close(); } catch { /* ja fechado */ }
    });
  }
  return instance;
}

export default { createWs, attach };
