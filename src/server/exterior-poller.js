// Coletor do voto no exterior (escopo oficial "zz" do TSE).
//
// Fontes por ciclo (todas do mesmo host oficial, escopo zz):
//   zz/zz-c0001-e006258-u.json      -> agregado exterior (votos/secoes/eleitorado)
//   zz/zz-e006258-ab.json           -> progresso por posto consular (secoes)
//   zz/zz<codigo>-c0001-...-u.json  -> votos por posto (so postos com secao apurada)
//   br/br-e006258-ab.json           -> eleitorado nacional (base do comparativo)
//   br/br-c0001-e006258-u.json       -> votos nacionais (base do comparativo)
//
// O TSE nao publica votos por PAIS: publica por posto consular. A agregacao por
// pais e feita aqui com a tabela POSTS (codigo do posto -> ISO-3166 alpha-2).
//
// Contrato igual ao poller principal: start/stop, ETag/If-None-Match, backoff.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CANDIDATE_COLORS, DB_PATH, DEFAULT_COLOR, ELECTION, TSE_BASE } from '../shared/config.js';
import { insertSnapshot, openDb } from './db.js';
import { parsePct, parseVotes } from './normalize.js';
import bus from './bus.js';

const UA = 'eleicoes-2026/0.1 (+contato)';
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const HEARTBEAT_MS = 120_000;
export const EXTERIOR_INTERVAL_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Postos consulares do exterior: [codigo TSE, ISO-3166 alpha-2, nome do posto].
 * Fonte: config/mun-e006258-cm.json (lista oficial, 186 postos).
 */
