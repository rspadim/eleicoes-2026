// Mapa entre codigo IBGE de UF e sigla. Fonte: IBGE (malhas v3, propriedade codarea).
// Siglas em minusculas para casar com as chaves usadas no mapa e no resto do app.

export const IBGE_TO_UF = Object.freeze({
  11: 'ro', 12: 'ac', 13: 'am', 14: 'rr', 15: 'pa', 16: 'ap', 17: 'to',
  21: 'ma', 22: 'pi', 23: 'ce', 24: 'rn', 25: 'pb', 26: 'pe', 27: 'al',
  28: 'se', 29: 'ba', 31: 'mg', 32: 'es', 33: 'rj', 35: 'sp', 41: 'pr',
  42: 'sc', 43: 'rs', 50: 'ms', 51: 'mt', 52: 'go', 53: 'df',
});

export const UF_TO_IBGE = Object.freeze(
  Object.fromEntries(Object.entries(IBGE_TO_UF).map(([ibge, uf]) => [uf, ibge])),
);

// Normaliza a entrada (numero, string com zeros a esquerda) antes de consultar.
export function ufFromIbge(codigo) {
  const chave = String(codigo ?? '').trim().replace(/^0+/, '');
  return IBGE_TO_UF[chave] ?? null;
}
