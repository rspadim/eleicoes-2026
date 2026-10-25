// Coletor do TSE: busca nacional + 27 UFs, normaliza, detecta mudanca e persiste.
// Nunca sobrepoe ciclos. ETag/If-None-Match + 304 = sem mudanca.
// Backoff exponencial em 429/5xx respeitando X-RateLimit-Reset.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH, POLL_INTERVAL_MS, UFS, tseUrl } from '../shared/config.js';
import { openDb, insertSnapshot, insertChange, previousSnapshot, pruneBefore } from './db.js';
import { normalize } from './normalize.js';
import bus from './bus.js';

const UA = 'eleicoes-2026/0.1 (+contato)';
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;
const HEARTBEAT_MS = 120_000;
const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hash do conteudo. Ignora o que e derivado do ciclo (ts de coleta, fetchedTs,
// lagMs, delta) para que o hash represente so mudanca real no dado oficial.
function hashOf(state) {
  const { ts: _ts, dataAge: _idade, ...content } = state;
  const json = JSON.stringify(content, (key, value) =>
    key === 'lagMs' || key === 'fetchedTs' || key === 'delta' ? undefined : value);
  return createHash('sha256').update(json).digest('hex');
}

// Estado do coletor (reiniciado por start()).
let db = null;
let ownsDb = false;
let timer = null;
let running = false;
let inFlight = false;
let stopped = false;
let lastState = null;
let lastPersistAt = 0;
let lastSnapshot = null;
const etags = new Map();

/** Aplica backoff quando o TSE limita/cai. Retorna null para nao insistir. */
async function withRetry(scope, cdabr) {
  const url = tseUrl(scope, cdabr);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = { 'user-agent': UA, accept: 'application/json' };
    const etag = etags.get(scope);
    if (etag) headers['if-none-match'] = etag;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      bus.emit('error', { scope, code: 'fetch', message: err?.message ?? String(err) });
      if (attempt === 2) return null;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 304) return { scope, cdabr, status: 304 };
    if (res.status === 429 || res.status >= 500) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > 0
        ? Math.min(60_000, reset > 1e12 ? reset - Date.now() : reset * 1000)
        : 1000 * 2 ** attempt;
      bus.emit('error', { scope, code: res.status, message: `TSE ${res.status}; retry em ${Math.round(wait)}ms` });
      if (attempt === 2) return null;
      await sleep(Math.max(500, wait));
      continue;
    }
    if (!res.ok) {
      bus.emit('error', { scope, code: res.status, message: `TSE ${res.status}` });
      return null;
    }
    const body = await res.text();
    const newEtag = res.headers.get('etag');
    if (newEtag) etags.set(scope, newEtag);
    try {
      return { scope, cdabr, status: 200, raw: JSON.parse(body) };
    } catch {
      bus.emit('error', { scope, code: 'parse', message: 'JSON invalido' });
      return null;
    }
  }
  return null;
}

async function fetchBatch(targets) {
  const out = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const slice = targets.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.all(slice.map(([s, c]) => withRetry(s, c)))));
    if (stopped) break;
  }
  return out.filter(Boolean);
}