export const POSTS = [
  ['29254', 'CI', 'Abidjã'], ['29262', 'AE', 'Abu Dhabi'], ['99198', 'NG', 'Abuja'],
  ['29270', 'GH', 'Accra'], ['99325', 'ET', 'Adis Abeba'], ['30457', 'NL', 'Amsterdã'],
  ['29289', 'JO', 'Amã'], ['29297', 'TR', 'Ancara'], ['29300', 'DZ', 'Argel'],
  ['29319', 'UY', 'Artigas'], ['29327', 'PY', 'Assunção'], ['39241', 'KZ', 'Astana'],
  ['29335', 'GR', 'Atenas'], ['39080', 'US', 'Atlanta'], ['99171', 'IQ', 'Bagdá'],
  ['39128', 'AZ', 'Baku'], ['99350', 'ML', 'Bamako'], ['29343', 'TH', 'Bangcoc'],
  ['29351', 'ES', 'Barcelona'], ['99473', 'BH', 'Barein'], ['29360', 'LB', 'Beirute'],
  ['29378', 'RS', 'Belgrado'], ['38881', 'BZ', 'Belmopan'], ['29386', 'DE', 'Berlim'],
  ['29394', 'GW', 'Bissau'], ['29408', 'CO', 'Bogotá'], ['29416', 'US', 'Boston'],
  ['39209', 'SK', 'Bratislava'], ['39187', 'CG', 'Brazzaville'], ['29424', 'BB', 'Bridgetown'],
  ['29432', 'BE', 'Bruxelas'], ['29440', 'RO', 'Bucareste'], ['29459', 'HU', 'Budapeste'],
  ['29467', 'AR', 'Buenos Aires'], ['29475', 'GF', 'Caiena'], ['29483', 'EG', 'Cairo'],
  ['29491', 'AU', 'Camberra'], ['30651', 'CN', 'Cantão'], ['29505', 'VE', 'Caracas'],
  ['99384', 'LC', 'Castries'], ['29513', 'US', 'Chicago'], ['29521', 'UY', 'Chuy'],
  ['29530', 'ZA', 'Cidade do Cabo'], ['29556', 'PY', 'Ciudad del Este'],
  ['29564', 'VE', 'Ciudad Guayana'], ['99210', 'BO', 'Cobija'], ['29572', 'BO', 'Cochabamba'],
  ['30929', 'LK', 'Colombo'], ['38903', 'GN', 'Conacri'], ['29580', 'PY', 'Concepción'],
  ['29599', 'DK', 'Copenhague'], ['38920', 'BJ', 'Cotonou'], ['29602', 'AR', 'Córdoba'],
  ['29610', 'SN', 'Dacar'], ['29629', 'BD', 'Dacca'], ['29637', 'SY', 'Damasco'],
  ['38962', 'TZ', 'Dar es Salaam'], ['29653', 'QA', 'Doha'], ['29661', 'IE', 'Dublin'],
  ['29645', 'TL', 'Díli'], ['99503', 'GB', 'Edimburgo'], ['29670', 'PY', 'Encarnación'],
  ['29688', 'SE', 'Estocolmo'], ['30961', 'PT', 'Faro'], ['29696', 'DE', 'Frankfurt'],
  ['30669', 'BW', 'Gaborone'], ['29700', 'CH', 'Genebra'], ['29718', 'GY', 'Georgetown'],
  ['98000', 'GT', 'Guatemala'], ['29742', 'JP', 'Hamamatsu'], ['29750', 'VN', 'Hanói'],
  ['29769', 'ZW', 'Harare'], ['30902', 'US', 'Hartford'], ['29777', 'CU', 'Havana'],
  ['29785', 'FI', 'Helsinque'], ['29793', 'HK', 'Hong Kong'], ['29807', 'US', 'Houston'],
  ['29815', 'CM', 'Iaundê'], ['38989', 'AM', 'Ierevan'], ['29823', 'PE', 'Iquitos'],
  ['29831', 'PK', 'Islamabade'], ['39306', 'TR', 'Istambul'], ['29840', 'ID', 'Jacarta'],
  ['29173', 'NP', 'Katmandu'], ['29858', 'UA', 'Kiev'], ['99430', 'JM', 'Kingston'],
  ['29874', 'CD', 'Kinshasa'], ['29882', 'KW', 'Kuaite'], ['29890', 'MY', 'Kuala Lumpur'],
  ['29904', 'BO', 'La Paz'], ['29912', 'NG', 'Lagos'], ['29939', 'GA', 'Libreville'],
  ['99341', 'MW', 'Lilongue'], ['29947', 'PE', 'Lima'], ['29955', 'PT', 'Lisboa'],
  ['39160', 'SI', 'Liubliana'], ['29963', 'TG', 'Lomé'], ['29971', 'GB', 'Londres'],
  ['29980', 'US', 'Los Angeles'], ['29998', 'AO', 'Luanda'], ['99287', 'ZM', 'Lusaca'],
  ['30066', 'ES', 'Madri'], ['39263', 'GQ', 'Malabo'], ['30082', 'PH', 'Manila'],
  ['30074', 'NI', 'Manágua'], ['30090', 'MZ', 'Maputo'], ['99511', 'FR', 'Marselha'],
  ['39102', 'OM', 'Mascate'], ['39004', 'AR', 'Mendoza'], ['30104', 'MX', 'México'],
  ['30112', 'US', 'Miami'], ['30120', 'IT', 'Milão'], ['30147', 'UY', 'Montevidéu'],
  ['30155', 'CA', 'Montreal'], ['30163', 'RU', 'Moscou'], ['30171', 'IN', 'Mumbai'],
  ['30180', 'DE', 'Munique'], ['30198', 'JP', 'Nagóia'], ['30201', 'KE', 'Nairóbi'],
  ['99180', 'BS', 'Nassau'], ['39322', 'CY', 'Nicósia'], ['30210', 'IN', 'Nova Delhi'],
  ['30228', 'US', 'Nova York'], ['99490', 'US', 'Orlando'], ['30244', 'NO', 'Oslo'],
  ['30252', 'CA', 'Ottawa'], ['30260', 'PA', 'Panamá'], ['30279', 'SR', 'Paramaribo'],
  ['30287', 'FR', 'Paris'], ['30295', 'AR', 'Paso Los Libres'],
  ['30309', 'PY', 'Pedro Juan Caballero'], ['30317', 'CN', 'Pequim'],
  ['30325', 'TT', 'Port of Spain'], ['30341', 'PT', 'Porto'], ['30333', 'HT', 'Porto Príncipe'],
  ['30350', 'CZ', 'Praga'], ['30368', 'CV', 'Praia'], ['30376', 'ZA', 'Pretória'],
  ['99155', 'AR', 'Puerto Iguazú'], ['99236', 'BO', 'Puerto Quijarro'], ['99295', 'KP', 'Pyongyang'],
  ['30392', 'EC', 'Quito'], ['30406', 'MA', 'Rabat'], ['30414', 'PS', 'Ramallah'],
  ['30422', 'SA', 'Riade'], ['30430', 'UY', 'Rio Branco'], ['99244', 'UY', 'Rivera'],
  ['30449', 'IT', 'Roma'], ['99147', 'AG', 'Saint Johns'], ['30465', 'PY', 'Salto del Guairá'],
  ['30473', 'BO', 'Santa Cruz de la Sierra'], ['99279', 'VE', 'Santa Elena de Uairén'],
  ['30481', 'CL', 'Santiago'], ['30988', 'BA', 'Sarajevo'], ['30538', 'KR', 'Seul'],
  ['29548', 'SG', 'Singapura'], ['99333', 'GF', 'St Georges de Loyapock'], ['30562', 'AU', 'Sydney'],
  ['30490', 'DO', 'São Domingos'], ['30503', 'US', 'São Francisco'], ['30511', 'CR', 'São José'],
  ['30520', 'SV', 'São Salvador'], ['39225', 'ST', 'São Tomé'], ['30546', 'BG', 'Sófia'],
  ['30570', 'TW', 'Taipe'], ['99317', 'EE', 'Talin'], ['99104', 'GE', 'Tbilisi'],
  ['30597', 'IR', 'Teerã'], ['30600', 'HN', 'Tegucigalpa'], ['30619', 'IL', 'Tel Aviv'],
  ['99139', 'AL', 'Tirana'], ['30635', 'CA', 'Toronto'], ['30686', 'LY', 'Trípoli'],
  ['30708', 'TN', 'Tunes'], ['30627', 'JP', 'Tóquio'], ['39284', 'BF', 'Uagadugu'],
  ['39063', 'CA', 'Vancouver'], ['30740', 'PL', 'Varsóvia'], ['30767', 'AT', 'Viena'],
  ['30783', 'US', 'Washington'], ['30805', 'NZ', 'Wellington'], ['30821', 'NA', 'Windhoek'],
  ['30848', 'CN', 'Xangai'], ['99376', 'MM', 'Yangon'], ['39020', 'HR', 'Zagreb'],
  ['30864', 'CH', 'Zurique'],
];

