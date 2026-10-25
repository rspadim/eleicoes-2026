// Normalizacao pura do JSON oficial do TSE -> estado pronto para o front.
// Sem I/O: recebe o payload bruto e devolve { state, changes }.
// Regras defensivas: agregações "i"/"c" sempre achatadas, cores estaveis,
// percentuais com 2 casas e clampados em 0-100.
import { CANDIDATE_COLORS, DEFAULT_COLOR, ELECTION, UF_NAMES, UFS } from '../shared/config.js';

const UF_SET = new Set(UFS);
const MAX_CANDIDATES = 50;

/** Extrai inteiro de string com separador de milhar ("," ou "."). */
export function parseVotes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (typeof value !== 'string') return 0;
  const digits = value.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/** Extrai percentual numerico (virgula decimal), 2 casas, limitado a 0-100. */
export function parsePct(value) {
  let n = 0;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = Number(value.trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) n = 0;
  return Math.min(100, Math.max(0, Number(n.toFixed(2))));
}

/** Achata carg[].agr[].par[].cand[] (agr pode ser isolado "i" ou coligacao "c"). */
function flattenCandidates(raw) {
  const byNumber = new Map();
  for (const cargo of raw?.carg ?? []) {
    for (const agr of cargo?.agr ?? []) {
      for (const par of agr?.par ?? []) {
        for (const cand of par?.cand ?? []) {
          const n = String(cand?.n ?? '').trim();
          if (!n || byNumber.has(n)) continue;
          const vs = cand?.vs?.[0];
          byNumber.set(n, {
            n,
            nm: String(cand?.nm ?? ''),
            nmu: String(cand?.nmu ?? cand?.nm ?? ''),
            party: String(par?.sg ?? agr?.com ?? ''),
            color: CANDIDATE_COLORS[n] ?? DEFAULT_COLOR,
            votes: parseVotes(cand?.vap),
            pct: parsePct(cand?.pvap),
            vice: vs ? { nmu: String(vs.nmu ?? ''), party: String(vs.sgp ?? '') } : null,
          });
        }
      }
    }
  }
  return [...byNumber.values()].slice(0, MAX_CANDIDATES);
}

function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => b.votes - a.votes || a.n.localeCompare(b.n));
}

/** Votos por numero de candidato ({ "13": n, ... }). */
function votesByNumber(candidates) {
  const votes = {};
  for (const c of candidates) votes[c.n] = c.votes;
  return votes;
}

/**
 * Totais de secao.
 * `s.ts` = total de secoes do escopo; `s.sa` = apuradas; `s.st` = secoes
 * totalizaveis da carga corrente (subconjunto). O percentual honesto para a
 * tela e sa/ts; `s.psi` mede apenas dentro do subconjunto e inflaria o numero.
 */
function sectionsFrom(s) {
  const counted = parseVotes(s?.sa);
  const total = parseVotes(s?.ts) || parseVotes(s?.st) || parseVotes(s?.snt);
  const pct = total > 0 ? Number(Math.min(100, (counted / total) * 100).toFixed(2)) : 0;
  return { pct, counted: Math.min(counted, total || counted), total };
}

function aggregateOf(raw, candidates) {
  const s = sectionsFrom(raw?.s);
  const v = raw?.v ?? {};
  const e = raw?.e ?? {};
  const sumVotes = candidates.reduce((acc, c) => acc + c.votes, 0);
  const electorate = parseVotes(e.te);
  const turnout = parseVotes(e.c);
  const abstention = parseVotes(e.a);
  return {
    pct: s.pct,
    countedSections: s.counted,
    totalSections: s.total,
    votes: votesByNumber(candidates),
    totalVotes: parseVotes(v.vv) || sumVotes,
    blank: parseVotes(v.vb),
    nulls: parseVotes(v.vn),
    abstention,
    electorate,
    turnout,
    // % sobre o eleitorado apto do escopo (0 quando ainda não há dado)
    abstentionPct: electorate > 0 ? Number(((abstention / electorate) * 100).toFixed(2)) : 0,
    turnoutPct: electorate > 0 ? Number(((turnout / electorate) * 100).toFixed(2)) : 0,
  };
}

