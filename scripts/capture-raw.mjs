// Captura bruta continua da API oficial do TSE para data/raw/<eleicao>/.
// Objetivo: nunca perder dado durante a apuracao (a API fica online por poucas horas).
// Independente do servidor: rode com `node scripts/capture-raw.mjs`.
//
//   node scripts/capture-raw.mjs                     # rodada do .env (padrao 2t, ele 6258)
//   TSE_ELE=6257 CAPTURE_ONCE=1 node scripts/...mjs  # arquiva o 1o turno e sai
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tseUrl, UFS, EXTERIOR_SCOPE, ELECTION } from '../src/shared/config.js';

const EVERY = Number(process.env.CAPTURE_INTERVAL_MS ?? 20_000);
const ONCE = process.env.CAPTURE_ONCE === '1';
const ELE = process.env.TSE_ELE ?? ELECTION.ele;
const OUT = `data/raw/${ELE}`;
const UA = 'eleicoes-2026/0.1 (arquivo historico; contato rspadim)';

await mkdir(OUT, { recursive: true });

const seen = new Map();
let running = true;
const stop = () => { running = false; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function grab(scope, cdabr) {
  const url = tseUrl(scope, cdabr, ELE);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { scope, status: res.status };
    const body = await res.text();
    const hash = createHash('sha256').update(body).digest('hex');
    if (seen.get(scope) === hash) return { scope, status: 304 };
    seen.set(scope, hash);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(`${OUT}/${ts}-${scope}.json`, body);
    return { scope, status: 200, bytes: body.length };
  } catch (err) {
    return { scope, status: 'err', error: err.message };
  }
}

while (running) {
  const t0 = Date.now();
  const targets = [['br', 'br'], [EXTERIOR_SCOPE, EXTERIOR_SCOPE], ...UFS.map((u) => [u, u])];
  const results = [];
  for (let i = 0; i < targets.length; i += 6) {
    results.push(...(await Promise.all(targets.slice(i, i + 6).map(([s, c]) => grab(s, c)))));
  }
  const news = results.filter((r) => r.status === 200).length;
  const line = { ts: new Date().toISOString(), ele: ELE, ms: Date.now() - t0, novos: news, results };
  await appendFile(`${OUT}/capture.log`, `${JSON.stringify(line)}\n`);
  if (ONCE) break;
  if (!running) break;
  await new Promise((r) => setTimeout(r, EVERY));
}
