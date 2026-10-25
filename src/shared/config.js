// Configuracao central da eleicao monitorada.
// Fonte oficial: TSE /oficial (mesmo endpoint consumido pelo app resultados.tse.jus.br).
// Para outra eleicao/cargo basta trocar os parametros abaixo.

export const TSE_BASE = process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial';

// ele2026 / 6258 = 2o turno (25/10/2026). 6257 = 1o turno (05/10/2026, encerrado).
// c0001 = Presidente. Escopo 'zz' = voto no exterior.
export const ELECTION = {
  ele: process.env.TSE_ELE ?? '6258',
  cargo: process.env.TSE_CARGO ?? 'c0001',
  ano: process.env.TSE_ANO ?? '2026',
};

export const EXTERIOR_SCOPE = 'zz';

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
export const PORT = Number(process.env.PORT ?? 8787);
export const DB_PATH = process.env.DB_PATH ?? 'data/apuracao.db';

export const UFS = [
  'ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms',
  'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc',
  'sp', 'se', 'to',
];

export const UF_NAMES = {
  ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia',
  ce: 'Ceará', df: 'Distrito Federal', es: 'Espírito Santo', go: 'Goiás',
  ma: 'Maranhão', mt: 'Mato Grosso', ms: 'Mato Grosso do Sul',
  mg: 'Minas Gerais', pa: 'Pará', pb: 'Paraíba', pr: 'Paraná',
  pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte',
  rs: 'Rio Grande do Sul', ro: 'Rondônia', rr: 'Roraima', sc: 'Santa Catarina',
  sp: 'São Paulo', se: 'Sergipe', to: 'Tocantins',
};

// Cores estaveis por candidato (usadas no mapa e nos graficos).
export const CANDIDATE_COLORS = {
  '22': '#1f6feb',
  '13': '#e0362c',
};

export const DEFAULT_COLOR = '#7d8590';

export function tseUrl(scope, cdabr, ele = ELECTION.ele) {
  const { cargo, ano } = ELECTION;
  return `${TSE_BASE}/ele${ano}/${ele}/dados/${scope}/${scope}-${cargo}-e00${ele}-u.json`;
}

export const MARKETS = {
  polymarketEventSlug: process.env.POLYMARKET_SLUG ?? 'brazil-presidential-election',
  kalshiSeries: process.env.KALSHI_SERIES ?? 'KXBRPRES',
  kalshiEvent: process.env.KALSHI_EVENT ?? 'KXBRPRES-26',
  intervalMs: Number(process.env.MARKET_INTERVAL_MS ?? 60_000),
};
