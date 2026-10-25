// Testes da API HTTP e do contrato WebSocket (banco em memoria, servidor fake).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { openDb, insertSnapshot, insertChange, insertMarkets } from '../src/server/db.js';
import { createApi, wrapServer } from '../src/server/api.js';
import { createWs } from '../src/server/ws.js';
import { collectOnce, candidateNumberFor } from '../src/server/markets.js';
import realBus from '../src/server/bus.js';

/** ts ISO monotonico para snapshots sinteticos. */
const at = (min) => new Date(Date.UTC(2026, 9, 4, 12, min, 0)).toISOString();

function stateFor(min, pct) {
  return {
    ts: at(min),
    scope: 'br',
    national: { pct, votes: { 13: 100 + min, 22: 90 + min } },
    candidates: [
      { n: '13', nm: 'LUIZ INACIO LULA DA SILVA', nmu: 'LULA', party: 'PT', votes: 100 + min, pct: pct },
      { n: '22', nm: 'FLAVIO BOLSONARO', nmu: 'FLAVIO', party: 'PL', votes: 90 + min, pct: 100 - pct },
    ],
    ufs: { sp: { uf: 'sp', pct, countedSections: 10, totalSections: 100, leader: '13' } },
    totals: { pct, countedSections: 10, totalSections: 100 },
  };
}

/** Base com `count` snapshots (minutos 0..count-1) + um change no ultimo. */
function seed(count = 60) {
  for (let i = 0; i < count; i += 1) {
    insertSnapshot(db, { ts: at(i), hash: `h${i}`, pct: 40 + i / 10, payload: stateFor(i, 40 + i / 10) });
  }
  insertChange(db, { ts: at(count - 1), scope: 'br', candidate: '13', votes: 159, delta: 1 });
}

let db;
let bus;
let server;
let wsServer;
let base;

before(async () => {
  db = openDb(':memory:');
  bus = new EventEmitter();
  seed();
  const handler = createApi({ db, bus });
  server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nao casou');
    }
  });
  wsServer = createWs({ server, db, bus });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await wsServer.close();
  await new Promise((r) => server.close(r));
  db.close();
});

const get = (path) => fetch(`${base}${path}`);

describe('api http', () => {
  it('health responde 200 com no-store e cors', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await res.json()).ok, true);
  });

  it('state devolve o ultimo snapshot', async () => {
    const res = await get('/api/state');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.state.national.pct, 40 + 59 / 10);
  });

  it('timeline reduz a serie ao limite pedido', async () => {
    const res = await get('/api/timeline?limit=10');
    const { points } = await res.json();
    assert.equal(res.status, 200);
    assert.ok(points.length <= 10, `esperado <= 10, veio ${points.length}`);
    assert.ok(points.length > 3);
    assert.ok(points[0].ts < points.at(-1).ts, 'pontos em ordem crescente');
    assert.deepEqual(Object.keys(points[0]).sort(), ['pct', 'ts']);
  });

  it('replay/:ts devolve o estado do instante e os deltas', async () => {
    const res = await get(`/api/replay/${encodeURIComponent(at(59))}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ts, at(59));
    assert.equal(body.state.national.pct, 40 + 59 / 10);
    assert.equal(body.changes.length, 1);
    assert.equal(body.changes[0].delta, 1);
    assert.equal(body.replay.mode, 'replay');
    assert.equal(body.replay.prevTs, at(58));
  });

  it('snapshot/:ts busca o anterior e 404 sem historico', async () => {
    const ok = await get(`/api/snapshot/${encodeURIComponent(at(30))}`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ts, at(30));
    const miss = await get(`/api/snapshot/${encodeURIComponent(at(0).replace('12:00', '11:00'))}`);
    assert.equal(miss.status, 404);
  });

  it('ufs e candidates respondem 200', async () => {
    assert.equal((await get('/api/ufs')).status, 200);
    assert.equal((await get('/api/candidates')).status, 200);
    assert.equal((await get('/api/markets')).status, 200);
  });

  it('rota /api desconhecida responde 404 e rota nao-api passa adiante', async () => {
    assert.equal((await get('/api/inexistente')).status, 404);
    assert.equal((await get('/index.html')).status, 404);
  });

  it('candidates cruza markets pelo numero do candidato', async () => {
    insertMarkets(db, {
      ts: at(59), source: 'polymarket', entity: 'Lula', prob: 0.61, volume: 10,
      raw: { candidateNumber: '13', closed: false },
    });
    insertMarkets(db, {
      ts: at(59), source: 'kalshi', entity: 'Flavio', prob: 0.37, volume: 5,
      raw: { candidateNumber: '22' },
    });
    const { candidates } = await (await get('/api/candidates')).json();
    assert.equal(candidates.find((c) => c.number === '13').market.prob, 0.61);
    assert.equal(candidates.find((c) => c.number === '22').market.source, 'kalshi');
    const { polymarket } = await (await get('/api/markets')).json();
    assert.equal(polymarket[0].candidateNumber, '13');
    assert.equal(polymarket[0].closed, false);
  });

  it('history limita em 2000 e timeline em 3000', async () => {
    const h = await (await get('/api/history?limit=9999')).json();
    assert.equal(h.limit, 2000);
    const t = await (await get('/api/timeline?limit=9999')).json();
    assert.equal(t.limit, 3000);
  });

  it('respeita from/to no historico', async () => {
    const { items } = await (await get(`/api/history?from=${encodeURIComponent(at(5))}&to=${encodeURIComponent(at(9))}`)).json();
    assert.deepEqual(items.map((i) => i.ts), [at(5), at(6), at(7), at(8), at(9)]);
  });

  it('OPTIONS responde 204 e POST 405', async () => {
    const opt = await fetch(`${base}/api/health`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    const post = await fetch(`${base}/api/health`, { method: 'POST' });
    assert.equal(post.status, 405);
    const head = await fetch(`${base}/api/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});

describe('mount', () => {
  it('wrapServer preserva o handler anterior para rotas nao capturadas', async () => {
    const handler = createApi({ db, bus });
    const extra = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('fallback');
    });
    wrapServer(extra, handler);
    await new Promise((r) => extra.listen(0, '127.0.0.1', r));
    const port = extra.address().port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    const fallback = await fetch(`http://127.0.0.1:${port}/qualquer`);
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), 'fallback');
    await new Promise((r) => extra.close(r));
  });
});

