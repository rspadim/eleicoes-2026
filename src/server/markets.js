// Coletor de mercados de previsao (Polymarket / Kalshi).
// Grava cada leitura com dedupe por hash e publica no bus; backoff exponencial em erro.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH, MARKETS } from '../shared/config.js';
import { openDb, insertMarkets, latestMarkets, marketsAt } from './db.js';
import bus from './bus.js';

const UA = 'eleicoes-2026/0.1 (+contato)';
const TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60_000;

// Aliases de mercado -> numero do candidato no TSE (ordem importa: mais especifico primeiro).
// Jair/Eduardo Bolsonaro ficam sem numero porque o candidato do TSE e o Flavio.
const ALIASES = [
  [/lula|luiz\s+in[aá]cio/i, '13'],
  [/fl[aá]vio\s+bolsonaro|fl[aá]vio/i, '22'],
  [/tarc[ií]sio/i, '10'],
  [/ciro/i, '12'],
  [/michelle/i, '30'],
  [/zema/i, '11'],
  [/rato/i, '15'],
];

let running = false;
let stopped = false;
let timer = null;
let failures = 0;
let db = null;
let ownedDb = false;
const lastHash = new Map();

let lastData = { polymarket: [], kalshi: [], ts: null };

/** Ultimas leituras por fonte ja no formato publico (sem `raw`). */
export function latestMarketRows(store, at = null) {
  const out = {};
  for (const source of ['polymarket', 'kalshi']) {
    try {
      const rows = at ? marketsAt(store, source, at) : latestMarkets(store, source);
      out[source] = rows.map(marketRow);
    } catch {
      out[source] = [];
    }
  }
  return out;
}

/** Normaliza um nome de mercado para o numero do candidato (ou null). */
export function candidateNumberFor(name) {
  const text = String(name ?? '').trim();
  if (!text) return null;
  for (const [re, n] of ALIASES) if (re.test(text)) return n;
  return null;
}

/** Converte linha do banco no formato publico (sai o `raw` cru). */
export function marketRow(row) {
  let raw = row?.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return {
    entity: row?.entity ?? '',
    prob: row?.prob ?? null,
    volume: row?.volume ?? null,
    closed: Boolean(raw?.closed),
    candidateNumber: raw?.candidateNumber ?? candidateNumberFor(row?.entity),
  };
}

function hashOf(list) {
  return createHash('sha256')
    .update(JSON.stringify(list.map((m) => [m.entity, m.prob, m.volume, m.closed])))
    .digest('hex');
}

function num(value) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Grava somente quando o conjunto mudou. */
function persist(store, source, ts, list) {
  const hash = hashOf(list);
  if (lastHash.get(source) === hash) return 0;
  lastHash.set(source, hash);
  let saved = 0;
  for (const m of list) {
    try {
      insertMarkets(store, { ts, source, entity: m.entity, prob: m.prob, volume: m.volume, raw: m.raw });
      saved += 1;
    } catch (err) {
      bus.emit('error', { code: 'markets', source, message: err?.message ?? String(err) });
    }
  }
  return saved;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

/** Polymarket: Yes do primeiro outcome de cada submercado do evento. */
export async function collectPolymarket() {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(MARKETS.polymarketEventSlug)}`;
  const data = await getJson(url);
  const events = Array.isArray(data) ? data : [data].filter(Boolean);
  const out = [];
  for (const event of events) {
    for (const market of event?.markets ?? []) {
      const entity = String(market?.groupItemTitle ?? '').trim();
      if (!entity) continue;
      let prices = market?.outcomePrices;
      if (typeof prices === 'string') {
        try { prices = JSON.parse(prices); } catch { prices = null; }
      }
      const prob = Array.isArray(prices) ? num(prices[0]) : null;
      const candidateNumber = candidateNumberFor(entity);
      out.push({
        entity,
        prob,
        volume: num(market?.volume ?? event?.volume) ?? 0,
        closed: Boolean(market?.closed),
        candidateNumber,
        raw: {
          id: market?.id ?? null,
          slug: market?.slug ?? null,
          closed: Boolean(market?.closed),
          candidateNumber,
          outcomePrices: prices ?? null,
        },
      });
    }
  }
  return out;
}

/** Kalshi: midpoint bid/ask (em dolar ou cents); fallback do ultimo preco. */
export async function collectKalshi() {
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(MARKETS.kalshiSeries)}&limit=200`;
  const data = await getJson(url);
  const out = [];
  for (const market of data?.markets ?? []) {
    const entity = String(market?.yes_sub_title ?? market?.title ?? '').trim();
    if (!entity) continue;

    // A API expoe centavos (inteiros) e, nas respostas novas, dolares (0-1).
    const bidDollar = num(market?.yes_bid_dollars);
    const askDollar = num(market?.yes_ask_dollars);
    const lastDollar = num(market?.last_price_dollars);
    const bid = bidDollar ?? (num(market?.yes_bid) != null ? num(market?.yes_bid) / 100 : null);
    const ask = askDollar ?? (num(market?.yes_ask) != null ? num(market?.yes_ask) / 100 : null);
    const last = lastDollar ?? (num(market?.last_price) != null ? num(market?.last_price) / 100 : null);
    // Midpoint so faz sentido com book vivo; em mercado finalizado (0/1) usa o ultimo preco.
    let prob = null;
    if (bid != null && ask != null) {
      prob = ask - bid < 0.5 ? (bid + ask) / 2 : last ?? (bid + ask) / 2;
    } else {
      prob = last;
    }

    const candidateNumber = candidateNumberFor(entity);
    out.push({
      entity,
      prob,
      volume: num(market?.volume_fp ?? market?.volume) ?? 0,
      closed: Boolean(market?.status && market.status !== 'active'),
      candidateNumber,
      raw: {
        ticker: market?.ticker ?? null,
        status: market?.status ?? null,
        yesBid: bid,
        yesAsk: ask,
        lastPrice: last,
        candidateNumber,
      },
    });
  }
  return out;
}

