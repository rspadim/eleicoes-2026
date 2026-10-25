// Rodadas eleitorais conhecidas na API oficial do TSE.
// Turno 1: ele 6257 (05/10/2026) — 12 candidatos, encerrada.
// Turno 2: ele 6258 (25/10/2026) — Flávio Bolsonaro x Lula, apuração em curso.
// Backfill do 1º turno usa round '1t' (ver scripts/backfill.mjs).

export const ROUNDS = {
  '1t': {
    id: '1t',
    ele: '6257',
    label: '1º turno',
    date: '2026-10-05',
    finished: true,
    candidates: [
      { n: '22', nmu: 'FLAVIO BOLSONARO', party: 'PL', color: '#1f6feb' },
      { n: '13', nmu: 'LULA', party: 'PT', color: '#e0362c' },
      { n: '30', nmu: 'ESCRITOR AUGUSTO CURY', party: 'NOVO', color: '#8b5cf6' },
      { n: '15', nmu: 'RENAN SANTOS', party: 'MDB', color: '#14b8a6' },
      { n: '12', nmu: 'RONALDO CAIADO', party: 'PDT', color: '#f59e0b' },
      { n: '44', nmu: 'ZEMA', party: 'UNIÃO', color: '#38bdf8' },
      { n: '16', nmu: 'SAMARA', party: 'PSTU', color: '#f43f5e' },
      { n: '28', nmu: 'HERTZ DIAS', party: 'PRTB', color: '#a3e635' },
      { n: '90', nmu: 'CLARIANA BARAO', party: 'PROS', color: '#fb7185' },
      { n: '27', nmu: 'EDMILSON COSTA', party: 'DC', color: '#facc15' },
      { n: '20', nmu: 'VETERINÁRIO WILSON GRASSI', party: 'PCO', color: '#94a3b8' },
      { n: '21', nmu: 'RUI COSTA PIMENTA', party: 'PCB', color: '#9ca3af' },
    ],
  },
  '2t': {
    id: '2t',
    ele: '6258',
    label: '2º turno',
    date: '2026-10-25',
    finished: false,
    candidates: [
      { n: '22', nmu: 'FLAVIO BOLSONARO', party: 'PL', color: '#1f6feb' },
      { n: '13', nmu: 'LULA', party: 'PT', color: '#e0362c' },
    ],
  },
};

export const DEFAULT_ROUND = process.env.TSE_ROUND ?? '2t';

export function getRound(id = DEFAULT_ROUND) {
  return ROUNDS[id] ?? ROUNDS[DEFAULT_ROUND];
}

export function candidateMeta(round, n) {
  return round.candidates.find((c) => c.n === String(n)) ?? null;
}
