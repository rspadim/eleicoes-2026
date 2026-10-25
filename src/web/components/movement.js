// Card de movimento: quem mais subiu e quem mais caiu na janela recente.
// Recebe { up: [], down: [], from, to, windowMs } do /api/movement.
// Cada linha: UF, candidato líder, % do líder agora e variação em p.p.

import { fmtPct, fmtShortClock } from '../lib/format.js';

const MAX = 10;

function cor(valor) {
  return typeof valor === 'string' && /^#[0-9a-f]{3,8}$/i.test(valor) ? valor : 'var(--text-dim)';
}

function linha(item, sentido) {
  const li = document.createElement('li');
  li.className = 'mv-row';
  li.dataset.dir = sentido;

  const uf = document.createElement('span');
  uf.className = 'mv-uf';
  uf.textContent = String(item.uf ?? '').toUpperCase();
  uf.title = item.name ?? '';

  const cand = document.createElement('span');
  cand.className = 'mv-cand';
  const dot = document.createElement('span');
  dot.className = 'mv-dot';
  dot.style.background = cor(item.color);
  dot.setAttribute('aria-hidden', 'true');
  cand.append(dot, document.createTextNode(item.candidateName ?? item.candidate ?? '—'));

  const pct = document.createElement('span');
  pct.className = 'mv-pct';
  pct.textContent = fmtPct(Number(item.pct) || 0, 2);

  const delta = document.createElement('span');
  delta.className = 'mv-delta';
  const d = Number(item.deltaPct) || 0;
  delta.textContent = `${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${Math.abs(d).toFixed(2)} p.p.`;

  li.append(uf, cand, pct, delta);
  li.setAttribute(
    'aria-label',
    `${item.name ?? item.uf}: ${item.candidateName ?? ''} com ${fmtPct(Number(item.pct) || 0, 2)}, ` +
    `${d > 0 ? 'subiu' : 'desceu'} ${Math.abs(d).toFixed(2)} pontos na janela`,
  );
  return li;
}

function coluna(titulo, itens, sentido, vazio) {
  const sec = document.createElement('section');
  sec.className = 'mv-col';
  sec.dataset.dir = sentido;

  const h = document.createElement('h3');
  h.className = 'mv-col-head';
  h.textContent = titulo;
  sec.appendChild(h);

  if (!itens.length) {
    const p = document.createElement('p');
    p.className = 'market-meta';
    p.textContent = vazio;
    sec.appendChild(p);
    return sec;
  }

  const ul = document.createElement('ol');
  ul.className = 'mv-list';
  itens.slice(0, MAX).forEach((item) => ul.appendChild(linha(item, sentido)));
  sec.appendChild(ul);
  return sec;
}

export function createMovement(el, { onSelect } = {}) {
  if (!el) throw new TypeError('createMovement: elemento obrigatório');
  el.replaceChildren();

  let dados = null;
  let destruido = false;

  const topo = document.createElement('div');
  topo.className = 'mv-head';
  const resumo = document.createElement('p');
  resumo.className = 'mv-meta';
  resumo.textContent = 'Comparando com a leitura de 10 min atrás.';

  const cols = document.createElement('div');
  cols.className = 'mv-cols';

  el.append(topo, cols);

  function render() {
    cols.replaceChildren();
    const up = Array.isArray(dados?.up) ? dados.up : [];
    const down = Array.isArray(dados?.down) ? dados.down : [];
    const from = dados?.from ? fmtShortClock(dados.from) : null;
    const to = dados?.to ? fmtShortClock(dados.to) : null;

    if (from && to) {
      const mins = dados?.windowMs ? Math.round(dados.windowMs / 60_000) : null;
      const realmente = from === to
        ? 'sem leitura anterior nesta janela'
        : mins
          ? `janela de ${mins} min`
          : null;
      resumo.textContent = realmente && realmente.startsWith('sem')
        ? `Ainda não há leitura anterior suficiente para comparar (${realmente}).`
        : `Variação do líder de cada estado entre ${from} e ${to}${realmente ? ` (${realmente})` : ''}.`;
    } else {
      resumo.textContent = 'Ainda não há duas leituras suficientes para comparar.';
    }

    cols.append(
      coluna('Subiu mais', up, 'up', 'Nenhuma alta na janela.'),
      coluna('Caiu mais', down, 'down', 'Nenhuma queda na janela.'),
    );
  }

  el.appendChild(resumo);
  el.insertBefore(resumo, cols);
  render();

  function onClick(event) {
    const row = event.target.closest?.('.mv-row');
    if (!row) return;
    const uf = row.querySelector('.mv-uf')?.textContent?.toLowerCase();
    if (uf) onSelect?.(uf);
  }
  cols.addEventListener('click', onClick);

  return {
    update(payload) {
      if (destruido || !payload || typeof payload !== 'object') return;
      dados = payload;
      render();
    },
    destroy() {
      destruido = true;
      cols.removeEventListener('click', onClick);
      el.replaceChildren();
    },
  };
}
