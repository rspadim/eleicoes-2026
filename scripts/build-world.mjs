// Gera public/geo/world.json: mapa-mundial simplificado em SVG para as bolhas
// do voto exterior.
//
// Fonte: Natural Earth 50m (dominio publico), via geojson do repositorio
// nvkelso/natural-earth-vector. 50m e necessario porque o 110m omite paises com
// posto consular (Bahrein, Barbados, Hong Kong, Cabo Verde, Singapura, etc.).
// Baixa, simplifica com Douglas-Peucker, projeta em Mercator, corta latitudes
// abaixo de -60 e grava paths por ISO-3166 alpha-2 + centroide.
//
// Uso: node scripts/build-world.mjs [--local <arquivo.geojson>]
//
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SRC_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const OUT = 'public/geo/world.json';

const WIDTH = 1000; // unidades do viewBox (Mercator, 360 graus)
const LAT_CUT = -60; // Antartida fora
const TOLERANCE = 0.55; // graus, Douglas-Peucker
const MIN_AREA = 0.02; // graus^2, descarta ilhas minusculas
const PRECISION = 1; // casas decimais no path

const args = process.argv.slice(2);
const localIdx = args.indexOf('--local');
const localPath = localIdx >= 0 ? args[localIdx + 1] : null;

// Anexos desenhados dentro da metrica de outro pais: separa aneis por bbox.
const DETACHED = {
  FR: [{ iso: 'GF', bbox: [-55.5, 1.5, -50.5, 6.5] }], // Guiana Francesa
};

function mercatorY(lat) {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

// Viewbox: longitude [-180,180] -> [0,WIDTH]; latitude [85,-60] em Mercator.
const Y_TOP = mercatorY(85);
const Y_BOTTOM = mercatorY(LAT_CUT);
const HEIGHT = Number((((Y_TOP - Y_BOTTOM) * WIDTH) / (2 * Math.PI)).toFixed(1));

function project(lon, lat) {
  const x = ((lon + 180) / 360) * WIDTH;
  const y = ((Y_TOP - mercatorY(lat)) / (Y_TOP - Y_BOTTOM)) * HEIGHT;
  return [x, y];
}

// Distancia ponto->segmento (coordenadas projetadas, sem sqrt final).
function sqSegDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyDp(points, tolerance) {
  if (points.length <= 3) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = 0;
    for (let i = first + 1; i < last; i += 1) {
      const dist = sqSegDist(points[i], points[first], points[last]);
      if (dist > maxDist) { maxDist = dist; index = i; }
    }
    if (maxDist > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area / 2);
}

function fmt(n) {
  return Number(n.toFixed(PRECISION)).toString();
}

function ringToPath(ring) {
  const pts = ring.map(([lon, lat]) => project(lon, Math.max(LAT_CUT, lat)));
  const simplified = simplifyDp(pts, TOLERANCE);
  if (!simplified.length) return '';
  const parts = [`M${fmt(simplified[0][0])} ${fmt(simplified[0][1])}`];
  for (let i = 1; i < simplified.length; i += 1) {
    parts.push(`L${fmt(simplified[i][0])} ${fmt(simplified[i][1])}`);
  }
  parts.push('Z');
  return parts.join('');
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function centroidOf(polygons) {
  let best = null;
  let bestArea = 0;
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer) continue;
    const area = ringArea(outer);
    if (area > bestArea) { bestArea = area; best = outer; }
  }
  if (!best) return null;
  // Centroide de area do anel externo dominante, com clamp na latitude corte.
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i, i += 1) {
    const cross = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    a2 += cross;
    cx += (best[j][0] + best[i][0]) * cross;
    cy += (best[j][1] + best[i][1]) * cross;
  }
  if (a2 === 0) return project(best[0][0], Math.max(LAT_CUT, best[0][1]));
  cx /= 3 * a2;
  cy /= 3 * a2;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    return project(best[0][0], Math.max(LAT_CUT, best[0][1]));
  }
  const [x, y] = project(cx, Math.max(LAT_CUT, cy));
  return [Number(x.toFixed(1)), Number(y.toFixed(1))];
}

