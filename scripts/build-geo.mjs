#!/usr/bin/env node
// Gera o mapa coropletico offline das UFs a partir da malha do IBGE.
// Entrada: scripts/geo-sources/br-ufs-raw.json (FeatureCollection, properties.codarea).
//          Se o cache sumir, baixa a malha oficial uma vez (so no build).
// Fonte:   https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF
// Saida:   public/geo/br-ufs.json (paths SVG) e public/geo/uf-centroids.json (centroides).
// Sem rede em runtime: o app consome apenas os JSON gerados.
//
// Pipeline: descarta ilhas minusculas -> Douglas-Peucker -> Mercator -> SVG no viewBox.
// A tolerancia sobe em degraus ate o arquivo caber no orcamento de tamanho.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBGE_TO_UF } from '../src/shared/uf-codes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = join(RAIZ, 'scripts/geo-sources/br-ufs-raw.json');
const URL_FONTE = 'https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF';
const DIR_SAIDA = join(RAIZ, 'public/geo');
const ARQ_PATHS = join(DIR_SAIDA, 'br-ufs.json');
const ARQ_CENTROS = join(DIR_SAIDA, 'uf-centroids.json');

const ORCAMENTO_BYTES = 120 * 1024;
// Margem para nao raspar o teto; override ajuda a testar o escalonamento.
const META_BYTES = Number(process.env.GEO_META_BYTES ?? 110 * 1024);
const LARGURA_VIEWBOX = 1000;
const PAD = 4;

// Anel abaixo de 2% do maior anel da UF e descartado, salvo se for ilha remota
// (centroide a mais de 1 grau do bbox do anel principal), como Fernando de Noronha.
const FRACAO_MINIMA = 0.02;
const DISTANCIA_ILHA_GRAUS = 1;

// --- geometria -------------------------------------------------------------

// Distancia do ponto ao bbox; 0 quando esta dentro.
function distanciaBbox(ponto, bbox) {
  const [x, y] = ponto;
  const dx = Math.max(bbox[0] - x, 0, x - bbox[2]);
  const dy = Math.max(bbox[1] - y, 0, y - bbox[3]);
  return Math.hypot(dx, dy);
}

function bboxAnel(anel) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of anel) {
    if (x < bbox[0]) bbox[0] = x;
    if (y < bbox[1]) bbox[1] = y;
    if (x > bbox[2]) bbox[2] = x;
    if (y > bbox[3]) bbox[3] = y;
  }
  return bbox;
}

function areaAnel(anel) {
  let soma = 0;
  for (let i = 0, n = anel.length; i < n; i += 1) {
    const [x1, y1] = anel[i];
    const [x2, y2] = anel[(i + 1) % n];
    soma += x1 * y2 - x2 * y1;
  }
  return Math.abs(soma / 2);
}

function centroideAnel(anel) {
  let soma = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = anel.length; i < n; i += 1) {
    const [x1, y1] = anel[i];
    const [x2, y2] = anel[(i + 1) % n];
    const cruz = x1 * y2 - x2 * y1;
    soma += cruz;
    cx += (x1 + x2) * cruz;
    cy += (y1 + y2) * cruz;
  }
  if (soma === 0) {
    const media = anel.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    return [media[0] / anel.length, media[1] / anel.length];
  }
  return [cx / (3 * soma), cy / (3 * soma)];
}

// Douglas-Peucker iterativo: acha o ponto mais distante da corda e recursa acima da tolerancia.
function simplificar(pontos, tolerancia) {
  if (pontos.length <= 4) return pontos;

  const manter = new Uint8Array(pontos.length);
  manter[0] = 1;
  manter[pontos.length - 1] = 1;

  const pilha = [[0, pontos.length - 1]];
  while (pilha.length > 0) {
    const [ini, fim] = pilha.pop();
    if (fim - ini < 2) continue;

    const [ax, ay] = pontos[ini];
    const [bx, by] = pontos[fim];
    const dx = bx - ax;
    const dy = by - ay;
    const norma = Math.hypot(dx, dy) || 1e-12;

    let melhor = -1;
    let dist = 0;
    for (let i = ini + 1; i < fim; i += 1) {
      const [px, py] = pontos[i];
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / norma;
      if (d > dist) {
        dist = d;
        melhor = i;
      }
    }

    if (dist > tolerancia) {
      manter[melhor] = 1;
      pilha.push([ini, melhor], [melhor, fim]);
    }
  }

  return pontos.filter((_, i) => manter[i] === 1);
}

