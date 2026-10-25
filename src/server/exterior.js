// API do voto no exterior: ultimo estado + serie historica do escopo 'zz'.
// Contrato: createExterior({db, bus}) -> (req, res, next) => boolean (false = rota nao casou).
//
// As rotas ficam sob /api/exterior e leem apenas snapshots com payload.scope === 'zz',
// para nao misturar com o snapshot nacional/UF gravado pelo poller principal.
import { openDb } from './db.js';
import bus from './bus.js';

const MAX_HISTORY = 500;

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
  res.end(payload);
}

function parseRow(row) {
  if (!row) return null;
  try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

function isExterior(payload) {
  return payload?.scope === 'zz';
}

/** Ultima linha do escopo zz (json_extract quando disponivel, senao varredura). */
function latestExteriorRow(db) {
  try {
    const row = db
      .prepare("SELECT id, ts, hash, pct, payload FROM snapshot WHERE json_extract(payload, '$.scope') = 'zz' ORDER BY ts DESC LIMIT 1")
      .get();
    if (row) return row;
  } catch { /* json_extract indisponivel */ }
  try {
    const rows = db.prepare('SELECT id, ts, hash, pct, payload FROM snapshot ORDER BY ts DESC LIMIT 500').all();
    for (const row of rows) {
      if (isExterior(parseRow(row))) return row;
    }
  } catch { /* tabela ausente */ }
  return null;
}

/** Serie do escopo zz em ordem cronologica, no maximo limit. */
function exteriorSeries(db, limit) {
  try {
    const rows = db
      .prepare("SELECT ts, pct, payload FROM snapshot WHERE json_extract(payload, '$.scope') = 'zz' ORDER BY ts DESC LIMIT ?")
      .all(limit);
    if (rows.length) return rows.reverse();
  } catch { /* json_extract indisponivel */ }
  try {
    const rows = db.prepare('SELECT ts, pct, payload FROM snapshot ORDER BY ts DESC LIMIT ?').all(limit * 40);
    return rows
      .map((row) => ({ ...row, payload: parseRow(row) }))
      .filter((row) => isExterior(row.payload))
      .slice(0, limit)
      .reverse();
  } catch {
    return [];
  }
}

function point(row) {
  const payload = parseRow(row);
  const exterior = payload?.exterior ?? {};
  return {
    ts: row.ts,
    pct: exterior.pct ?? row.pct ?? 0,
    countedSections: exterior.countedSections ?? 0,
    totalSections: exterior.totalSections ?? 0,
    validVotes: exterior.validVotes ?? 0,
    electorate: exterior.electorate ?? 0,
  };
}

function intParam(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function emptyState() {
  return {
    scope: 'zz',
    exterior: {
      pct: 0,
      countedSections: 0,
      totalSections: 0,
      electorate: 0,
      validVotes: 0,
      blank: 0,
      nulls: 0,
      abstention: 0,
      totalVotes: 0,
      turnoutPct: 0,
      candidates: [],
    },
    national: null,
    comparison: null,
    countries: [],
    posts: [],
    limitations: {
      countryBreakdown: 'posts',
      note: 'TSE publica votos por posto consular; paises sao agregados localmente.',
    },
    totals: { pct: 0, countedSections: 0, totalSections: 0 },
    waiting: true,
  };
}

/**
 * Cria o handler da API do exterior.
 * @param {{db: object, bus?: object}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
export function createExterior({ db, bus: events = bus } = {}) {
  if (!db) throw new Error('createExterior: db obrigatorio');

  function handler(req, res) {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/api/exterior' && !path.startsWith('/api/exterior/')) return false;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { error: 'metodo nao permitido' }, { allow: 'GET, HEAD, OPTIONS' });
      return true;
    }

    if (path === '/api/exterior') {
      const limit = intParam(url.searchParams.get('limit'), 120, MAX_HISTORY);
      const row = latestExteriorRow(db);
      const state = parseRow(row);
      if (!state) {
        send(res, 200, { state: emptyState(), ts: null, series: [] });
        return true;
      }
      const rows = exteriorSeries(db, limit);
      send(res, 200, {
        state,
        ts: row?.ts ?? state.ts ?? null,
        series: rows.map(point),
      });
      return true;
    }

    if (path === '/api/exterior/history') {
      const limit = intParam(url.searchParams.get('limit'), 200, MAX_HISTORY);
      const rows = exteriorSeries(db, limit);
      send(res, 200, { items: rows.map(point), count: rows.length, limit });
      return true;
    }

    send(res, 404, { error: 'rota desconhecida' });
    return true;
  }

  handler.dispose = () => {};
  return handler;
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

/** Monta a rota no servidor HTTP. */
export function attach(server, deps = {}) {
  const owned = !deps.db;
  const db = deps.db ?? openDb(deps.dbPath);
  const handler = createExterior({ db, bus: deps.bus ?? bus });
  wrapServer(server, handler);
  server.once('close', () => {
    handler.dispose();
    if (!deps.db) {
      try { db.close(); } catch { /* ja fechado */ }
    }
  });
  return handler;
}

export default { createExterior, attach, wrapServer };