describe('ws', () => {
  it('recebe hello e depois snapshot do bus', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));

    const hello = await until(msgs, 'hello');
    assert.equal(hello.type, 'hello');
    assert.equal(hello.mode, 'live');
    assert.deepEqual(Object.keys(hello).sort(), ['markets', 'mode', 'replay', 'serverTime', 'state', 'type']);

    const snap = stateFor(80, 77);
    bus.emit('snapshot', { state: snap, changes: [{ candidate: '13', delta: 2 }], snapshotId: 999 });
    const pushed = await until(msgs, 'snapshot');
    assert.equal(pushed.ts, snap.ts);
    assert.equal(pushed.changes.length, 1);
    ws.close();
  });

  it('ping responde pong e tipo desconhecido devolve error', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await until(msgs, 'hello');

    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await until(msgs, 'pong')).type, 'pong');
    ws.send(JSON.stringify({ type: 'nada' }));
    assert.match((await until(msgs, 'error')).message, /desconhecido/);
    ws.send('nao e json');
    assert.match((await until(msgs, 'error', 3_000, (m) => /json/.test(m.message))).message, /json invalido/);
    ws.close();
  });

  it('seek entra em replay e responde replayState', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await until(msgs, 'hello');

    ws.send(JSON.stringify({ type: 'speed', x: 200 }));
    await until(msgs, 'replayState');
    msgs.length = 0;
    ws.send(JSON.stringify({ type: 'seek', t: Date.parse(at(10)) }));
    const replay = await until(msgs, 'replayState');
    assert.equal(replay.replay.mode, 'replay');
    assert.equal(replay.replay.ts, at(10));
    assert.equal(replay.replay.speed, 200);

    const snap = await until(msgs, 'snapshot');
    assert.equal(snap.ts, at(10));
    assert.deepEqual(snap.changes, [], 'snapshot de replay sem change no intervalo');
    ws.close();
  });

  it('fim do historico marca finished e nao reenvia snapshot', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await until(msgs, 'hello');

    ws.send(JSON.stringify({ type: 'speed', x: 1000 }));
    ws.send(JSON.stringify({ type: 'seek', t: Date.parse(at(57)) }));
    const finished = await until(msgs, 'replayState', 5_000, (m) => m.replay.finished === true);
    assert.equal(finished.replay.finished, true);
    assert.equal(finished.replay.mode, 'replay');

    const tsSeen = msgs.filter((m) => m.type === 'snapshot').map((m) => m.ts);
    assert.deepEqual(tsSeen, [at(57), at(58), at(59)], 'sem repeticao de snapshot');
    const lastSnap = msgs.filter((m) => m.type === 'snapshot').at(-1);
    assert.equal(lastSnap.changes.length, 1, 'changes do ultimo snapshot vem do banco');
    assert.equal(lastSnap.changes[0].candidate, '13');
    await sleep(120);
    assert.equal(msgs.filter((m) => m.type === 'snapshot').length, 3);
    ws.close();
  });

  it('replay nao recebe snapshot ao vivo e live volta ao modo ao vivo', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await until(msgs, 'hello');

    ws.send(JSON.stringify({ type: 'seek', t: Date.parse(at(55)) }));
    await until(msgs, 'replayState');
    msgs.length = 0;
    bus.emit('snapshot', { state: stateFor(90, 90), changes: [], snapshotId: 1000 });
    await sleep(120);
    assert.equal(msgs.filter((m) => m.type === 'snapshot').length, 0, 'cliente em replay fica fora do broadcast');

    ws.send(JSON.stringify({ type: 'live' }));
    const live = await until(msgs, 'replayState');
    assert.equal(live.replay.mode, 'live');
    const resync = await until(msgs, 'snapshot');
    assert.equal(resync.ts, at(59), 'volta ao vivo com o estado atual');
    msgs.length = 0;

    bus.emit('snapshot', { state: stateFor(91, 91), changes: [], snapshotId: 1001 });
    const snap = await until(msgs, 'snapshot');
    assert.equal(snap.ts, at(91));
    ws.close();
  });

  it('seek sem snapshot anterior fica finished', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await until(msgs, 'hello');

    ws.send(JSON.stringify({ type: 'seek', t: Date.parse(at(0).replace('12:00', '11:00')) }));
    const state = await until(msgs, 'replayState');
    assert.equal(state.replay.finished, true);
    assert.equal(state.replay.ts, null);
    ws.close();
  });
});

