import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUNDS, getRound, candidateMeta } from '../src/shared/rounds.js';

test('rodadas 1t e 2t existem com candidatos e cores', () => {
  assert.equal(ROUNDS['1t'].ele, '6257');
  assert.equal(ROUNDS['2t'].ele, '6258');
  for (const r of Object.values(ROUNDS)) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.candidates.length >= 2);
    for (const c of r.candidates) assert.match(c.color, /^#[0-9a-f]{6}$/i);
  }
});

test('2o turno tem exatamente Flavio e Lula', () => {
  assert.deepEqual(getRound('2t').candidates.map((c) => c.n).sort(), ['13', '22']);
});

test('candidateMeta busca por numero como string', () => {
  assert.equal(candidateMeta(getRound('1t'), 22).nmu, 'FLAVIO BOLSONARO');
  assert.equal(candidateMeta(getRound('2t'), '99'), null);
});

test('rodada desconhecida cai no default', () => {
  assert.equal(getRound('xyz').id, getRound().id);
});
