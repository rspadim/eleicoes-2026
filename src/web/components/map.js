// Mapa coroplético interativo do Brasil por UF.
// Acessível por teclado (cada UF é um path role="button" tabindex="0"), com título nativo,
// aria-label descritivo, destaque de seleção, flash de mudança e modo replay tracejado.
// Geodados são carregados de /geo (com cache em memória) e há fallback em grade de botões.

import { CANDIDATE_COLORS, DEFAULT_COLOR, UF_NAMES, UFS } from '../../shared/config.js';
import { fmtPct } from '../lib/format.js';

const GEO_URL = '/geo/br-ufs.json';
const CENTROIDS_URL = '/geo/uf-centroids.json';
const SVG_NS = 'http://www.w3.org/2000/svg';
const FLASH_MS = 600;
const MENOS_MOVIMENTO = '(prefers-reduced-motion: reduce)';

// espelho local de uf-codes para não depender do arquivo (que pode estar em criação)
const IBGE_PARA_UF = {
  11: 'ro', 12: 'ac', 13: 'am', 14: 'rr', 15: 'pa', 16: 'ap', 17: 'to',
  21: 'ma', 22: 'pi', 23: 'ce', 24: 'rn', 25: 'pb', 26: 'pe', 27: 'al',
  28: 'se', 29: 'ba', 31: 'mg', 32: 'es', 33: 'rj', 35: 'sp', 41: 'pr',
  42: 'sc', 43: 'rs', 50: 'ms', 51: 'mt', 52: 'go', 53: 'df',
};

let normalizar = (valor) => {
  const bruto = String(valor ?? '').trim().toLowerCase();
  if (!bruto) return null;
  if (UF_NAMES[bruto]) return bruto;
  return IBGE_PARA_UF[bruto.replace(/^0+/, '')] ?? null;
};

// uf-codes é opcional; se falhar, o espelho acima cobre os 27 códigos do IBGE.
import('../../shared/uf-codes.js')
  .then((mod) => {
    if (typeof mod?.ufFromIbge === 'function') {
      normalizar = (valor) => {
        const bruto = String(valor ?? '').trim().toLowerCase();
        if (!bruto) return null;
        if (UF_NAMES[bruto]) return bruto;
        return mod.ufFromIbge(bruto) ?? null;
      };
    }
  })
  .catch(() => {});

// cache compartilhado entre montagens (uma navegação não refaz o download)
const geoCache = { paths: null, viewBox: null, centroids: null, error: null, promise: null };

function carregarGeo() {
  if (geoCache.paths) return Promise.resolve(geoCache);
  if (geoCache.promise) return geoCache.promise;
  // uma falha anterior não impede uma nova tentativa (o cache de erro é só informativo)

  geoCache.promise = (async () => {
    const [geo, centros] = await Promise.all([
      fetch(GEO_URL, { headers: { accept: 'application/json' } }),
      fetch(CENTROIDS_URL, { headers: { accept: 'application/json' } }).catch(() => null),
    ]);
    if (!geo.ok) throw new Error(`HTTP ${geo.status}`);
    const dados = await geo.json();
    const paths = dados?.paths;
    if (!paths || typeof paths !== 'object' || !Object.keys(paths).length) {
      throw new Error('geometria vazia');
    }
    geoCache.paths = paths;
    geoCache.viewBox = typeof dados.viewBox === 'string' ? dados.viewBox : '0 0 1000 1000';
    if (centros?.ok) {
      try {
        const mapa = await centros.json();
        if (mapa && typeof mapa === 'object') geoCache.centroids = mapa;
      } catch { /* centroides são opcionais */ }
    }
    geoCache.error = null;
    return geoCache;
  })();

  geoCache.promise = geoCache.promise.catch((err) => {
    geoCache.promise = null;
    geoCache.error = err;
    throw err;
  });

  return geoCache.promise;
}

function criarSvg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [chave, valor] of Object.entries(attrs)) node.setAttribute(chave, String(valor));
  return node;
}

