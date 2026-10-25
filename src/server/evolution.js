// Serie temporal da apuracao: % de secoes apuradas + % de cada candidato.
// Le os snapshots persistidos e devolve pontos leves (sem payload completo).
import { timeline, openDb } from './db.js';
import { DB_PATH } from '../shared/config.js';

const DEFAULT_POINTS = 240;

function parse(row) {
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync}} deps
 */
export function createEvolution({ db } = {}) {
  if (!db) throw new TypeError('createEvolution: db obrigatorio');

  return function evolutionHandler(req, res, next) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://local'); } catch { return next?.() ?? false; }
    if (url.pathname !== '/api/evolution') return next?.() ?? false;

    try {
      const rows = timeline(db, { limit: 5000 });
      const ordered = [...rows].reverse();
      const step = Math.max(1, Math.ceil(ordered.length / DEFAULT_POINTS));

      const points = [];
      for (let i = 0; i < ordered.length; i += step) {
        const row = ordered[i];
        const state = parse(row);
        if (!state) continue;
        const point = {
          ts: row.ts,
          counted: Number(state?.national?.pct) || 0,
          votes: Number(state?.national?.totalVotes) || 0,
          candidates: {},
        };
        for (const c of state.candidates ?? []) {
          point.candidates[String(c.n)] = {
            pct: Number(c.pct) || 0,
            votes: Number(c.votes) || 0,
            name: c.nmu ?? c.n,
            color: c.color ?? null,
          };
        }
        points.push(point);
      }
      // garante o ponto mais recente mesmo quando o passo o descarta
      const last = ordered.at(-1);
      if (last && points.at(-1)?.ts !== last.ts) {
        const state = parse(last);
        if (state) {
          const point = {
            ts: last.ts,
            counted: Number(state?.national?.pct) || 0,
            votes: Number(state?.national?.totalVotes) || 0,
            candidates: {},
          };
          for (const c of state.candidates ?? []) {
            point.candidates[String(c.n)] = {
              pct: Number(c.pct) || 0,
              votes: Number(c.votes) || 0,
              name: c.nmu ?? c.n,
              color: c.color ?? null,
            };
          }
          points.push(point);
        }
      }

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ points, total: ordered.length, step }));
      return true;
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message ?? 'erro interno' }));
      return true;
    }
  };
}

/**
 * Monta a rota no servidor HTTP (usado por index.js).
 * Usa o mesmo banco compartilhado — nada de abrir conexão extra.
 */
export function attach(server, deps = {}) {
  const db = deps.db ?? openDb(deps.dbPath ?? DB_PATH);
  const handler = createEvolution({ db });
  const anterior = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let tratado = false;
    try {
      tratado = handler(req, res, () => {}) === true;
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err?.message ?? 'erro interno' }));
      } else {
        try { res.end(); } catch { /* já encerrada */ }
      }
      tratado = true;
    }
    if (tratado) return;
    for (const listener of anterior) listener.call(server, req, res);
  });
  server.once('close', () => {
    if (!deps.db) { try { db.close(); } catch { /* já fechado */ } }
  });
  return handler;
}

export default createEvolution;