async function cycle(store = db) {
  const ts = new Date().toISOString();
  const result = { polymarket: [], kalshi: [], ts };
  let ok = 0;
  active += 1;

  try {
    for (const [source, collect] of [['polymarket', collectPolymarket], ['kalshi', collectKalshi]]) {
      try {
        const list = await collect();
        if (store) persist(store, source, ts, list);
        result[source] = list.map(({ raw: _raw, ...m }) => ({ ...m, candidateNumber: m.candidateNumber ?? null }));
        if (list.length) ok += 1;
      } catch (err) {
        bus.emit('error', { code: 'markets', source, message: err?.message ?? String(err) });
        // Mantem ultima leitura conhecida no payload publicado.
        result[source] = (lastData[source] ?? []).map((m) => ({ ...m }));
      }
    }

    lastData = result;
    if (result.polymarket.length || result.kalshi.length) bus.emit('markets', result);
    failures = ok === 2 ? 0 : failures + 1;
    return result;
  } finally {
    active -= 1;
  }
}

async function loop() {
  while (!stopped) {
    await cycle().catch(() => {});
    if (stopped) break;
    const wait = Math.min(MAX_BACKOFF_MS, MARKETS.intervalMs * 2 ** Math.min(failures, 5));
    await new Promise((r) => {
      const t = setTimeout(r, wait);
      t.unref?.();
    });
  }
}

/** Inicia a coleta continua. Sem `db` abre DB_PATH (e fecha no stop). */
export function start(options = {}) {
  if (running) return;
  running = true;
  stopped = false;
  ownedDb = !options.db;
  if (ownedDb) {
    const path = options.dbPath ?? DB_PATH;
    mkdirSync(dirname(path), { recursive: true });
    db = openDb(path);
  } else {
    db = options.db;
  }
  loop();
  timer = setInterval(() => {}, 60_000);
}

/** Para a coleta (fecha o banco somente se foi aberto aqui). */
export async function stop() {
  stopped = true;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (let i = 0; i < 100 && active > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ownedDb && db) {
    try { db.close(); } catch { /* ja fechado */ }
  }
  db = null;
  ownedDb = false;
  lastData = { polymarket: [], kalshi: [], ts: null };
  lastHash.clear();
  failures = 0;
}

let active = 0;

/** Monta o coletor no boot do servidor (usado por index.js; reusa o db do app). */
export function attach(_server, deps = {}) {
  start({ db: deps.db, dbPath: deps.dbPath });
  return { stop };
}

export { cycle as collectOnce };

export default { start, stop, attach, collectOnce: cycle, candidateNumberFor };
