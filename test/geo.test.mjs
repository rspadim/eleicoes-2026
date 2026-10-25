// Valida o mapa coropletico gerado por scripts/build-geo.mjs.
// Roda offline: nao toca a rede, so le public/geo e o mapa de codigos IBGE.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IBGE_TO_UF, UF_TO_IBGE, ufFromIbge } from '../src/shared/uf-codes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARQ_PATHS = join(RAIZ, 'public/geo/br-ufs.json');
const ARQ_CENTROS = join(RAIZ, 'public/geo/uf-centroids.json');
const LIMITE_BYTES = 120 * 1024;

const mapa = JSON.parse(readFileSync(ARQ_PATHS, 'utf8'));
const centroides = JSON.parse(readFileSync(ARQ_CENTROS, 'utf8'));
const todas = Object.values(IBGE_TO_UF);

function lerViewBox() {
  const partes = String(mapa.viewBox ?? '').trim().split(/\s+/).map(Number);
  assert.equal(partes.length, 4, 'viewBox precisa ter 4 numeros');
  for (const n of partes) assert.ok(Number.isFinite(n), 'viewBox precisa ser numerico');
  const [x, y, w, h] = partes;
  assert.ok(w > 0 && h > 0, 'viewBox precisa ter largura e altura positivas');
  return { x, y, w, h };
}

test('mapa de codigos cobre as 27 UFs nos dois sentidos', () => {
  assert.equal(todas.length, 27);
  assert.equal(new Set(todas).size, 27);
  for (const uf of todas) assert.equal(ufFromIbge(UF_TO_IBGE[uf]), uf);
  assert.equal(ufFromIbge('011'), 'ro', 'aceita codigo com zero a esquerda');
  assert.equal(ufFromIbge(35), 'sp');
  assert.equal(ufFromIbge('99'), null);
});

test('arquivo respeita o orcamento de tamanho', () => {
  assert.ok(statSync(ARQ_PATHS).size < LIMITE_BYTES);
});

test('viewBox e valido', () => {
  const { x, y, w, h } = lerViewBox();
  assert.equal(x, 0);
  assert.equal(y, 0);
  assert.ok(w > 100 && h > 100, 'viewBox em escala util');
});

test('paths tem exatamente as 27 UFs, sem sobras', () => {
  const chaves = Object.keys(mapa.paths ?? {}).sort();
  assert.deepEqual(chaves, [...todas].sort());
});

test('todo path e um contorno fechado com comando suficiente', () => {
  for (const uf of todas) {
    const path = mapa.paths[uf];
    assert.equal(typeof path, 'string', `${uf}: path ausente`);
    assert.ok(path.startsWith('M'), `${uf}: path deve comecar com M`);
    assert.ok(path.endsWith('Z'), `${uf}: path deve fechar com Z`);
    assert.ok((path.match(/[ML]/g) ?? []).length > 3, `${uf}: path trivial demais`);
    assert.equal(/[^MLZ0-9.\s-]/.test(path), false, `${uf}: comando inesperado`);
  }
});

test('arquipelago remoto de PE (Fernando de Noronha) sobrevive ao corte de ilhas', () => {
  const subpaths = mapa.paths.pe.split('M').filter(Boolean);
  assert.ok(subpaths.length >= 2, 'pe deve manter o continente e Noronha');
  const menor = subpaths.sort((a, b) => a.length - b.length)[0];
  assert.ok(menor.split('L').length >= 3, 'Noronha precisa de contorno proprio');
});

test('centroides existem, sao finitos e caem dentro do viewBox', () => {
  const { x, y, w, h } = lerViewBox();
  const ufs = Object.keys(centroides).sort();
  assert.deepEqual(ufs, [...todas].sort());
  for (const uf of ufs) {
    const ponto = centroides[uf];
    assert.ok(Array.isArray(ponto) && ponto.length === 2, `${uf}: centroide invalido`);
    const [cx, cy] = ponto;
    assert.ok(Number.isFinite(cx) && Number.isFinite(cy), `${uf}: centroide nao numerico`);
    assert.ok(cx >= x && cx <= x + w, `${uf}: centroide fora no eixo x`);
    assert.ok(cy >= y && cy <= y + h, `${uf}: centroide fora no eixo y`);
  }
});

test('todos os vertices ficam dentro do viewBox', () => {
  const { x, y, w, h } = lerViewBox();
  for (const uf of todas) {
    for (const achado of mapa.paths[uf].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)) {
      const px = Number(achado[1]);
      const py = Number(achado[2]);
      assert.ok(px >= x && px <= x + w, `${uf}: x fora (${px})`);
      assert.ok(py >= y && py <= y + h, `${uf}: y fora (${py})`);
    }
  }
});
