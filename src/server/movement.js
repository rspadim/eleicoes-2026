// Movimento da apuracao: maiores variacoes de % do lider por UF numa janela.
// Compara o snapshot mais recente com o snapshot de N ms atras (default 10 min).
// Tudo derivado do historico persistido — nenhum calculo no cliente.
import { latestSnapshot, snapshotAt, openDb } from './db.js';
import { DB_PATH } from '../shared/config.js';

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;

function parseSnapshot(row) {
  if (!row) return null;
  try {
    const state = JSON.parse(row.payload);
    return { ts: row.ts, state };
  } catch {
    return null;
  }
}

function leaderShare(candidates, leader) {
  const hit = (candidates ?? []).find((c) => String(c.n) === String(leader));
  return hit ? { n: String(hit.n), pct: Number(hit.pct) || 0, votes: Number(hit.votes) || 0 } : null;
}

/** Calcula a variacao por UF entre dois estados. */
export function computeMovement(current, base, windowMs) {
  if (!current) return { from: null, to: null, windowMs, rows: [], up: [], down: [], moved: 0 };
  const ufsNow = current.state?.ufs ?? {};
  const ufsBase = base?.state?.ufs ?? {};
  const rows = [];

  for (const [uf, now] of Object.entries(ufsNow)) {
    if (!now || !(Number(now.countedSections) > 0)) continue;
    const before = ufsBase[uf];
    // Sem leitura anterior com votos não existe "subiu/caiu" honesto: comparar
    // com zero produziria saltos artificiais de 70 p.p. no início da apuração.
    if (!before || !(Number(before.countedSections) > 0)) continue;
    const leader = now.leader;
    if (!leader) continue;
    const cur = leaderShare(now.candidates, leader);
    if (!cur) continue;
    const prev = leaderShare(before?.candidates, leader);
    const prevLeader = before?.leader ?? null;

    const deltaPct = Number((cur.pct - (prev?.pct ?? 0)).toFixed(2));
    const votesDelta = Math.max(0, cur.votes - (prev?.votes ?? 0));
    const pctDelta = Number((Number(now.pct) || 0) - (Number(before?.pct) || 0)).toFixed(2);

    rows.push({
      uf,
      name: now.name ?? uf.toUpperCase(),
      candidate: leader,
      candidateName: (now.candidates ?? []).find((c) => String(c.n) === String(leader))?.nmu ?? leader,
      color: (now.candidates ?? []).find((c) => String(c.n) === String(leader))?.color ?? null,
      pct: Number(cur.pct) || 0,
      deltaPct,
      votes: cur.votes,
      votesDelta,
      countedPct: Number(now.pct) || 0,
      countedDelta: Number(pctDelta) || 0,
      leaderChanged: Boolean(prevLeader && prevLeader !== leader),
      hadData: Boolean(before),
    });
  }

  const byAbs = [...rows].sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return {
    from: base?.ts ?? null,
    to: current.ts ?? null,
    windowMs,
    rows: byAbs,
    up: byAbs.filter((r) => r.deltaPct > 0).slice(0, 10),
    down: [...byAbs].filter((r) => r.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, 10),
    moved: rows.filter((r) => r.deltaPct !== 0).length,
  };
}

/** Router REST: GET /api/movement?window=600000 */
export function createMovement({ db } = {}) {
  if (!db) throw new TypeError('createMovement: db obrigatorio');

  return function movementHandler(req, res, next) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://local'); } catch { return next?.() ?? false; }
    if (url.pathname !== '/api/movement') return next?.() ?? false;

    try {
      const requested = Number(url.searchParams.get('window'));
      const windowMs = Number.isFinite(requested) && requested > 0
        ? Math.min(MAX_WINDOW_MS, Math.max(60_000, requested))
        : DEFAULT_WINDOW_MS;

      const latestRow = latestSnapshot(db);
      const latest = parseSnapshot(latestRow);
      if (!latest) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ from: null, to: null, windowMs, rows: [], up: [], down: [], moved: 0 }));
        return true;
      }

      const toMs = Date.parse(latest.ts);
      const fromIso = new Date(toMs - windowMs).toISOString();
      let baseRow = snapshotAt(db, fromIso);
      const maisAntigo = db
        .prepare("SELECT id, ts, hash, pct, payload FROM snapshot WHERE json_extract(payload, '$.scope') = 'br' ORDER BY ts ASC LIMIT 1")
        .get() ?? null;
      // Historico curto (apuracao comecou agora): usa a primeira leitura como base.
      if (!baseRow || baseRow.ts === latestRow.ts) baseRow = maisAntigo;
      const base = parseSnapshot(baseRow);
      const payload = computeMovement(latest, base, windowMs);

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(payload));
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
  const handler = createMovement({ db });
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

export default createMovement;