const POST_BY_CODE = new Map(POSTS.map(([code, iso2, name]) => [code, { code, iso2, name }]));

function zzUrl(suffix) {
  const { ele, cargo, ano } = ELECTION;
  return `${TSE_BASE}/ele${ano}/${ele}/dados/zz/${suffix}`;
}

function brAbUrl() {
  const { ele, ano } = ELECTION;
  return `${TSE_BASE}/ele${ano}/${ele}/dados/br/br-e00${ele}-ab.json`;
}

function brAggUrl() {
  const { ele, cargo, ano } = ELECTION;
  return `${TSE_BASE}/ele${ano}/${ele}/dados/br/br-${cargo}-e00${ele}-u.json`;
}

export const URLS = {
  aggregate: () => zzUrl(`zz-${ELECTION.cargo}-e00${ELECTION.ele}-u.json`),
  progress: () => zzUrl(`zz-e00${ELECTION.ele}-ab.json`),
  post: (code) => zzUrl(`zz${code}-${ELECTION.cargo}-e00${ELECTION.ele}-u.json`),
  nationalProgress: brAbUrl,
  nationalAggregate: brAggUrl,
};

// Estado do coletor (reiniciado por start()).
let db = null;
let ownsDb = false;
let timer = null;
let running = false;
let inFlight = false;
let stopped = false;
let lastPersistAt = 0;
let lastSnapshot = null;
let lastState = null;
let lastNational = null;
let lastElectorate = 0;
let lastNationalElectorate = 0;
const etags = new Map();
const postVotes = new Map(); // code -> { votes, valid, blank, nulls, abstention, ts }
const postProgress = new Map(); // code -> { countedSections, totalSections, pct }

function hashOf(state) {
  const { ts: _ts, ...content } = state;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** GET com ETag + backoff. Devolve {status, raw} ou null. */
async function get(url, tag) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = { 'user-agent': UA, accept: 'application/json' };
    const etag = etags.get(tag);
    if (etag) headers['if-none-match'] = etag;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      bus.emit('error', { scope: 'zz', code: 'fetch', message: err?.message ?? String(err) });
      if (attempt === 2) return null;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 304) return { status: 304 };
    if (res.status === 429 || res.status >= 500) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > 0
        ? Math.min(60_000, reset > 1e12 ? reset - Date.now() : reset * 1000)
        : 1000 * 2 ** attempt;
      bus.emit('error', { scope: 'zz', code: res.status, message: `TSE ${res.status}; retry em ${Math.round(wait)}ms` });
      if (attempt === 2) return null;
      await sleep(Math.max(500, wait));
      continue;
    }
    if (!res.ok) {
      bus.emit('error', { scope: 'zz', code: res.status, message: `TSE ${res.status} ${tag}` });
      return null;
    }
    const body = await res.text();
    const newEtag = res.headers.get('etag');
    if (newEtag) etags.set(tag, newEtag);
    try {
      return { status: 200, raw: JSON.parse(body) };
    } catch {
      bus.emit('error', { scope: 'zz', code: 'parse', message: 'JSON invalido' });
      return null;
    }
  }
  return null;
}