function texto(elemento, valor) {
  elemento.textContent = valor == null ? '' : String(valor);
}

function corDoCandidato(n) {
  return CANDIDATE_COLORS[n] ?? DEFAULT_COLOR;
}

function corDoLider(ufDados, candidatos) {
  const n = ufDados?.leader;
  if (!n) return DEFAULT_COLOR;
  const achado = (candidatos ?? []).find((c) => String(c.n) === String(n));
  return achado?.color || corDoCandidato(n);
}

/** Opacidade cresce com o percentual do líder (0.25 → 0.95). */
function opacidadeDoLider(pctLider) {
  const n = Math.max(0, Math.min(100, Number(pctLider) || 0));
  return Number((0.25 + (n / 100) * 0.7).toFixed(3));
}

function liderDe(ufDados) {
  const n = ufDados?.leader;
  if (!n) return null;
  return (ufDados?.candidates ?? []).find((c) => String(c.n) === String(n)) ?? null;
}

/* ------------------------------------------------------------- camadas */

export const LAYERS = [
  { id: 'leader', label: 'Líder', hint: 'Cor do candidato que lidera; intensidade = % dele no estado.' },
  { id: 'margin', label: 'Vantagem', hint: 'Intensidade = margem do líder sobre o 2º colocado (p.p.).' },
  { id: 'change', label: 'Mudança', hint: 'Verde = % do líder subiu desde a última leitura; vermelho = caiu.' },
  { id: 'abstention', label: 'Abstenção', hint: 'Quanto maior a abstenção sobre o eleitorado, mais clara a UF.' },
  { id: 'progress', label: 'Apuração', hint: 'Quanto maior o % de seções apuradas, mais clara a UF.' },
];

function escalaSequencial(pct) {
  const n = Math.max(0, Math.min(100, Number(pct) || 0));
  // rampa azul-escuro -> azul-claro legível nos dois temas
  const t = n / 100;
  const r = Math.round(30 + t * 100);
  const g = Math.round(80 + t * 110);
  const b = Math.round(170 + t * 70);
  return `rgb(${r} ${g} ${b})`;
}

function escalaDivergente(delta) {
  const n = Math.max(-10, Math.min(10, Number(delta) || 0));
  if (Math.abs(n) < 0.05) return 'var(--bg-elev-2)';
  const t = Math.min(1, Math.abs(n) / 5);
  return n > 0
    ? `color-mix(in srgb, #2ea043 ${Math.round(25 + t * 75)}%, var(--bg-elev-2))`
    : `color-mix(in srgb, #d1394a ${Math.round(25 + t * 75)}%, var(--bg-elev-2))`;
}

/** Cor + opacidade de uma UF para a camada ativa. */
function estiloDaCamada(uf, dados, camada) {
  const semDados = !temApuracao(dados);
  const lider = liderDe(dados);
  switch (camada) {
    case 'margin': {
      if (semDados || !lider) return { fill: 'var(--bg-elev-2)', opacity: 1 };
      const margem = Math.max(0, Math.min(60, Number(dados.margin) || 0));
      return { fill: corDoLider(dados, dados?.candidates), opacity: Number((0.2 + (margem / 60) * 0.75).toFixed(3)) };
    }
    case 'change': {
      if (semDados || !lider) return { fill: 'var(--bg-elev-2)', opacity: 1 };
      return { fill: escalaDivergente(dados?.delta?.leaderPct), opacity: 1 };
    }
    case 'abstention': {
      if (semDados) return { fill: 'var(--bg-elev-2)', opacity: 1 };
      return { fill: escalaSequencial(dados?.abstentionPct ?? 0), opacity: 1 };
    }
    case 'progress': {
      if (semDados) return { fill: 'var(--bg-elev-2)', opacity: 1 };
      return { fill: escalaSequencial(dados?.pct ?? 0), opacity: 1 };
    }
    case 'leader':
    default: {
      if (semDados || !lider) return { fill: 'var(--bg-elev-2)', opacity: 1 };
      return { fill: corDoLider(dados, dados?.candidates), opacity: opacidadeDoLider(lider.pct) };
    }
  }
}

