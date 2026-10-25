// Reconstroi o banco a partir dos JSON crus capturados em data/raw/.
// Uso: node scripts/backfill.mjs --round 1t [--dir data/raw] [--db data/apuracao.db]
// Idempotente: snapshots com o mesmo hash nao sao duplicados.
import { readdir, readFile } from 'node:fs/promises';
import { getRound } from '../src/shared/rounds.js';
import { openDb, insertSnapshot } from '../src/server/db.js';
import { normalize } from '../src/server/normalize.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const dir = arg('dir', 'data/raw');
const dbPath = arg('db', 'data/apuracao.db');
const roundArg = arg('round', null);
const round = roundArg ? getRound(roundArg) : null;

const db = openDb(dbPath);
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

let ok = 0;
let skipped = 0;
const skippedRound = new Map();

for (const file of files) {
  if (round && !file.includes(`-e00${round.ele}-`)) {
    skippedRound.set(file, true);
    continue;
  }
  const body = await readFile(`${dir}/${file}`, 'utf8');
  const ts = Date.parse(file.slice(0, 24).replace(/-/g, (m, i) => (i === 4 || i === 7 ? '-' : i === 10 ? 'T' : i === 13 || i === 16 ? ':' : '.'))) || 0;
  try {
    const raw = JSON.parse(body);
    const state = normalize(raw, raw.cdabr === 'zz' ? 'zz' : 'br', ts);
    const hash = state.hash;
    if (insertSnapshot(db, { ts, hash, pct: state.totals.pct, payload: JSON.stringify(state) })) ok += 1;
    else skipped += 1;
  } catch (err) {
    skipped += 1;
    console.warn(`skip ${file}: ${err.message}`);
  }
}

console.log(JSON.stringify({ files: files.length, inserted: ok, skipped, round: round?.id ?? 'todos', db: dbPath }));