/** Achata candidatos do payload oficial em [{n,nm,nmu,party,votes,pct}]. */
function readCandidates(raw) {
  const out = [];
  for (const cargo of raw?.carg ?? []) {
    for (const agr of cargo?.agr ?? []) {
      for (const par of agr?.par ?? []) {
        for (const cand of par?.cand ?? []) {
          const n = String(cand?.n ?? '').trim();
          if (!n) continue;
          out.push({
            n,
            nm: String(cand?.nm ?? ''),
            nmu: String(cand?.nmu ?? cand?.nm ?? ''),
            party: String(par?.sg ?? agr?.com ?? ''),
            votes: parseVotes(cand?.vap),
            pct: parsePct(cand?.pvap),
          });
        }
      }
    }
  }
  return out;
}

function withColors(candidates) {
  return candidates
    .map((c) => ({ ...c, color: CANDIDATE_COLORS[c.n] ?? DEFAULT_COLOR }))
    .sort((a, b) => b.votes - a.votes || a.n.localeCompare(b.n));
}

function sectionsOf(s) {
  const counted = parseVotes(s?.sa);
  // ts = total de secoes; st/snt = totalizadas/nao totalizadas (fallback).
  const total = parseVotes(s?.ts) || parseVotes(s?.st) + parseVotes(s?.snt);
  const pct = parsePct(s?.psi) || (total > 0 ? Number(((counted / total) * 100).toFixed(2)) : 0);
  return { pct, counted: Math.min(counted, total || counted), total };
}

function votesOf(v, candidates) {
  const sum = candidates.reduce((acc, c) => acc + c.votes, 0);
  return {
    valid: parseVotes(v?.vv) || sum,
    blank: parseVotes(v?.vb),
    nulls: parseVotes(v?.vn),
    abstention: parseVotes(v?.van),
    total: parseVotes(v?.tv) || sum,
  };
}

function turnoutPct(votes) {
  const base = votes.valid + votes.blank + votes.nulls + votes.abstention;
  if (!base) return 0;
  return Number((((votes.valid + votes.blank + votes.nulls) / base) * 100).toFixed(2));
}

/** Ultimo snapshot de um escopo (payload JSON), sem depender da ordem global. */
function latestScoped(database, scope) {
  try {
    const row = database
      .prepare("SELECT ts, payload FROM snapshot WHERE json_extract(payload, '$.scope') = ? ORDER BY ts DESC LIMIT 1")
      .get(scope);
    if (row) return { ts: row.ts, payload: JSON.parse(row.payload) };
  } catch { /* json_extract indisponivel: cai no scan */ }
  try {
    const rows = database.prepare('SELECT ts, payload FROM snapshot ORDER BY ts DESC LIMIT 200').all();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        if (payload?.scope === scope) return { ts: row.ts, payload };
      } catch { /* ignora */ }
    }
  } catch { /* banco sem tabela */ }
  return null;
}

function nationalBaseline(database) {
  const found = latestScoped(database, 'br');
  const state = found?.payload;
  if (!state?.national) return null;
  const candidates = (state.candidates ?? []).map((c) => ({
    n: String(c.n),
    nm: c.nm ?? '',
    nmu: c.nmu ?? c.nm ?? '',
    party: c.party ?? '',
    votes: parseVotes(state.national.votes?.[c.n]),
    pct: parsePct(c.pct),
    color: CANDIDATE_COLORS[c.n] ?? DEFAULT_COLOR,
  }));
  return {
    ts: found.ts,
    pct: parsePct(state.national.pct),
    countedSections: parseVotes(state.national.countedSections),
    totalSections: parseVotes(state.national.totalSections),
    validVotes: parseVotes(state.national.totalVotes),
    blank: parseVotes(state.national.blank),
    nulls: parseVotes(state.national.nulls),
    abstention: parseVotes(state.national.abstention),
    electorate: lastNationalElectorate,
    candidates,
  };
}