function temApuracao(ufDados) {
  if (!ufDados) return false;
  if (Number(ufDados.pct) > 0) return true;
  const votos = ufDados.votes;
  if (typeof votos === 'number') return votos > 0;
  if (votos && typeof votos === 'object') {
    return Object.values(votos).some((v) => (Number(v) || 0) > 0);
  }
  return false;
}

/**
 * @param {HTMLElement} el
 * @param {{onSelect?: (uf: string) => void}} opcoes
 */
export function createMap(el, { onSelect } = {}) {
  if (!el) throw new TypeError('createMap: elemento obrigatório');
  el.replaceChildren();
  // Âncora de teclado: Tab percorre as UFs, Enter/Espaço seleciona.
  if (!el.hasAttribute('role')) el.setAttribute('role', 'application');

  let destruido = false;
  let estado = null;
  const semMovimento = typeof window.matchMedia === 'function' ? window.matchMedia(MENOS_MOVIMENTO) : null;
  let selecionada = null;
  let modo = 'live';
  let destacado = null;
  let svg = null;
  let painelFallback = null;
  let legendaEscala = null;
  const paths = new Map();
  const hachuras = new Map();
  const flashando = new Set();
  const timers = new Map();
  let avisoEstado = null;
  let hatchId = '';
  let camada = 'leader';
  let seletorCamadas = null;

  let sequencia = 0;
  function idHachura() {
    sequencia += 1;
    return `uf-sem-dados-${sequencia}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function montarLegendaEscala() {
    const caixa = document.createElement('div');
    caixa.className = 'map-scale';
    caixa.setAttribute('role', 'note');
    Object.assign(caixa.style, {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px',
      padding: '6px 10px 8px', fontSize: '0.68rem', color: 'var(--text-faint)',
    });

    const rotulo = document.createElement('span');
    rotulo.className = 'map-scale-label';

    const minimo = document.createElement('span');
    const trilha = document.createElement('span');
    trilha.className = 'map-scale-track';
    Object.assign(trilha.style, {
      display: 'inline-flex', width: '84px', height: '8px', borderRadius: '999px',
      overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-elev-2)',
    });
    const amostras = document.createElement('span');
    amostras.className = 'map-scale-samples';
    Object.assign(amostras.style, { display: 'flex', width: '100%', gap: '2px' });
    trilha.appendChild(amostras);

    const maximo = document.createElement('span');

    const semDados = document.createElement('span');
    semDados.className = 'map-scale-nodata';
    Object.assign(semDados.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '8px' });
    const hachura = document.createElement('span');
    hachura.setAttribute('aria-hidden', 'true');
    Object.assign(hachura.style, {
      display: 'inline-block', width: '14px', height: '8px',
      border: '1px solid var(--border-strong)',
      background: 'repeating-linear-gradient(45deg, var(--text-faint) 0 1px, transparent 1px 4px)',
    });
    const textoHachura = document.createElement('span');
    textoHachura.textContent = 'sem apuração';
    semDados.append(hachura, textoHachura);

    caixa.append(rotulo, minimo, trilha, maximo, semDados);

    function amostra(cor, rotuloAmostra) {
      const s = document.createElement('span');
      s.style.flex = '1';
      s.style.background = cor;
      if (rotuloAmostra) s.title = rotuloAmostra;
      return s;
    }

    function mostrarTrilha(mostrar) {
      trilha.style.display = mostrar ? 'inline-flex' : 'none';
      minimo.style.display = mostrar ? '' : 'none';
      maximo.style.display = mostrar ? '' : 'none';
    }

    function pintar() {
      const def = LAYERS.find((l) => l.id === camada) ?? LAYERS[0];
      rotulo.textContent = def.hint;
      caixa.setAttribute('aria-label', def.hint);
      amostras.replaceChildren();

      semDados.style.display = camada === 'leader' ? '' : 'none';

      if (camada === 'change') {
        mostrarTrilha(true);
        minimo.textContent = '−5 p.p.';
        maximo.textContent = '+5 p.p.';
        amostras.append(
          amostra('color-mix(in srgb, #d1394a 90%, var(--bg-elev-2))', 'caiu'),
          amostra('var(--bg-elev-2)', 'estável'),
          amostra('color-mix(in srgb, #2ea043 90%, var(--bg-elev-2))', 'subiu'),
        );
        return;
      }

      if (camada === 'leader') {
        mostrarTrilha(false);
        for (const c of (estado?.candidates ?? []).slice(0, 4)) {
          const item = document.createElement('span');
          item.className = 'legend-item';
          const sw = document.createElement('span');
          sw.className = 'legend-swatch';
          sw.style.background = c.color;
          item.append(sw, document.createTextNode(`${c.nmu ?? c.n} ${fmtPct(Number(c.pct) || 0, 1)}`));
          amostras.appendChild(item);
        }
        return;
      }

      mostrarTrilha(true);
      minimo.textContent = camada === 'margin' ? '0 p.p.' : '0%';
      maximo.textContent = camada === 'margin' ? '60 p.p.' : '100%';
      for (let passo = 0; passo <= 4; passo += 1) {
        amostras.appendChild(amostra(escalaSequencial((passo / 4) * 100)));
      }
    }

    pintar();
    caixa._repintar = pintar;
    return caixa;
  }

  function montarSeletorCamadas() {
    const caixa = document.createElement('div');
    caixa.className = 'map-layers';
    caixa.setAttribute('role', 'tablist');
    caixa.setAttribute('aria-label', 'Camada do mapa');

    for (const def of LAYERS) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'map-layer-btn';
      botao.dataset.layer = def.id;
      botao.textContent = def.label;
      botao.title = def.hint;
      botao.setAttribute('role', 'tab');
      botao.setAttribute('aria-selected', String(def.id === camada));
      botao.addEventListener('click', () => {
        camada = def.id;
        for (const outro of caixa.querySelectorAll('.map-layer-btn')) {
          outro.setAttribute('aria-selected', String(outro.dataset.layer === camada));
        }
        legendaEscala?._repintar?.();
        render();
      });
      caixa.appendChild(botao);
    }
    return caixa;
  }

  let mensagemErro = '';

  /**
   * Aviso de estado. No fallback ele vive dentro da grade, porque o app limpa
   * `.map-empty` do container logo depois de montar o componente.
   */
  function avisar(mensagem) {
    avisoEstado?.remove();
    avisoEstado = null;
    mensagemErro = mensagem || '';
    if (!mensagem) return;
    criarAviso();
  }

  function criarAviso() {
    const p = document.createElement('p');
    p.className = 'map-empty';
    p.setAttribute('role', 'status');
    p.textContent = mensagemErro;
    if (painelFallback) painelFallback.prepend(p);
    else el.appendChild(p);
    avisoEstado = p;
  }

  /** Recria o aviso se ele foi removido por fora (o app limpa `.map-empty`). */
  function garantirAviso() {
    if (!mensagemErro) return;
    if (avisoEstado && avisoEstado.parentNode) return;
    criarAviso();
  }

  /** "<UF>: <líder> <pct>%, <seções>% apurado" (ou "sem apuração"). */
  function rotuloDe(uf, dados) {
    const sigla = String(uf).toUpperCase();
    const nome = dados?.name || UF_NAMES[uf] || sigla;
    const prefixo = nome && nome !== sigla ? `${sigla} (${nome})` : sigla;
    if (!temApuracao(dados)) return `${prefixo}: sem apuração`;
    const lider = liderDe(dados);
    const nomeLider = lider?.nmu || lider?.n || '—';
    const pctLider = Number(lider?.pct) || 0;
    const pctSecoes = Number(dados?.pct) || 0;
    return `${prefixo}: ${nomeLider} ${fmtPct(pctLider, 1)}, ${fmtPct(pctSecoes, 1)} apurado`;
  }

  function aplicarSelecao() {
    for (const [uf, path] of paths) {
      if (uf === selecionada) path.setAttribute('aria-current', 'true');
      else path.removeAttribute('aria-current');
    }
  }

  function aplicarModo() {
    const tracejado = modo === 'replay';
    for (const path of paths.values()) {
      path.style.strokeDasharray = tracejado ? '3 3' : '';
    }
    if (svg) svg.dataset.mode = tracejado ? 'replay' : 'live';
  }

  function aplicarPath(uf, path) {
    const dados = estado?.ufs?.[uf];
    const title = path.querySelector('title');
    const comDados = temApuracao(dados);
    const lider = liderDe(dados);

    const estilo = estiloDaCamada(uf, dados, camada);
    path.style.fill = estilo.fill;
    path.style.fillOpacity = String(estilo.opacity);
    if (comDados) path.removeAttribute('data-empty');
    else path.setAttribute('data-empty', 'true');

    const hachura = hachuras.get(uf);
    if (hachura) hachura.style.display = comDados ? 'none' : '';

    if (title) texto(title, rotuloDe(uf, dados));
    path.setAttribute('aria-label', rotuloDe(uf, dados));

    // prioridade do contorno: flash > destaque de candidato > padrão
    if (flashando.has(uf)) {
      path.style.stroke = destacado != null && String(dados?.leader) === String(destacado) ? 'var(--text)' : 'var(--focus)';
      path.style.strokeWidth = '3';
    } else if (destacado != null && String(dados?.leader) === String(destacado)) {
      path.style.stroke = 'var(--text)';
      path.style.strokeWidth = '2.4';
    } else {
      path.style.stroke = '';
      path.style.strokeWidth = '';
    }
  }

  function render() {
    if (destruido) return;
    garantirAviso();
    if (painelFallback) {
      for (const botao of painelFallback.querySelectorAll('button[data-uf]')) {
        const uf = botao.dataset.uf;
        const dados = estado?.ufs?.[uf];
        const comDados = temApuracao(dados);
        const lider = liderDe(dados);
        botao.style.borderColor = comDados && lider ? corDoLider(dados, dados?.candidates) : '';
        botao.setAttribute('aria-label', rotuloDe(uf, dados));
        const pct = botao.querySelector('.uf-fallback-pct');
        if (pct) texto(pct, comDados ? fmtPct(Number(lider?.pct) || 0, 1) : '—');
        if (uf === selecionada) botao.setAttribute('aria-current', 'true');
        else botao.removeAttribute('aria-current');
      }
      return;
    }
    for (const uf of paths.keys()) {
      const path = paths.get(uf);
      if (path) aplicarPath(uf, path);
    }
  }

  function selecionar(uf) {
    const alvo = normalizar(uf) ?? uf;
    if (!alvo) return;
    selecionada = alvo;
    aplicarSelecao();
    if (painelFallback) render();
    try { onSelect?.(alvo); } catch { /* handler externo */ }
  }

  function montarGradeFallback() {
    el.replaceChildren();
    paths.clear();
    hachuras.clear();
    svg = null;
    legendaEscala = null;
    avisoEstado?.remove();
    avisoEstado = null;

    const grade = document.createElement('div');
    grade.className = 'map-fallback';
    grade.setAttribute('role', 'group');
    grade.setAttribute('aria-label', 'Seleção de estado pela lista');
    grade.style.display = 'grid';
    grade.style.gridTemplateColumns = 'repeat(auto-fill, minmax(88px, 1fr))';
    grade.style.gap = '6px';
    grade.style.padding = '8px';

    for (const uf of UFS) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.dataset.uf = uf;
      botao.className = 'uf-fallback';
      botao.style.display = 'grid';
      botao.style.gap = '2px';
      botao.style.padding = '8px 6px';
      botao.style.border = '1px solid var(--border)';
      botao.style.borderRadius = '8px';
      botao.style.background = 'var(--bg-elev-2)';
      botao.style.cursor = 'pointer';
      botao.style.textAlign = 'left';

      const sigla = document.createElement('span');
      sigla.textContent = uf.toUpperCase();
      sigla.style.font = '700 0.8rem/1 var(--mono)';

      const nome = document.createElement('span');
      nome.textContent = UF_NAMES[uf] ?? uf.toUpperCase();
      nome.style.fontSize = '0.66rem';
      nome.style.color = 'var(--text-faint)';
      nome.style.overflow = 'hidden';
      nome.style.textOverflow = 'ellipsis';
      nome.style.whiteSpace = 'nowrap';

      const pct = document.createElement('span');
      pct.className = 'uf-fallback-pct';
      pct.textContent = '—';
      pct.style.font = '600 0.72rem/1 var(--mono)';

      botao.append(sigla, nome, pct);
      botao.setAttribute('aria-label', rotuloDe(uf, null));
      grade.appendChild(botao);
    }

    grade.addEventListener('click', (evento) => {
      const botao = evento.target.closest('button[data-uf]');
      if (botao) selecionar(botao.dataset.uf);
    });

    painelFallback = grade;
    el.appendChild(grade);
    avisar('Não foi possível carregar o mapa. Use a lista de estados abaixo.');
    render();
  }

  function montarMapa(geo) {
    el.replaceChildren();
    paths.clear();
    hachuras.clear();
    painelFallback = null;

    svg = criarSvg('svg', {
      viewBox: geo.viewBox,
      role: 'group',
      'aria-label': 'Mapa do Brasil por unidade da federação',
      focusable: 'false',
    });
    svg.style.touchAction = 'manipulation';

    hatchId = idHachura();
    const defs = criarSvg('defs');
    const pattern = criarSvg('pattern', {
      id: hatchId,
      width: '6',
      height: '6',
      patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    });
    const linha = criarSvg('line', {
      x1: '0', y1: '0', x2: '0', y2: '6',
      stroke: 'var(--text-faint)', 'stroke-width': '1.1', 'stroke-opacity': '0.55',
    });
    pattern.appendChild(linha);
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const desenhadas = [];
    for (const uf of Object.keys(geo.paths)) {
      const sigla = normalizar(uf) ?? uf;
      if (paths.has(sigla)) continue;
      const d = geo.paths[uf];

      const base = criarSvg('path', {
        d,
        'data-uf': sigla,
        role: 'button',
        tabindex: '0',
        'aria-label': `${sigla.toUpperCase()} (${UF_NAMES[sigla] ?? sigla.toUpperCase()}): sem apuração`,
      });
      base.style.fill = 'var(--bg-elev-2)';
      base.style.fillOpacity = '1';
      base.appendChild(criarSvg('title'));
      svg.appendChild(base);
      paths.set(sigla, base);
      desenhadas.push([sigla, d]);
    }

    // hachuras e siglas por cima, sem capturar clique
    for (const [sigla, d] of desenhadas) {
      const hachura = criarSvg('path', {
        d,
        'data-hatch': sigla,
        fill: `url(#${hatchId})`,
        'aria-hidden': 'true',
      });
      hachura.style.pointerEvents = 'none';
      svg.appendChild(hachura);
      hachuras.set(sigla, hachura);
    }

    for (const [sigla] of desenhadas) {
      const centro = geo.centroids?.[sigla];
      if (!Array.isArray(centro) || centro.length < 2) continue;
      const rotulo = criarSvg('text', {
        x: Number(centro[0]),
        y: Number(centro[1]),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'aria-hidden': 'true',
      });
      rotulo.style.font = '700 12px var(--mono)';
      rotulo.style.fill = 'var(--text)';
      rotulo.style.stroke = 'var(--bg)';
      rotulo.style.strokeWidth = '2.5';
      rotulo.style.paintOrder = 'stroke';
      rotulo.style.pointerEvents = 'none';
      rotulo.textContent = sigla.toUpperCase();
      svg.appendChild(rotulo);
    }

    svg.addEventListener('click', (evento) => {
      const path = evento.target.closest?.('path[data-uf]');
      if (path) selecionar(path.dataset.uf);
    });
    svg.addEventListener('keydown', (evento) => {
      const path = evento.target.closest?.('path[data-uf]');
      if (!path) return;
      if (evento.key === 'Enter' || evento.key === ' ' || evento.key === 'Spacebar') {
        evento.preventDefault();
        selecionar(path.dataset.uf);
      }
    });

    legendaEscala = montarLegendaEscala();
    seletorCamadas = montarSeletorCamadas();
    el.append(seletorCamadas, svg, legendaEscala);
    aplicarModo();
    render();
  }

  async function iniciar() {
    avisar('Carregando mapa…');
    try {
      const geo = await carregarGeo();
      if (destruido) return;
      avisar(null);
      montarMapa(geo);
    } catch {
      if (destruido) return;
      montarGradeFallback();
    }
  }

  iniciar();

  return {
    update(novo) {
      if (destruido || !novo || typeof novo !== 'object') return;
      estado = novo;
      render();
    },

    setSelected(uf) {
      const alvo = uf == null ? null : normalizar(uf);
      selecionada = alvo;
      if (!painelFallback) {
        aplicarSelecao();
        // se a navegação partiu do próprio mapa, acompanha o foco; se o usuário
        // está em outro controle (painel, rodapé), não rouba o foco.
        const ativo = document.activeElement;
        const dentroDoMapa = Boolean(ativo && el.contains?.(ativo));
        const path = alvo ? paths.get(alvo) : null;
        if (path && dentroDoMapa) path.focus?.({ preventScroll: true });
      }
      render();
    },

    flash(ufs) {
      const lista = (Array.isArray(ufs) ? ufs : [ufs]).map((u) => normalizar(u)).filter(Boolean);
      for (const uf of lista) {
        if (!paths.has(uf) && !painelFallback?.querySelector(`button[data-uf="${uf}"]`)) continue;
        flashando.add(uf);
        // reinicia a animação mesmo em flashes consecutivos
        const alvo = paths.get(uf);
        if (alvo && !semMovimento?.matches) {
          alvo.classList.remove('flash');
          void alvo.getBoundingClientRect();
          alvo.classList.add('flash');
        }
        render();
        clearTimeout(timers.get(uf));
        timers.set(uf, setTimeout(() => {
          flashando.delete(uf);
          paths.get(uf)?.classList.remove('flash');
          timers.delete(uf);
          render();
        }, FLASH_MS));
      }
    },

    setMode(novoModo) {
      modo = novoModo === 'replay' ? 'replay' : 'live';
      aplicarModo();
    },

    setLayer(novo) {
      if (!LAYERS.some((l) => l.id === novo)) return;
      camada = novo;
      for (const botao of seletorCamadas?.querySelectorAll('.map-layer-btn') ?? []) {
        botao.setAttribute('aria-selected', String(botao.dataset.layer === camada));
      }
      legendaEscala?._repintar?.();
      render();
    },

    // usado pelo app quando o usuário clica em uma barra de candidato
    highlightCandidate(n) {
      destacado = n == null ? null : String(n);
      render();
    },

    destroy() {
      destruido = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      paths.clear();
      hachuras.clear();
      flashando.clear();
      el.replaceChildren();
      svg = null;
      painelFallback = null;
      legendaEscala = null;
      estado = null;
    },
  };
}

/*
Exemplo de uso:

import { createMap } from './components/map.js';

const mapa = createMap(document.querySelector('#map'), {
  onSelect: (uf) => console.log('estado escolhido:', uf),
});

mapa.update(estadoRecebido);       // { ufs: { sp: { pct, leader, candidates, margin } } }
mapa.setSelected('sp');            // marca a UF como atual
mapa.flash(['sp', 'rj']);          // pulsa as UFs alteradas por 600 ms
mapa.setMode('replay');            // contorno tracejado durante o replay
mapa.highlightCandidate('13');     // realça as UFs lideradas pelo candidato
mapa.setLayer('margin');           // 'leader' | 'margin' | 'change' | 'abstention' | 'progress'

// ao desmontar:
mapa.destroy();
*/
