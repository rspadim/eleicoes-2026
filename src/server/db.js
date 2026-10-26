// Persistencia local (node:sqlite). Guarda apenas estado normalizado (JSON),
// nunca o payload bruto do TSE. Migrations idempotentes e WAL.
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS snapshot (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL UNIQUE,
     hash TEXT NOT NULL,
     pct REAL NOT NULL DEFAULT 0,
     payload TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS change (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     scope TEXT NOT NULL,
     candidate TEXT NOT NULL,
     votes INTEGER NOT NULL DEFAULT 0,
     delta INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS market (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     source TEXT NOT NULL,
     entity TEXT NOT NULL,
     prob REAL,
     volume REAL,
     raw TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_snapshot_ts ON snapshot(ts)',
  'CREATE INDEX IF NOT EXISTS idx_snapshot_hash ON snapshot(hash)',
  'CREATE INDEX IF NOT EXISTS idx_change_ts ON change(ts)',
  'CREATE INDEX IF NOT EXISTS idx_change_scope ON change(scope, ts)',
  'CREATE INDEX IF NOT EXISTS idx_market_source ON market(source, ts)',
];

/** Abre (criando se preciso) o banco e aplica migrations. */
export function openDb(path) {
  if (!path) throw new Error('openDb: path obrigatorio');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

export function insertSnapshot(db, { ts, hash, pct, payload }) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const info = db
    .prepare('INSERT INTO snapshot (ts, hash, pct, payload) VALUES (?, ?, ?, ?)')
    .run(ts, hash, Number(pct) || 0, json);
  return Number(info.lastInsertRowid);
}

const SELECT_SNAPSHOT = 'SELECT id, ts, hash, pct, payload FROM snapshot';

// Leitura padrão é do escopo nacional; o exterior grava 'zz' na mesma tabela e
// não pode "ganhar" a corrida por ts nas rotas principais.
const SCOPE_FILTER = `json_extract(payload, '$.scope') = ?`;

export function latestSnapshot(db, scope = 'br') {
  return db.prepare(`${SELECT_SNAPSHOT} WHERE ${SCOPE_FILTER} ORDER BY ts DESC LIMIT 1`).get(scope)
    ?? db.prepare(`${SELECT_SNAPSHOT} ORDER BY ts DESC LIMIT 1`).get()
    ?? null;
}

export function snapshotAt(db, ts, scope = 'br') {
  return db.prepare(`${SELECT_SNAPSHOT} WHERE ts <= ? AND ${SCOPE_FILTER} ORDER BY ts DESC LIMIT 1`).get(ts, scope) ?? null;
}

export function previousSnapshot(db, ts, scope = 'br') {
  return db.prepare(`${SELECT_SNAPSHOT} WHERE ts < ? AND ${SCOPE_FILTER} ORDER BY ts DESC LIMIT 1`).get(ts, scope) ?? null;
}

export function timeline(db, { from, to, limit = 500, scope = 'br' } = {}) {
  const where = [];
  const args = [];
  if (scope) { where.push(SCOPE_FILTER); args.push(scope); }
  if (from) { where.push('ts >= ?'); args.push(from); }
  if (to) { where.push('ts <= ?'); args.push(to); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  args.push(Math.max(1, Math.min(5000, Number(limit) || 500)));
  return db.prepare(`${SELECT_SNAPSHOT}${clause} ORDER BY ts DESC LIMIT ?`).all(...args);
}

export function insertChange(db, { ts, scope, candidate, votes, delta }) {
  const info = db
    .prepare('INSERT INTO change (ts, scope, candidate, votes, delta) VALUES (?, ?, ?, ?, ?)')
    .run(ts, scope, String(candidate), Number(votes) || 0, Number(delta) || 0);
  return Number(info.lastInsertRowid);
}

export function changesSince(db, ts) {
  return db
    .prepare('SELECT id, ts, scope, candidate, votes, delta FROM change WHERE ts > ? ORDER BY ts ASC, id ASC')
    .all(ts);
}

/** Apaga snapshots/changes/markets anteriores ao ts informado. */
export function pruneBefore(db, ts) {
  const snap = Number(db.prepare('DELETE FROM snapshot WHERE ts < ?').run(ts).changes);
  const chg = Number(db.prepare('DELETE FROM change WHERE ts < ?').run(ts).changes);
  const mkt = Number(db.prepare('DELETE FROM market WHERE ts < ?').run(ts).changes);
  return { snapshots: snap, changes: chg, markets: mkt };
}

export function insertMarkets(db, { ts, source, entity, prob, volume, raw }) {
  const info = db
    .prepare('INSERT INTO market (ts, source, entity, prob, volume, raw) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      ts,
      source,
      entity,
      prob == null ? null : Number(prob),
      volume == null ? null : Number(volume),
      raw == null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw),
    );
  return Number(info.lastInsertRowid);
}

export function latestMarkets(db, source) {
  const sql = `SELECT id, ts, source, entity, prob, volume, raw FROM market
     WHERE source = ? AND id IN (SELECT MAX(id) FROM market WHERE source = ? GROUP BY entity)
     ORDER BY entity`;
  return db.prepare(sql).all(source, source);
}

/**
 * Mercados como estavam no instante `ts` (ultima leitura de cada entidade ate
 * aquele momento). Usado para o replay mostrar as odds da epoca, nao as de hoje.
 */
export function marketsAt(db, source, ts) {
  if (!ts) return latestMarkets(db, source);
  const sql = `SELECT id, ts, source, entity, prob, volume, raw FROM market
     WHERE source = ? AND ts <= ?
       AND id IN (SELECT MAX(id) FROM market WHERE source = ? AND ts <= ? GROUP BY entity)
     ORDER BY entity`;
  return db.prepare(sql).all(source, ts, source, ts);
}

export default { openDb };