/** Base nacional minima direto da API (usada quando ainda nao ha snapshot 'br'). */
function nationalFromApi(raw, electorate) {
  const candidates = withColors(readCandidates(raw));
  const votes = votesOf(raw?.v, candidates);
  return {
    ts: new Date().toISOString(),
    pct: sectionsOf(raw?.s).pct,
    countedSections: sectionsOf(raw?.s).counted,
    totalSections: sectionsOf(raw?.s).total,
    validVotes: votes.valid,
    blank: votes.blank,
    nulls: votes.nulls,
    abstention: votes.abstention,
    electorate,
    candidates,
  };
}

/** Votos de um posto consular. */
async function fetchPost(post) {
  const res = await get(URLS.post(post.code), `post:${post.code}`);
  if (!res) return null;
  if (res.status === 304) return postVotes.get(post.code) ?? null;
  const candidates = readCandidates(res.raw);
  const votes = votesOf(res.raw?.v, candidates);
  const entry = {
    code: post.code,
    iso2: post.iso2,
    votes: Object.fromEntries(candidates.map((c) => [c.n, c.votes])),
    ...votes,
    candidates,
    ts: new Date().toISOString(),
  };
  postVotes.set(post.code, entry);
  return entry;
}

function buildCountries(posts, candidates) {
  const byIso = new Map();
  for (const post of posts) {
    const key = post.iso2;
    let country = byIso.get(key);
    if (!country) {
      country = {
        iso2: key,
        pct: 0,
        countedSections: 0,
        totalSections: 0,
        electorate: 0,
        validVotes: 0,
        blank: 0,
        nulls: 0,
        abstention: 0,
        posts: 0,
        votes: {},
        leader: null,
        margin: 0,
      };
      byIso.set(key, country);
    }
    country.posts += 1;
    country.countedSections += post.countedSections;
    country.totalSections += post.totalSections;
    country.electorate += post.electorate;
    country.validVotes += post.valid;
    country.blank += post.blank;
    country.nulls += post.nulls;
    country.abstention += post.abstention;
    for (const [n, v] of Object.entries(post.votes)) {
      country.votes[n] = (country.votes[n] ?? 0) + v;
    }
  }

  const out = [];
  for (const country of byIso.values()) {
    country.pct = country.totalSections
      ? Number(((country.countedSections / country.totalSections) * 100).toFixed(2))
      : 0;
    const ranked = withColors(candidates.map((c) => ({
      n: c.n,
      votes: country.votes[c.n] ?? 0,
    })));
    const [first, second] = ranked;
    country.leader = first && first.votes > 0 ? first.n : null;
    country.margin = first && second ? first.votes - second.votes : 0;
    out.push(country);
  }
  return out.sort((a, b) => b.validVotes - a.validVotes || a.iso2.localeCompare(b.iso2));
}

function buildComparison(exterior, national) {
  if (!national) return null;
  const nationalValid = national.validVotes;
  const nationalElectorate = national.electorate || lastNationalElectorate;
  const exteriorTurnout = turnoutPct({
    valid: exterior.validVotes,
    blank: exterior.blank,
    nulls: exterior.nulls,
    abstention: exterior.abstention,
  });
  const nationalTurnout = turnoutPct({
    valid: nationalValid,
    blank: national.blank ?? 0,
    nulls: national.nulls ?? 0,
    abstention: national.abstention ?? 0,
  });
  return {
    validSharePct: nationalValid > 0
      ? Number(((exterior.validVotes / nationalValid) * 100).toFixed(4))
      : 0,
    electorateSharePct: nationalElectorate > 0 && exterior.electorate > 0
      ? Number(((exterior.electorate / nationalElectorate) * 100).toFixed(4))
      : 0,
    exteriorTurnoutPct: exteriorTurnout,
    nationalTurnoutPct: nationalTurnout,
    abstentionDeltaPct: nationalTurnout - exteriorTurnout,
    nationalValidVotes: nationalValid,
    nationalElectorate,
  };
}

