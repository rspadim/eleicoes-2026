// Testes da normalizacao pura (sem rede/I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseVotes, parsePct } from '../src/server/normalize.js';
import { DEFAULT_COLOR } from '../src/shared/config.js';

const BASE_TS = '2026-10-25T20:00:00.000Z';

/** Fixture com coligacao (agr "c") e isolado (agr "i"). */
function brFixture({ v22 = '1000', v13 = '3000', sa = '50', st = '100' } = {}) {
  return {
    ele: '6258',
    t: '2',
    f: 'o',
    tpabr: 'br',
    cdabr: 'br',
    dt: '25/10/2026',
    ht: '17:06:27',
    idg: 'abc',
    carg: [
      {
        cd: '1',
        nmn: 'Presidente',
        nv: '1',
        agr: [
          {
            n: '280001801177',
            nm: 'PARTIDO LIBERAL',
            tp: 'i',
            par: [
              {
                n: '22',
                sg: 'PL',
                cand: [
                  { n: '22', nm: 'FLAVIO NANTES BOLSONARO', nmu: 'FLAVIO BOLSONARO', vap: v22, pvap: '25,00',
                    vs: [{ nmu: 'ALFREDO GASPAR', sgp: 'PL' }] },
                ],
              },
            ],
          },
          {
            n: '280001800617',
            nm: 'BRASIL PRONTO PRA MAIS',
            tp: 'c',
            par: [
              {
                n: '13',
                sg: 'PT',
                cand: [
                  { n: '13', nm: 'LUIZ INACIO LULA DA SILVA', nmu: 'LULA', vap: v13, pvap: '75,00',
                    vs: [{ nmu: 'GERALDO ALCKMIN', sgp: 'PSB' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
    s: { st, sa, psi: '50,00', snt: st },
    e: { est: '100', esa: '50', c: '10', a: '5' },
    v: { vv: '4000', vb: '100', vn: '20', van: '30' },
  };
}

test('parseVotes aceita milhar com virgula e ponto', () => {
  assert.equal(parseVotes('142.169'), 142169);
  assert.equal(parseVotes('5153'), 5153);
  assert.equal(parseVotes(''), 0);
  assert.equal(parseVotes(undefined), 0);
});

test('parsePct normaliza virgula, clamp 0-100 e 2 casas', () => {
  assert.equal(parsePct('42,344'), 42.34);
  assert.equal(parsePct('150,9'), 100);
  assert.equal(parsePct('-3'), 0);
  assert.equal(parsePct('99,836734694'), 99.84);
});

test('normaliza nacional achatando coligacao e isolado', () => {
  const { state, changes } = normalize(brFixture(), 'br', null, BASE_TS);
  assert.equal(state.scope, 'br');
  assert.equal(state.election.cargo, 1);
  assert.equal(state.election.officialIdg, 'abc');
  assert.equal(state.candidates.length, 2);
  const lula = state.candidates.find((c) => c.n === '13');
  assert.equal(lula.votes, 3000);
  assert.equal(lula.party, 'PT');
  assert.equal(lula.vice.nmu, 'GERALDO ALCKMIN');
  assert.equal(state.candidates.find((c) => c.n === '22').color, '#1f6feb');
  assert.equal(state.national.votes['13'], 3000);
  assert.equal(state.national.pct, 50);
  assert.equal(state.national.countedSections, 50);
  assert.equal(state.national.totalSections, 100);
  assert.equal(state.totals.pct, 50);
  assert.deepEqual(changes.map((c) => c.candidate).sort(), ['13', '22']);
});

test('cor fallback para candidato desconhecido', () => {
  const raw = brFixture();
  raw.carg[0].agr[0].par[0].cand[0].n = '99';
  const { state } = normalize(raw, 'br', null, BASE_TS);
  assert.equal(state.candidates.find((c) => c.n === '99').color, DEFAULT_COLOR);
});

test('derive changes ignora delta zero', () => {
  const first = normalize(brFixture(), 'br', null, BASE_TS).state;
  const same = normalize(brFixture(), 'br', first, '2026-10-25T20:01:00.000Z').changes;
  assert.equal(same.length, 0);
  const grown = normalize(brFixture({ v13: '3500' }), 'br', first, '2026-10-25T20:02:00.000Z').changes;
  assert.deepEqual(grown, [{ scope: 'br', candidate: '13', votes: 3500, delta: 500 }]);
});

test('UF zerada: leader null, margem 0 e ranking presente', () => {
  const raw = brFixture({ v22: '0', v13: '0', sa: '0', st: '0' });
  raw.s.psi = '0,00';
  const { state } = normalize(raw, 'rs', null, BASE_TS);
  const rs = state.ufs.rs;
  assert.equal(state.scope, 'uf');
  assert.equal(rs.pct, 0);
  assert.equal(rs.leader, null);
  assert.equal(rs.margin, 0);
  assert.deepEqual(rs.ranking.sort(), ['13', '22']);
  assert.equal(rs.name, 'Rio Grande do Sul');
});

test('UF apurada define leader e margem', () => {
  const { state } = normalize(brFixture({ v22: '2000', v13: '1000' }), 'ba', null, BASE_TS);
  assert.equal(state.ufs.ba.leader, '22');
  assert.equal(state.ufs.ba.margin, 1000);
});

test('empate total de votos nao quebra ranking', () => {
  const { state } = normalize(brFixture({ v22: '500', v13: '500' }), 'br', null, BASE_TS);
  assert.equal(state.candidates.reduce((a, c) => a + c.votes, 0), 1000);
  assert.deepEqual(state.ufs, {});
});

test('payload invalido e escopo invalido lancam erro', () => {
  assert.throws(() => normalize({}, 'br'), /carg/);
  assert.throws(() => normalize(brFixture(), 'xx'), /escopo/);
});

test('pct usa secoes apuradas sobre o total do escopo', () => {
  // s.psi mede só o subconjunto totalizável; o total honesto é s.ts.
  const raw = brFixture({ sa: '25' });
  raw.s.ts = '100';
  raw.s.psi = '100,00';
  const { state } = normalize(raw, 'br', null, BASE_TS);
  assert.equal(state.national.pct, 25);
  assert.equal(state.national.totalSections, 100);
});

test('sem s.ts cai para s.st e recalcula o pct', () => {
  const raw = brFixture({ sa: '25', st: '50' });
  raw.s.psi = '10,00';
  const { state } = normalize(raw, 'br', null, BASE_TS);
  assert.equal(state.national.totalSections, 50);
  assert.equal(state.national.pct, 50);
});

test('coligacao preserva sigla do partido e vice', () => {
  const { state } = normalize(brFixture(), 'br', null, BASE_TS);
  const lula = state.candidates.find((c) => c.n === '13');
  assert.equal(lula.party, 'PT');
  assert.deepEqual(lula.vice, { nmu: 'GERALDO ALCKMIN', party: 'PSB' });
});

test('abstencao e comparecimento usam o eleitorado do escopo', () => {
  const raw = brFixture();
  raw.e = { te: '1000', c: '700', a: '200' };
  const { state } = normalize(raw, 'br', null, BASE_TS);
  assert.equal(state.national.abstention, 200);
  assert.equal(state.national.abstentionPct, 20);
  assert.equal(state.national.turnoutPct, 70);
});

test('officialTs converte dt/ht de Brasília para ISO', () => {
  const { state } = normalize(brFixture(), 'br', null, BASE_TS);
  assert.equal(state.election.officialTs, '2026-10-25T20:06:27.000Z');
});

