// Reconstroi o banco de snapshots a partir dos JSON crus capturados em data/raw/.
//
// Uso:
//   node scripts/backfill.mjs                        # todos os arquivos de data/raw
//   node scripts/backfill.mjs --round 2t             # so a eleicao do 2o turno (6258)
//   node scripts/backfill.mjs --dir data/raw --db data/apuracao.db
//
// O capture-raw grava um arquivo por escopo e por ciclo:
//   <ISO>-br.json, <ISO>-sp.json, ... <ISO>-zz.json
// Aqui agrupamos por ciclo (o timestamp do nome) e montamos o mesmo estado que o
// poller publica: nacional + 27 UFs. Idempotente por (hash, ts).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getRound } from '../src/shared/rounds.js';
import { UFS } from '../src/shared/config.js';
import { openDb, insertSnapshot } from '../src/server/db.js';
import { normalize } from '../src/server/normalize.js';

const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 ? padrao : args[i + 1];
};

const dir = arg('dir', 'data/raw');
const dbPath = arg('db', 'data/apuracao.db');
const roundArg = arg('round', null);
const round = roundArg ? getRound(roundArg) : null;
const eleFiltro = round ? round.ele : null;

const db = openDb(dbPath);
const arquivos = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

// nome -> { ts, escopo, arquivo }
const capturas = [];
for (const arquivo of arquivos) {
  const m = arquivo.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(br|[a-z]{2})\.json$/);
  if (!m) continue;
  const [, dia, hh, mm, ss, ms, escopo] = m;
  if (escopo !== 'br' && escopo !== 'zz' && !UFS.includes(escopo)) continue;
  const ts = `${dia}T${hh}:${mm}:${ss}.${ms}Z`;
  capturas.push({ ts, escopo, arquivo });
}

// Agrupa por ciclo: cada arquivo tem o proprio timestamp de escrita; usa a
// janela de 5 s para juntar os que vieram da mesma rodada de captura.
const ciclos = new Map();
for (const c of capturas) {
  const chave = Math.floor(Date.parse(c.ts) / 5000);
  if (!ciclos.has(chave)) ciclos.set(chave, []);
  ciclos.get(chave).push(c);
}

function hashEstado(state) {
  const { ts: _ts, ...conteudo } = state;
  return createHash('sha256').update(JSON.stringify(conteudo)).digest('hex');
}

let inseridos = 0;
let repetidos = 0;
let ignorados = 0;
const porEscopo = { br: 0, uf: 0, zz: 0 };

for (const chave of [...ciclos.keys()].sort((a, b) => a - b)) {
  const grupo = ciclos.get(chave);
  const ler = async (nome) => {
    const item = grupo.find((c) => c.escopo === nome);
    if (!item) return null;
    try {
      return JSON.parse(await readFile(`${dir}/${item.arquivo}`, 'utf8'));
    } catch {
      return null;
    }
  };

  const brutoBr = await ler('br');
  if (!brutoBr) { ignorados += grupo.length; continue; }
  if (eleFiltro && String(brutoBr.ele) !== eleFiltro) { ignorados += grupo.length; continue; }

  const ts = grupo.find((c) => c.escopo === 'br')?.ts ?? new Date(chave * 5000).toISOString();
  let estado;
  try {
    const { state } = normalize(brutoBr, 'br', null, ts);
    estado = state;
    porEscopo.br += 1;
  } catch (err) {
    ignorados += grupo.length;
    console.warn(`skip ciclo ${ts}: ${err.message}`);
    continue;
  }

  for (const uf of UFS) {
    const brutoUf = await ler(uf);
    if (!brutoUf) continue;
    try {
      const { state } = normalize(brutoUf, uf, null, ts);
      if (state.ufs?.[uf]) {
        estado.ufs[uf] = state.ufs[uf];
        porEscopo.uf += 1;
      }
    } catch { /* UF inválida no ciclo: ignora */ }
  }

  // Exterior (zz) fica em escopo próprio, como faz o coletor dedicado.
  const brutoZz = await ler('zz');
  if (brutoZz) {
    try {
      const { state } = normalize(brutoZz, 'br', null, ts);
      const exterior = { ...state, scope: 'zz', national: undefined };
      const hashZz = hashEstado(exterior);
      const existeZz = db.prepare('SELECT 1 FROM snapshot WHERE ts = ? AND hash = ? LIMIT 1').get(ts, hashZz);
      if (!existeZz) {
        insertSnapshot(db, {
          ts,
          hash: hashZz,
          pct: Number(state.national?.pct) || 0,
          payload: JSON.stringify(exterior),
        });
        porEscopo.zz += 1;
      }
    } catch { /* exterior opcional */ }
  }

  const hash = hashEstado(estado);
  const jaExiste = db.prepare('SELECT 1 FROM snapshot WHERE ts = ? OR hash = ? LIMIT 1').get(ts, hash);
  if (jaExiste) { repetidos += 1; continue; }

  insertSnapshot(db, {
    ts,
    hash,
    pct: Number(estado.totals?.pct ?? estado.national?.pct ?? 0),
    payload: JSON.stringify(estado),
  });
  inseridos += 1;
}

// O normalize() só aceita 'br' ou UF; o exterior é montado a partir do bruto zz.

console.log(JSON.stringify({
  arquivos: arquivos.length,
  ciclos: ciclos.size,
  inseridos,
  repetidos,
  ignorados,
  escopos: porEscopo,
  rodada: round?.id ?? 'todas',
  db: dbPath,
}));