/** Executa um ciclo de coleta do exterior. */
export async function pollOnce() {
  if (inFlight || stopped) return null;
  inFlight = true;
  const t0 = Date.now();
  try {
    const [aggregate, progress, nationalProgress, nationalAggregate] = await Promise.all([
      get(URLS.aggregate(), 'zz:aggregate'),
      get(URLS.progress(), 'zz:progress'),
      get(URLS.nationalProgress(), 'br:progress'),
      get(URLS.nationalAggregate(), 'br:aggregate'),
    ]);

    let candidates = lastState?.candidates ?? null;

    if (aggregate?.status === 200) {
      const parsed = readCandidates(aggregate.raw);
      if (parsed.length) candidates = withColors(parsed);
      lastState = {
        election: {
          ele: String(aggregate.raw?.ele ?? ELECTION.ele),
          cargo: Number(aggregate.raw?.carg?.[0]?.cd ?? 1) || 1,
          ano: ELECTION.ano,
          date: String(aggregate.raw?.dt ?? ''),
          time: String(aggregate.raw?.ht ?? ''),
          officialIdg: String(aggregate.raw?.idg ?? ''),
        },
        sections: sectionsOf(aggregate.raw?.s),
        electorate: parseVotes(aggregate.raw?.e?.te),
        rawVotes: aggregate.raw?.v ?? {},
      };
    }

    if (nationalProgress?.status === 200) {
      const br = (nationalProgress.raw?.abr ?? []).find((a) => String(a?.cdabr).toLowerCase() === 'br');
      lastNationalElectorate = parseVotes(br?.e?.te);
      const zz = (nationalProgress.raw?.abr ?? []).find((a) => String(a?.cdabr).toLowerCase() === 'zz');
      if (zz) lastElectorate = parseVotes(zz.e?.te);
    }

    // Progresso por posto: so interessa saber quais postos comecaram a apurar.
    if (progress?.status === 200) {
      postProgress.clear();
      for (const entry of progress.raw?.abr ?? []) {
        const code = String(entry?.cdabr ?? '');
        if (code === 'zz' || !POST_BY_CODE.has(code)) continue;
        const sections = sectionsOf(entry?.s);
        const electorate = parseVotes(entry?.e?.te);
        postProgress.set(code, { ...sections, electorate });
      }
    }

    const started = [...postProgress.entries()]
      .filter(([, p]) => p.counted > 0)
      .map(([code]) => POST_BY_CODE.get(code))
      .filter(Boolean);

    const queue = [...started];
    const fetched = [];
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const slice = queue.slice(i, i + CONCURRENCY);
      fetched.push(...(await Promise.all(slice.map((p) => fetchPost(p)))));
      if (stopped) break;
    }
    const fresh = new Map(fetched.filter(Boolean).map((p) => [p.code, p]));

    const posts = [];
    for (const [code, meta] of POST_BY_CODE) {
      const cached = fresh.get(code) ?? postVotes.get(code);
      const prog = postProgress.get(code) ?? { pct: 0, counted: 0, total: 0, electorate: cached?.electorate ?? 0 };
      if (!cached && prog.counted === 0) continue;
      posts.push({
        code,
        name: meta.name,
        iso2: meta.iso2,
        pct: prog.pct,
        countedSections: prog.counted,
        totalSections: prog.total,
        electorate: prog.electorate ?? cached?.electorate ?? 0,
        valid: cached?.valid ?? 0,
        blank: cached?.blank ?? 0,
        nulls: cached?.nulls ?? 0,
        abstention: cached?.abstention ?? 0,
        votes: cached?.votes ?? {},
      });
    }

    if (!lastState) {
      console.log('[exterior] sem agregado zz ainda; ciclo sem snapshot');
      return null;
    }

    const baseCandidates = candidates ?? [];
    const aggCandidates = baseCandidates.map((c) => ({ ...c }));

    const exteriorVotes = votesOf(lastState.rawVotes, aggCandidates);
    const exterior = {
      pct: lastState.sections.pct,
      countedSections: lastState.sections.counted,
      totalSections: lastState.sections.total,
      electorate: lastState.electorate || lastElectorate,
      validVotes: exteriorVotes.valid,
      blank: exteriorVotes.blank,
      nulls: exteriorVotes.nulls,
      abstention: exteriorVotes.abstention,
      totalVotes: exteriorVotes.total,
      turnoutPct: turnoutPct(exteriorVotes),
      candidates: aggCandidates.map((c) => ({
        n: c.n,
        nm: c.nm,
        nmu: c.nmu,
        party: c.party,
        color: c.color,
        votes: c.votes,
        pct: exteriorVotes.valid > 0
          ? Number(((c.votes / exteriorVotes.valid) * 100).toFixed(2))
          : 0,
      })),
    };

    const national = nationalBaseline(db)
      ?? (nationalAggregate?.status === 200
        ? nationalFromApi(nationalAggregate.raw, parseVotes(nationalAggregate.raw?.e?.te) || lastNationalElectorate)
        : lastNational);
    lastNational = national;

    const ts = new Date().toISOString();
    const state = {
      ts,
      scope: 'zz',
      election: lastState.election,
      exterior,
      national,
      comparison: buildComparison(exterior, national),
      countries: buildCountries(posts, aggCandidates),
      posts: posts.sort((a, b) => a.name.localeCompare(b.name)),
      limitations: {
        countryBreakdown: 'posts',
        note: 'TSE publica votos por posto consular; paises sao agregados localmente.',
      },
      totals: {
        pct: exterior.pct,
        countedSections: exterior.countedSections,
        totalSections: exterior.totalSections,
      },
    };

    const hash = hashOf(state);
    const now = Date.now();
    // Postos so podem avancar; 304 em todo mundo nao deve regravar em loop.
    const changed = !lastSnapshot || lastSnapshot.hash !== hash;
    const heartbeat = now - lastPersistAt >= HEARTBEAT_MS;
    let snapshotId = null;
    if (changed || heartbeat) {
      snapshotId = insertSnapshot(db, { ts, hash, pct: exterior.pct, payload: state });
      lastPersistAt = now;
      lastSnapshot = { id: snapshotId, hash };
      // Cache de candidatos para sobreviver a resposta 304 no proximo ciclo.
      lastState.candidates = aggCandidates;
    }

    const duration = Date.now() - t0;
    console.log(
      `[exterior] pct=${exterior.pct}% postos=${started.length} paises=${state.countries.length} snap=${snapshotId ?? '-'} ${duration}ms`,
    );
    if (snapshotId && !stopped) bus.emit('exterior', { state, snapshotId });
    return { state, snapshotId, started: started.length, duration };
  } catch (err) {
    bus.emit('error', { code: 'exterior-cycle', message: err?.message ?? String(err) });
    return null;
  } finally {
    inFlight = false;
  }
}