// Arredonda para 1 casa (inteiro quando possivel) para enxugar o SVG.
function num(v) {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// --- entrada ---------------------------------------------------------------

function aneisDoFeature(feature) {
  const { type, coordinates } = feature.geometry;
  if (type === 'Polygon') return coordinates;
  if (type === 'MultiPolygon') return coordinates.flat();
  throw new Error(`geometria nao suportada: ${type}`);
}

// Mantem o maior anel e ilhas remotas; descarta ilhas minusculas proximas.
function selecionarAneis(uf, brutos) {
  const ordenados = brutos
    .filter((anel) => anel.length >= 4)
    .map((anel) => ({ anel, area: areaAnel(anel) }))
    .sort((a, b) => b.area - a.area);

  const maior = ordenados[0];
  if (!maior) throw new Error(`UF ${uf} sem anel valido`);

  const bboxMaior = bboxAnel(maior.anel);
  const aneis = [{ anel: maior.anel, excecao: false }];

  for (const { anel, area } of ordenados.slice(1)) {
    if (area >= maior.area * FRACAO_MINIMA) {
      aneis.push({ anel, excecao: false });
      continue;
    }
    const distancia = distanciaBbox(centroideAnel(anel), bboxMaior);
    // Ilha remota entra como bloco: simplificacao menor para nao virar ponto.
    if (distancia >= DISTANCIA_ILHA_GRAUS) aneis.push({ anel, excecao: true });
  }

  return aneis;
}

// Anel aberto (sem o ponto de fechamento) rotacionado para o vertice mais
// distante do centroide, que serve de primeira ancora.
function anelAberto(anel) {
  const copia = anel.slice();
  const [ax, ay] = copia[0];
  const [bx, by] = copia[copia.length - 1];
  if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) copia.pop();
  if (copia.length < 4) return copia;

  const [cx, cy] = centroideAnel(copia);
  let ancora = 0;
  let dist = -1;
  for (let i = 0; i < copia.length; i += 1) {
    const d = (copia[i][0] - cx) ** 2 + (copia[i][1] - cy) ** 2;
    if (d > dist) {
      dist = d;
      ancora = i;
    }
  }
  return copia.slice(ancora).concat(copia.slice(0, ancora));
}

// Simplifica um anel fechado: parte do vertice mais extremo, acha o antipoda e
// aplica Douglas-Peucker nas duas metades, preservando o contorno.
function simplificarAnel(anel, tolerancia) {
  const aberto = anelAberto(anel);
  if (aberto.length < 8) return aberto;

  const [ax, ay] = aberto[0];
  let oposto = 1;
  let dist = -1;
  for (let i = 1; i < aberto.length; i += 1) {
    const d = (aberto[i][0] - ax) ** 2 + (aberto[i][1] - ay) ** 2;
    if (d > dist) {
      dist = d;
      oposto = i;
    }
  }

  const metadeA = aberto.slice(0, oposto + 1);
  const metadeB = aberto.slice(oposto).concat([aberto[0]]);
  const a = simplificar(metadeA, tolerancia);
  const b = simplificar(metadeB, tolerancia);
  return a.concat(b.slice(1, -1));
}

function montarCaminho(aneis, tolerancia, projetar) {
  const partes = [];
  for (const { anel, excecao } of aneis) {
    // Ilha excepcional ja e pequena: mantem o contorno original em vez de arriscar colapso.
    const pontos = excecao && anel.length <= 24
      ? anelAberto(anel)
      : simplificarAnel(anel, excecao ? tolerancia / 8 : tolerancia);
    if (pontos.length < 3) continue;
    const projetados = pontos.map(projetar);
    if (projetados.length < 3) continue;
    const [primeiro, ...resto] = projetados;
    partes.push(`M${num(primeiro[0])} ${num(primeiro[1])}${resto.map((p) => `L${num(p[0])} ${num(p[1])}`).join('')}Z`);
  }
  return partes;
}

// --- build -----------------------------------------------------------------