async function load() {
  if (localPath) return JSON.parse(await readFile(localPath, 'utf8'));
  const res = await fetch(SRC_URL, {
    headers: { 'user-agent': 'eleicoes-2026 world map builder' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

const geo = await load();
if (!Array.isArray(geo?.features)) throw new Error('geojson invalido');

/** @type {Record<string, {path: string, centroid: [number, number]}>} */
const countries = {};
const skipped = [];

for (const feature of geo.features) {
  const props = feature?.properties ?? {};
  let iso = String(props.ISO_A2_EH ?? props.ISO_A2 ?? '').trim().toUpperCase();
  if (iso === 'CN-TW') iso = 'TW';
  if (iso === '-99') {
    const name = String(props.NAME ?? '');
    const alias = {
      'N. Cyprus': 'CY', Somaliland: 'SO', Kosovo: 'XK', 'French Guiana': 'GF',
    }[name];
    iso = alias ?? String(props.ISO_A2 ?? '').trim().toUpperCase();
  }
  if (!/^[A-Z]{2}$/.test(iso) || iso === 'AQ') continue;
  const polygons = polygonsOf(feature.geometry);
  if (!polygons.length) continue;

  const detached = DETACHED[iso] ?? [];
  const groups = [{ iso, polygons: [] }, ...detached.map((d) => ({ ...d, polygons: [] }))];

  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    if (ringArea(outer) < MIN_AREA) continue;
    const lons = outer.map(([lon]) => lon);
    const lats = outer.map(([, lat]) => lat);
    const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const owner = detached.find(({ bbox: [x1, y1, x2, y2] }) => (
      cLon >= x1 && cLon <= x2 && cLat >= y1 && cLat <= y2
    ));
    (owner ? groups.find((g) => g.iso === owner.iso) : groups[0]).polygons.push(poly);
  }

  for (const group of groups) {
    if (!group.polygons.length) continue;
    const paths = [];
    const usable = [];
    for (const poly of group.polygons) {
      const outer = poly[0];
      const clipped = outer.filter(([, lat]) => lat >= LAT_CUT);
      if (clipped.length < 3) continue;
      // Anéis externos e buracos viram subpaths (fill-rule evenodd no SVG).
      usable.push(poly);
      paths.push(ringToPath(outer));
      for (const hole of poly.slice(1)) {
        if (hole.length >= 4) paths.push(ringToPath(hole));
      }
    }
    const d = paths.filter(Boolean).join('');
    if (!d) { skipped.push(group.iso); continue; }
    const centroid = centroidOf(usable);
    if (!centroid) { skipped.push(group.iso); continue; }
    const prev = countries[group.iso];
    if (prev) {
      // Mesmo ISO em features distintas (ex.: Chipre + N. Chipre): concatena.
      prev.path += d;
    } else {
      countries[group.iso] = { path: d, centroid, name: String(props.NAME_PT ?? props.NAME ?? group.iso) };
    }
  }
}

const isoList = Object.keys(countries).sort();
const out = {
  source: 'Natural Earth 50m admin_0_countries (dominio publico)',
  projection: 'mercator',
  viewBox: [WIDTH, HEIGHT],
  latCut: LAT_CUT,
  tolerance: TOLERANCE,
  count: isoList.length,
  countries: Object.fromEntries(isoList.map((iso) => [iso, countries[iso]])),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));

const bytes = Buffer.byteLength(JSON.stringify(out));
console.log(`world.json: ${isoList.length} paises, ${(bytes / 1024).toFixed(1)}KB, viewBox 0 0 ${WIDTH} ${HEIGHT}`);
if (skipped.length) console.log(`descartados: ${skipped.join(',')}`);
if (bytes > 400 * 1024) console.warn('AVISO: acima de 400KB');