async function loop() {
  while (!stopped) {
    await pollOnce();
    if (stopped) break;
    await sleep(EXTERIOR_INTERVAL_MS);
  }
}

/** Abre o banco e inicia o ciclo continuo do exterior. */
export function start(options = {}) {
  if (running) return;
  stopped = false;
  running = true;
  const path = options.dbPath ?? DB_PATH;
  mkdirSync(dirname(path), { recursive: true });
  ownsDb = !options.db;
  db = options.db ?? openDb(path);
  const prev = latestScoped(db, 'zz');
  if (prev) {
    try {
      lastState = {
        election: prev.payload.election,
        sections: {
          pct: parsePct(prev.payload.exterior?.pct),
          counted: parseVotes(prev.payload.exterior?.countedSections),
          total: parseVotes(prev.payload.exterior?.totalSections),
        },
        electorate: parseVotes(prev.payload.exterior?.electorate),
        rawVotes: {
          vv: prev.payload.exterior?.validVotes,
          vb: prev.payload.exterior?.blank,
          vn: prev.payload.exterior?.nulls,
          van: prev.payload.exterior?.abstention,
          tv: prev.payload.exterior?.totalVotes,
        },
        candidates: prev.payload.exterior?.candidates ?? null,
      };
      lastPersistAt = Date.parse(prev.ts) || 0;
      lastSnapshot = { id: null, hash: hashOf(prev.payload) };
      for (const post of prev.payload.posts ?? []) {
        if (!post?.code) continue;
        postVotes.set(String(post.code), {
          code: String(post.code),
          iso2: post.iso2,
          votes: post.votes ?? {},
          valid: post.valid ?? 0,
          blank: post.blank ?? 0,
          nulls: post.nulls ?? 0,
          abstention: post.abstention ?? 0,
          electorate: post.electorate ?? 0,
          candidates: [],
        });
        postProgress.set(String(post.code), {
          pct: post.pct ?? 0,
          counted: post.countedSections ?? 0,
          total: post.totalSections ?? 0,
          electorate: post.electorate ?? 0,
        });
      }
    } catch { /* snapshot anterior invalido: ignora */ }
  }
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

/** Ultimo estado em memoria (util para teste). */
export function lastKnown() {
  return lastState;
}

export default { start, stop, pollOnce, POSTS };
