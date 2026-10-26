// API HTTP/JSON somente-leitura sobre os snapshots persistidos.
// Contrato: createApi({db, bus}) -> (req, res, next) => boolean (false = rota nao casou).
import { DB_PATH, UFS, UF_NAMES } from '../shared/config.js';
import {
  latestSnapshot, snapshotAt, previousSnapshot, timeline, changesSince, openDb,
} from './db.js';
import bus from './bus.js';
import { latestMarketRows } from './markets.js';

const MAX_HISTORY = 2000;
const MAX_TIMELINE = 3000;
const SOURCES = ['polymarket', 'kalshi'];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
    ...extra,
  });
  // HEAD nao leva corpo (o Node nao remove sozinho).
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

function parsePayload(row) {
  if (!row) return null;
  try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

function intParam(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** Mudancas registradas no intervalo (prevExclusivo, ts]. */
function changesBetween(db, prevTs, ts) {
  if (!prevTs) return [];
  try {
    return changesSince(db, prevTs).filter((c) => c.ts <= ts);
  } catch {
    return [];
  }
}

/** Mercados mais recentes por fonte, ja no formato publico. */
function marketsNow(db, at = null) {
  return latestMarketRows(db, at);
}

/** Pontos de scrubber em ordem crescente, reduzidos por passo uniforme. */
function downsample(rows, limit) {
  const ordered = [...rows].reverse();
  if (ordered.length <= limit) return ordered;
  const step = Math.ceil(ordered.length / limit);
  const out = [];
  for (let i = 0; i < ordered.length; i += step) out.push(ordered[i]);
  const last = ordered[ordered.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out.slice(0, limit);
}

/**
 * Cria o handler da API.
 * @param {{db: object, bus?: object}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
export function createApi({ db, bus: events = bus } = {}) {
  if (!db) throw new Error('createApi: db obrigatorio');

  return function handler(req, res, next) {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/api' && !path.startsWith('/api/')) {
      if (typeof next === 'function') next();
      return false;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { error: 'metodo nao permitido' }, { allow: 'GET, HEAD, OPTIONS' });
      return true;
    }

    const q = url.searchParams;
    let m;

    if (path === '/api/health') {
      send(res, 200, {
        ok: true,
        ts: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
        db: db !== undefined ? 'ok' : 'ausente',
      });
      return true;
    }

    if (path === '/api/state') {
      const latest = latestSnapshot(db);
      const state = parsePayload(latest);
      send(res, 200, { state, ts: latest?.ts ?? null, markets: marketsNow(db) });
      return true;
    }

    if (path === '/api/ufs') {
      const state = parsePayload(latestSnapshot(db));
      const ufs = Object.values(state?.ufs ?? {}).map((u) => ({
        uf: u.uf,
        name: u.name ?? UF_NAMES[u.uf] ?? String(u.uf).toUpperCase(),
        pct: u.pct ?? 0,
        countedSections: u.countedSections ?? 0,
        totalSections: u.totalSections ?? 0,
        leader: u.leader ?? null,
        margin: u.margin ?? 0,
      }));
      send(res, 200, { ufs, all: UFS });
      return true;
    }

    if (path === '/api/candidates') {
      const state = parsePayload(latestSnapshot(db));
      const markets = marketsNow(db);
      const probs = new Map();
      for (const source of SOURCES) {
        for (const row of markets[source] ?? []) {
          const n = row.candidateNumber;
          if (n) probs.set(n, { source, prob: row.prob, volume: row.volume, entity: row.entity });
        }
      }
      const candidates = (state?.candidates ?? []).map((c) => ({
        number: c.n,
        name: c.nm,
        urnName: c.nmu,
        party: c.party,
        color: c.color,
        votes: c.votes,
        pct: c.pct,
        market: probs.get(c.n) ?? null,
      }));
      send(res, 200, { candidates, pct: state?.national?.pct ?? 0 });
      return true;
    }

    if (path === '/api/history') {
      const limit = intParam(q.get('limit'), 500, MAX_HISTORY);
      const rows = timeline(db, {
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        limit,
      });
      const full = q.get('full') === '1';
      const items = [...rows].reverse().map((r) => ({
        ts: r.ts,
        pct: r.pct,
        hash: r.hash,
        ...(full ? { state: parsePayload(r) } : {}),
      }));
      send(res, 200, { items, count: items.length, limit });
      return true;
    }

    if (path === '/api/timeline') {
      const limit = intParam(q.get('limit'), 1500, MAX_TIMELINE);
      const rows = timeline(db, {
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        limit: MAX_TIMELINE,
      });
      const points = downsample(rows, limit).map((r) => ({ ts: r.ts, pct: r.pct }));
      send(res, 200, { points, limit });
      return true;
    }

    if ((m = path.match(/^\/api\/snapshot\/([^/]+)$/))) {
      const row = snapshotAt(db, decodeURIComponent(m[1]));
      const state = parsePayload(row);
      if (!row || !state) {
        send(res, 404, { error: 'snapshot nao encontrado' });
        return true;
      }
      send(res, 200, { ts: row.ts, state });
      return true;
    }

    if (path === '/api/markets') {
      // ?at=<iso> devolve as odds daquele instante (usado no replay).
      const at = q.get('at');
      const markets = marketsNow(db, at || null);
      send(res, 200, { ...markets, ts: at ?? new Date().toISOString(), at: at ?? null });
      return true;
    }

    if ((m = path.match(/^\/api\/replay\/([^/]+)$/))) {
      const row = snapshotAt(db, decodeURIComponent(m[1]));
      const state = parsePayload(row);
      if (!row || !state) {
        send(res, 404, { error: 'snapshot nao encontrado' });
        return true;
      }
      const prev = previousSnapshot(db, row.ts);
      send(res, 200, {
        ts: row.ts,
        state,
        changes: changesBetween(db, prev?.ts, row.ts),
        // Odds da epoca do snapshot (não as de agora).
        markets: marketsNow(db, row.ts),
        replay: { ts: row.ts, pct: row.pct, mode: 'replay', prevTs: prev?.ts ?? null, speed: 20 },
      });
      return true;
    }

    if (path.startsWith('/api')) {
      send(res, 404, { error: 'rota desconhecida' });
      return true;
    }
    return false;
  };
}

/** Executa `fn` antes dos listeners de request ja registrados no servidor. */
export function wrapServer(server, fn) {
  const previous = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let handled = false;
    try {
      handled = fn(req, res) === true;
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
      } else {
        send(res, 500, { error: err?.message ?? 'erro interno' });
      }
      return;
    }
    if (handled) return;
    for (const listener of previous) listener.call(server, req, res);
  });
}

/** Monta a API no servidor HTTP (usado por index.js). */
export function attach(server, deps = {}) {
  const db = deps.db ?? openDb(deps.dbPath ?? DB_PATH);
  const handler = createApi({ db, bus: deps.bus ?? bus });
  wrapServer(server, handler);
  server.once('close', () => {
    if (!deps.db) {
      try { db.close(); } catch { /* ja fechado */ }
    }
  });
  return { handler, db };
}

export default { createApi, attach, wrapServer };