function buildState(results, ts) {
  const base = lastState;
  const state = {
    ts,
    scope: 'br',
    election: base?.election ?? null,
    national: base?.national ? { ...base.national, votes: { ...(base.national.votes ?? {}) } } : null,
    candidates: base?.candidates ?? [],
    ufs: { ...(base?.ufs ?? {}) },
    totals: base?.totals ?? null,
  };
  const changes = [];

  for (const r of results) {
    if (r.status !== 200) continue;
    try {
      if (r.scope === 'br') {
        const norm = normalize(r.raw, 'br', base && { national: base.national, ufs: base.ufs }, ts);
        state.election = norm.state.election;
        state.national = norm.state.national;
        state.candidates = norm.state.candidates;
        changes.push(...norm.changes);
      } else {
        const norm = normalize(r.raw, r.scope, base, ts);
        const uf = norm.state.ufs[r.scope];
        if (uf) state.ufs[r.scope] = uf;
        changes.push(...norm.changes);
      }
    } catch (err) {
      bus.emit('error', { scope: r.scope, code: 'normalize', message: err?.message ?? String(err) });
    }
  }

  if (state.national) {
    state.totals = {
      pct: state.national.pct,
      countedSections: state.national.countedSections,
      totalSections: state.national.totalSections,
    };
  } else {
    // Sem nacional ainda: agrega as UFs para nao publicar estado vazio.
    const ufs = Object.values(state.ufs);
    const counted = ufs.reduce((a, u) => a + u.countedSections, 0);
    const total = ufs.reduce((a, u) => a + u.totalSections, 0);
    const pct = total ? Number(((counted / total) * 100).toFixed(2)) : 0;
    state.national = {
      pct, countedSections: counted, totalSections: total, votes: {},
      totalVotes: 0, blank: 0, nulls: 0, abstention: 0,
    };
    state.totals = { pct, countedSections: counted, totalSections: total };
  }

  const candidates = state.candidates ?? [];
  // Marca a idade do dado oficial: quando o TSE gerou o arquivo e quando o
  // nosso coletor o buscou. Sem isso o usuário não sabe se está vendo dado de
  // 30 s ou de 40 min atrás.
  if (state.election?.officialTs) {
    state.dataAge = {
      officialTs: state.election.officialTs,
      fetchedTs: ts,
      lagMs: Math.max(0, Date.parse(ts) - Date.parse(state.election.officialTs)),
    };
  }
  for (const uf of Object.keys(state.ufs)) {
    const u = state.ufs[uf];
    if (u.officialTs) u.lagMs = Math.max(0, Date.parse(ts) - Date.parse(u.officialTs));
  }
  for (const c of candidates) {
    if (!(c.n in (state.national.votes ?? {}))) {
      state.national.votes[c.n] = state.national.votes?.[c.n] ?? c.votes ?? 0;
    }
  }

  // Deltas por UF (para o layer "mudança" no mapa): variação do % do líder,
  // da margem e do avanço da apuração em relação à leitura anterior.
  for (const uf of Object.keys(state.ufs)) {
    const agora = state.ufs[uf];
    const antes = lastState?.ufs?.[uf];
    if (!antes) {
      agora.delta = { leaderPct: 0, margin: 0, countedPct: 0 };
      continue;
    }
    const pctDe = (dados) => {
      const lider = (dados?.candidates ?? []).find((c) => String(c.n) === String(dados?.leader));
      return Number(lider?.pct) || 0;
    };
    agora.delta = {
      leaderPct: Number((pctDe(agora) - pctDe(antes)).toFixed(2)),
      margin: Number(((Number(agora.margin) || 0) - (Number(antes.margin) || 0)) || 0),
      countedPct: Number(((Number(agora.pct) || 0) - (Number(antes.pct) || 0)).toFixed(2)),
    };
  }

  // Ordem estavel para o hash nao variar por ordem de chegada das UFs.
  for (const uf of Object.keys(state.ufs).sort()) {
    const u = state.ufs[uf];
    u.candidates = [...(u.candidates ?? [])].sort((a, b) => a.n.localeCompare(b.n));
    u.ranking = [...(u.candidates ?? [])].sort((a, b) => b.votes - a.votes).map((c) => c.n);
    u.votes = u.votes ?? {};
  }
  state.ufs = Object.fromEntries(Object.entries(state.ufs).sort(([a], [b]) => a.localeCompare(b)));

  return { state, changes };
}

function persist(state, changes, ts) {
  const hash = hashOf(state);
  const now = Date.now();
  const changed = !lastSnapshot || lastSnapshot.hash !== hash;
  const heartbeat = now - lastPersistAt >= HEARTBEAT_MS;
  if (!changed && !heartbeat) return null;

  const snapshotId = insertSnapshot(db, {
    ts,
    hash,
    pct: state.national?.pct ?? 0,
    payload: state,
  });
  for (const ch of changes) insertChange(db, { ts, ...ch });
  lastPersistAt = now;
  lastSnapshot = { id: snapshotId, hash };
  return snapshotId;
}

/** Executa um ciclo completo de coleta. */
export async function pollOnce() {
  if (inFlight || stopped) return null;
  inFlight = true;
  const t0 = Date.now();
  try {
    const targets = [['br', 'br'], ...UFS.map((u) => [u, u])];
    const results = await fetchBatch(targets);
    const updatedUfs = results.filter((r) => r.status === 200 && r.scope !== 'br').length;
    const ts = new Date().toISOString();
    const { state, changes } = buildState(results, ts);
    lastState = state;

    const snapshotId = persist(state, changes, ts);
    const duration = Date.now() - t0;
    const errs = results.filter((r) => r.status !== 200 && r.status !== 304).length;
    console.log(
      `[poller] pct=${state.national.pct}% ufs=${updatedUfs} snap=${snapshotId ?? '-'} err=${errs} ${duration}ms`,
    );

    if (snapshotId && !stopped) bus.emit('snapshot', { state, changes, snapshotId });
    return { state, changes, snapshotId, updatedUfs, duration };
  } catch (err) {
    bus.emit('error', { code: 'cycle', message: err?.message ?? String(err) });
    return null;
  } finally {
    inFlight = false;
  }
}

async function loop() {
  while (!stopped) {
    await pollOnce();
    if (stopped) break;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Abre o banco (se preciso) e inicia o ciclo continuo. */
export function start(options = {}) {
  if (running) return;
  stopped = false;
  running = true;
  const path = options.dbPath ?? DB_PATH;
  mkdirSync(dirname(path), { recursive: true });
  ownsDb = !options.db;
  db = options.db ?? openDb(path);

  // Estado anterior do banco serve de base para deltas entre reinicios.
  const prev = previousSnapshot(db, new Date().toISOString());
  if (prev) {
    try {
      lastState = JSON.parse(prev.payload);
      lastPersistAt = Date.parse(prev.ts) || 0;
      lastSnapshot = { id: prev.id, hash: prev.hash };
    } catch { /* payload antigo invalido: ignora */ }
  }

  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  pruneBefore(db, cutoff);

  loop();
  timer = setInterval(() => {}, 60_000);
}

/** Para o ciclo e fecha o banco. */
export async function stop() {
  stopped = true;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (let i = 0; i < 50 && inFlight; i += 1) await sleep(100);
  if (db && ownsDb) {
    try { db.close(); } catch { /* ja fechado */ }
  }
  db = null;
  ownsDb = false;
}

export default { start, stop, pollOnce };
