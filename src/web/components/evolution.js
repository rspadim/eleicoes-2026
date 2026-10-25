// Card de evolução da apuração no tempo: % de seções apuradas + % de cada
// candidato, em SVG puro. Duas séries no mesmo eixo (0-100%).
import { fmtPct, fmtShortClock } from '../lib/format.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 640;
const H = 200;
const PAD = { top: 14, right: 14, bottom: 22, left: 30 };

const SVG_NS = NS;

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function pathFrom(points, x, y) {
  let d = '';
  points.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(p)} ${y(p)}`; });
  return d;
}

export function createEvolution(elRoot) {
  if (!elRoot) throw new TypeError('createEvolutionCard: elemento obrigatório');
  elRoot.replaceChildren();

  let pontos = [];
  let destruido = false;

  const cabecalho = document.createElement('div');
  cabecalho.className = 'evo-head';
  const titulo = document.createElement('p');
  titulo.className = 'evo-title';
  titulo.textContent = 'Evolução da apuração';
  const meta = document.createElement('p');
  meta.className = 'evo-meta';
  meta.textContent = 'Aguardando histórico…';
  cabecalho.append(titulo, meta);

  const corpo = document.createElement('div');
  corpo.className = 'evo-body';

  elRoot.append(cabecalho, corpo);

  function render() {
    corpo.replaceChildren();
    if (pontos.length < 2) {
      const vazio = document.createElement('p');
      vazio.className = 'card-empty';
      vazio.textContent = 'A evolução aparece depois de duas leituras do TSE.';
      corpo.appendChild(vazio);
      return;
    }

    const primeiro = pontos[0];
    const ultimo = pontos.at(-1);
    const ultimoCandidato = Object.keys(ultimo.candidates ?? {});
    const series = ultimoCandidato.map((n) => ({
      n,
      name: ultimo.candidates[n]?.name ?? n,
      color: ultimo.candidates[n]?.color ?? 'var(--text-dim)',
      get: (p) => Number(p.candidates?.[n]?.pct) || 0,
    }));
    series.push({
      n: 'counted',
      name: 'Seções apuradas',
      color: 'var(--text-faint)',
      dashed: true,
      get: (p) => Number(p.counted) || 0,
    });

    const maxY = 100;
    const x = (p) => {
      const t0 = Date.parse(primeiro.ts);
      const t1 = Date.parse(ultimo.ts);
      const ratio = t1 > t0 ? (Date.parse(p.ts) - t0) / (t1 - t0) : 0;
      return PAD.left + ratio * (W - PAD.left - PAD.right);
    };
    const y = (valor) => H - PAD.bottom - (Math.max(0, Math.min(maxY, valor)) / maxY) * (H - PAD.top - PAD.bottom);

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': `Evolução da apuração entre ${fmtShortClock(primeiro.ts)} e ${fmtShortClock(ultimo.ts)}`,
      preserveAspectRatio: 'none',
    });
    svg.classList.add('evo-chart');

    // grade horizontal
    for (const valor of [0, 25, 50, 75, 100]) {
      svg.appendChild(el('line', {
        x1: PAD.left, x2: W - PAD.right, y1: y(valor), y2: y(valor),
        stroke: 'var(--border)', 'stroke-width': '1', 'stroke-dasharray': valor === 0 ? '' : '2 4',
      }));
      const rotulo = el('text', { x: PAD.left - 6, y: y(valor) + 3, 'text-anchor': 'end' });
      rotulo.setAttribute('fill', 'var(--text-faint)');
      rotulo.setAttribute('font-size', '9');
      rotulo.textContent = `${valor}%`;
      svg.appendChild(rotulo);
    }

    for (const serie of series) {
      const pontosSerie = pontos.filter((p) => serie.get(p) > 0 || serie.n === 'counted');
      if (pontosSerie.length < 2) continue;
      svg.appendChild(el('path', {
        d: pathFrom(pontosSerie, x, (p) => y(serie.get(p))),
        fill: 'none',
        stroke: serie.color,
        'stroke-width': serie.dashed ? '1.4' : '2',
        'stroke-dasharray': serie.dashed ? '4 4' : '',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        opacity: serie.dashed ? '0.8' : '1',
      }));
    }

    // eixo x: início e fim
    for (const [ponto, anchor] of [[primeiro, 'start'], [ultimo, 'end']]) {
      const t = el('text', {
        x: anchor === 'start' ? PAD.left : W - PAD.right,
        y: H - 6,
        'text-anchor': anchor,
      });
      t.setAttribute('fill', 'var(--text-faint)');
      t.setAttribute('font-size', '9');
      t.textContent = fmtShortClock(ponto.ts);
      svg.appendChild(t);
    }

    corpo.appendChild(svg);

    const legenda = document.createElement('div');
    legenda.className = 'evo-legend';
    for (const serie of series) {
      const item = document.createElement('span');
      item.className = 'evo-legend-item';
      const sw = document.createElement('span');
      sw.className = 'evo-swatch';
      sw.style.background = serie.color;
      if (serie.dashed) sw.style.opacity = '0.6';
      const valor = serie.get(ultimo);
      item.append(sw, document.createTextNode(`${serie.name} ${fmtPct(valor, 1)}`));
      legenda.appendChild(item);
    }
    corpo.appendChild(legenda);

    meta.textContent = `${fmtShortClock(primeiro.ts)} → ${fmtShortClock(ultimo.ts)} · ${pontos.length} leituras`;
  }

  render();

  return {
    update(payload) {
      if (destruido || !payload) return;
      const lista = Array.isArray(payload) ? payload : payload.points;
      if (!Array.isArray(lista)) return;
      pontos = lista
        .filter((p) => p && p.ts)
        .map((p) => ({ ...p, ts: typeof p.ts === 'string' ? p.ts : new Date(p.ts).toISOString() }))
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      render();
    },
    destroy() {
      destruido = true;
      elRoot.replaceChildren();
      pontos = [];
    },
  };
}