describe('markets', () => {
  it('mapeia aliases para numero de candidato', () => {
    assert.equal(candidateNumberFor('Luiz Inácio Lula da Silva'), '13');
    assert.equal(candidateNumberFor('Flavio Bolsonaro'), '22');
    assert.equal(candidateNumberFor('Tarcísio de Freitas'), '10');
    assert.equal(candidateNumberFor('Nome Desconhecido'), null);
    assert.equal(candidateNumberFor(''), null);
  });

  it('coleta, normaliza e deduplica por hash', async () => {
    const realFetch = globalThis.fetch;
    const mdb = openDb(':memory:');
    const events = [];
    const onMarkets = (p) => events.push(p);
    realBus.on('markets', onMarkets);

    globalThis.fetch = async (url) => {
      if (String(url).includes('polymarket')) {
        return json({
          markets: [
            { groupItemTitle: 'Luiz Inácio Lula da Silva', outcomePrices: '["0.61","0.39"]', volume: 100, closed: false },
            { groupItemTitle: 'Flavio Bolsonaro', outcomePrices: '["0.38","0.62"]', volume: 50, closed: true },
          ],
        });
      }
      return json({
        markets: [
          { yes_sub_title: 'Flavio', yes_bid_dollars: '0.36', yes_ask_dollars: '0.40', volume_fp: 9, status: 'active' },
          { yes_sub_title: 'Lula', last_price: 60, status: 'active' },
          { yes_sub_title: 'Lula', yes_bid: 0, yes_ask: 100, last_price: 1, status: 'finalized' },
        ],
      });
    };

    try {
      const first = await collectOnce(mdb);
      assert.equal(first.polymarket.length, 2);
      assert.equal(first.polymarket[0].prob, 0.61);
      assert.equal(first.polymarket[0].candidateNumber, '13');
      assert.equal(first.polymarket[1].closed, true);
      assert.equal(first.polymarket[1].prob, 0.38, 'closed mantem a prob');
      assert.equal(first.kalshi[0].prob, 0.38, 'midpoint bid/ask em dolar');
      assert.equal(first.kalshi[1].prob, 0.6, 'fallback last_price em cents');
      assert.equal(first.kalshi[2].prob, 0.01, 'finalizado usa last_price, nao midpoint 0/1');
      assert.equal(first.kalshi[2].closed, true);
      assert.equal(events.length, 1);

      const before = mdb.prepare('SELECT COUNT(*) n FROM market').get().n;
      await collectOnce(mdb);
      assert.equal(events.length, 2, 'ciclo seguinte publica de novo');
      const after = mdb.prepare('SELECT COUNT(*) n FROM market').get().n;
      assert.equal(after, before, 'dedupe por hash nao regrava linhas iguais');

      const rows = mdb.prepare('SELECT source, COUNT(*) n FROM market GROUP BY source ORDER BY source').all();
      assert.deepEqual(rows.map((r) => r.n), [3, 2], 'dedupe nao duplica linhas');
    } finally {
      globalThis.fetch = realFetch;
      realBus.off('markets', onMarkets);
      mdb.close();
    }
  });

  it('erro de rede emite bus error e mantem ultima leitura', async () => {
    const realFetch = globalThis.fetch;
    const mdb = openDb(':memory:');
    const errors = [];
    const onError = (e) => errors.push(e);

    globalThis.fetch = async (url) => {
      if (String(url).includes('polymarket')) return json({ markets: [{ groupItemTitle: 'Lula', outcomePrices: '["0.5","0.5"]' }] });
      return { ok: false, status: 503 };
    };

    const onBusError = (e) => { if (e.code === 'markets') onError(e); };
    realBus.on('error', onBusError);
    try {
      await collectOnce(mdb);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].source, 'kalshi');

      // Agora ambos falham: publica o ultimo dado conhecido.
      globalThis.fetch = async () => { throw new Error('offline'); };
      const result = await collectOnce(mdb);
      assert.equal(result.polymarket.length, 1, 'ultima leitura preservada');
      assert.equal(errors.length, 3);
    } finally {
      globalThis.fetch = realFetch;
      realBus.off('error', onBusError);
      mdb.close();
    }
  });
});

function json(body) {
  return { ok: true, status: 200, json: async () => body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Aguarda a primeira mensagem do tipo informado (filtro opcional). */
function until(msgs, type, timeout = 3_000, filter = () => true) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = msgs.find((m) => m.type === type && filter(m));
      if (found) return resolve(found);
      if (Date.now() - started > timeout) return reject(new Error(`timeout aguardando ${type}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