function ufState(uf, raw, candidates) {
  const agg = aggregateOf(raw, candidates);
  const ranked = rankCandidates(candidates);
  const [first, second] = ranked;
  const valid = agg.pct > 0;
  return {
    uf,
    name: UF_NAMES[uf] ?? uf.toUpperCase(),
    officialTs: officialTimestamp(raw?.dt, raw?.ht) ?? officialTimestamp(raw?.dg, raw?.hg),
    ...agg,
    candidates,
    leader: valid && first && first.votes > 0 ? first.n : null,
    margin: valid && first && second ? first.votes - second.votes : 0,
    ranking: ranked.map((c) => c.n),
  };
}

/** Deltas de votos por candidato contra o estado anterior, ignorando zero. */
function deriveChanges(scope, candidates, previousVotes) {
  const changes = [];
  for (const c of candidates) {
    const before = parseVotes(previousVotes?.[c.n]);
    const delta = c.votes - before;
    if (delta !== 0) changes.push({ scope, candidate: c.n, votes: c.votes, delta });
  }
  return changes;
}

/**
 * Data/hora oficial de geracao do arquivo do TSE (dt=dd/mm/aaaa, ht=hh:mm:ss,
 * horario de Brasilia) convertida para ISO. Retorna null se vier invalida.
 */
function officialTimestamp(dt, ht) {
  const d = String(dt ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const h = String(ht ?? '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!d || !h) return null;
  const iso = `${d[3]}-${d[2]}-${d[1]}T${h[1]}:${h[2]}:${h[3] ?? '00'}-03:00`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/**
 * Normaliza um payload do TSE.
 * @param {object} raw payload cru
 * @param {'br'|string} scope 'br' para nacional, sigla UF para estado
 * @param {object|null} prevState estado anterior (para calcular changes)
 * @param {string} [ts] timestamp ISO (injetavel em teste)
 */
export function normalize(raw, scope = 'br', prevState = null, ts = new Date().toISOString()) {
  if (!raw || !Array.isArray(raw.carg)) throw new TypeError('payload TSE invalido: carg ausente');
  const normalizedScope = scope === 'br' ? 'br' : String(scope).toLowerCase();
  if (normalizedScope !== 'br' && !UF_SET.has(normalizedScope)) {
    throw new TypeError(`escopo invalido: ${scope}`);
  }

  const candidates = flattenCandidates(raw);
  const agg = aggregateOf(raw, candidates);

  const state = {
    ts,
    scope: normalizedScope === 'br' ? 'br' : 'uf',
    election: {
      ele: String(raw.ele ?? ELECTION.ele),
      cargo: Number(raw?.carg?.[0]?.cd ?? 1) || 1,
      ano: ELECTION.ano,
      date: String(raw.dt ?? ''),
      time: String(raw.ht ?? ''),
      officialIdg: String(raw.idg ?? ''),
      // Instante em que o TSE gerou o arquivo (fonte da verdade da "idade" do dado).
      officialTs: officialTimestamp(raw.dt, raw.ht) ?? officialTimestamp(raw.dg, raw.hg),
    },
    national: agg,
    candidates,
    ufs: {},
    totals: {
      pct: agg.pct,
      countedSections: agg.countedSections,
      totalSections: agg.totalSections,
    },
  };

  let changes = [];
  if (normalizedScope === 'br') {
    changes = deriveChanges('br', candidates, prevState?.national?.votes);
  } else {
    state.ufs[normalizedScope] = ufState(normalizedScope, raw, candidates);
    changes = deriveChanges(normalizedScope, candidates, prevState?.ufs?.[normalizedScope]?.votes);
  }

  return { state, changes };
}

export default normalize;