// Le o cache local; se faltar, baixa uma vez e grava para as proximas execucoes.
async function carregarFonte() {
  try {
    return JSON.parse(await readFile(FONTE, 'utf8'));
  } catch (erro) {
    if (erro.code !== 'ENOENT') throw erro;
    console.log('cache ausente, baixando malha do IBGE...');
    const resposta = await fetch(URL_FONTE);
    if (!resposta.ok) throw new Error(`IBGE respondeu ${resposta.status}`);
    const texto = await resposta.text();
    await mkdir(dirname(FONTE), { recursive: true });
    await writeFile(FONTE, texto);
    return JSON.parse(texto);
  }
}

async function main() {
  const bruto = await carregarFonte();
  const features = bruto.features ?? [];

  const ufs = new Map();
  for (const feature of features) {
    const uf = IBGE_TO_UF[String(feature.properties?.codarea ?? '').trim()];
    if (!uf) throw new Error(`codarea desconhecida: ${feature.properties?.codarea}`);
    const aneis = selecionarAneis(uf, aneisDoFeature(feature));
    ufs.set(uf, aneis);
  }
  if (ufs.size !== Object.keys(IBGE_TO_UF).length) {
    throw new Error(`esperadas ${Object.keys(IBGE_TO_UF).length} UFs, obtidas ${ufs.size}`);
  }

  // Bounding box geografico do conjunto que sera desenhado.
  let oeste = Infinity;
  let sul = Infinity;
  let leste = -Infinity;
  let norte = -Infinity;
  for (const aneis of ufs.values()) {
    for (const { anel } of aneis) {
      for (const [lon, lat] of anel) {
        if (lon < oeste) oeste = lon;
        if (lon > leste) leste = lon;
        if (lat < sul) sul = lat;
        if (lat > norte) norte = lat;
      }
    }
  }

  // Mercator esferico em graus equivalentes; y cresce em SVG, entao invertemos.
  const GRAUS = 180 / Math.PI;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) * GRAUS;
  const yNorte = mercY(norte);
  const ySul = mercY(sul);
  const larguraGeo = leste - oeste;

  const escala = (LARGURA_VIEWBOX - 2 * PAD) / larguraGeo;
  const alturaViewBox = Math.round((yNorte - ySul) * escala + 2 * PAD);
  const projetar = ([lon, lat]) => [
    PAD + (lon - oeste) * escala,
    PAD + (yNorte - mercY(lat)) * escala,
  ];

  const centroides = {};
  for (const [uf, aneis] of ufs) {
    const [lon, lat] = centroideAnel(aneis[0].anel);
    const [x, y] = projetar([lon, lat]);
    centroides[uf] = [Number(num(x)), Number(num(y))];
  }

  // Tolerancia crescente ate caber no orcamento.
  let saida = null;
  for (const tolerancia of [0.01, 0.015, 0.02, 0.03, 0.045, 0.06, 0.08, 0.1, 0.14, 0.2, 0.3]) {
    const paths = {};
    let pontos = 0;
    for (const [uf, aneis] of ufs) {
      const partes = montarCaminho(aneis, tolerancia, projetar);
      if (partes.length === 0) throw new Error(`UF ${uf} ficou vazia`);
      paths[uf] = partes.join('');
      pontos += (paths[uf].match(/[ML]/g) ?? []).length;
    }
    const json = JSON.stringify({
      viewBox: `0 0 ${LARGURA_VIEWBOX} ${alturaViewBox}`,
      paths,
    });
    const bytes = Buffer.byteLength(json, 'utf8');
    saida = { paths, json, bytes, pontos, tolerancia };
    if (bytes <= META_BYTES) break;
  }

  if (saida.bytes > ORCAMENTO_BYTES) {
    throw new Error(`arquivo com ${saida.bytes} bytes estoura o orcamento de ${ORCAMENTO_BYTES}`);
  }

  await mkdir(DIR_SAIDA, { recursive: true });
  await writeFile(ARQ_PATHS, saida.json);
  await writeFile(ARQ_CENTROS, `${JSON.stringify(centroides)}\n`);

  const kb = (saida.bytes / 1024).toFixed(1);
  const gz = (gzipSync(saida.json).length / 1024).toFixed(1);
  console.log(
    `br-ufs.json ${kb}KB (gzip ${gz}KB), ${saida.pontos} pontos, tolerancia ${saida.tolerancia} graus, ${ufs.size} UFs`,
  );
}

await main();
