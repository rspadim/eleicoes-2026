// Linha do tempo do replay: slider com marcas dos snapshots (datas em title), label do instante,
// play/pause, velocidade e botão AO VIVO. ←/→ andam um snapshot.
// O valor do slider é o timestamp do snapshot — assim quem escuta o input já recebe um instante.
// Ao chegar ao fim do histórico os controles desabilitam e mostram o aviso.

import { fmtPct, fmtShortClock, fmtTimeAgo } from '../lib/format.js';

const VELOCIDADES = [1, 10, 30, 60, 120];

/**
 * Converte instante em ms. Aceita número, Date e ISO 8601
 * (o servidor guarda ts como texto ISO e o app manda `current` como objeto).
 */
function paraMs(valor) {
  if (valor == null) return null;
  if (valor instanceof Date) return Number.isFinite(valor.getTime()) ? valor.getTime() : null;
  if (typeof valor === 'object') return paraMs(valor.ts ?? valor.t ?? valor.current);
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).trim();
  if (!texto) return null;
  if (/^\d+$/.test(texto)) {
    const n = Number(texto);
    return Number.isFinite(n) ? n : null;
  }
  const ms = Date.parse(texto);
  return Number.isFinite(ms) ? ms : null;
}

function normalizarLista(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .map((item) => paraMs(item))
    .filter((ts) => ts != null)
    .sort((a, b) => a - b)
    // remove duplicatas para o passo por teclado ser previsível
    .filter((ts, i, lista) => i === 0 || ts !== lista[i - 1]);
}

function indiceMaisProximo(lista, alvo) {
  if (!lista.length) return -1;
  const ts = paraMs(alvo);
  if (ts == null) return lista.length - 1;
  let melhor = 0;
  let dist = Math.abs(lista[0] - ts);
  for (let i = 1; i < lista.length; i += 1) {
    const d = Math.abs(lista[i] - ts);
    if (d < dist) {
      dist = d;
      melhor = i;
    }
  }
  return melhor;
}

function rotuloDoInstante(ts, pct) {
  if (ts == null) return 'sem instantâneo';
  const hora = fmtShortClock(ts);
  const apurado = Number(pct);
  if (!Number.isFinite(apurado)) return hora;
  return `${hora} · ${fmtPct(apurado, 1)} apurado`;
}

export function createTimeline(el, { onSeek, onPlay, onPause, onSpeed, onLive } = {}) {
  if (!el) throw new TypeError('createTimeline: elemento obrigatório');
  el.replaceChildren();

  const caixa = document.createElement('div');
  caixa.className = 'timeline';

  const principal = document.createElement('input');
  principal.type = 'range';
  principal.className = 'range';
  principal.min = '0';
  principal.max = '0';
  principal.step = '1';
  principal.value = '0';
  principal.setAttribute('aria-label', 'Instantâneo do histórico (setas esquerda e direita andam um snapshot)');
  principal.setAttribute('aria-valuetext', 'sem instantâneo');
  principal.disabled = true;

  const marcas = document.createElement('div');
  marcas.className = 'timeline-marks';
  marcas.setAttribute('aria-hidden', 'true');

  caixa.append(principal, marcas);

  const info = document.createElement('div');
  info.className = 'timeline-info';
  info.style.display = 'flex';
  info.style.alignItems = 'center';
  info.style.gap = '8px';
  info.style.flexWrap = 'wrap';
  info.style.fontSize = '0.72rem';

  const instante = document.createElement('span');
  instante.className = 'timeline-current';
  instante.style.fontFamily = 'var(--mono)';
  instante.setAttribute('aria-live', 'polite');
  instante.textContent = 'sem instantâneo';

  const estadoTag = document.createElement('span');
  estadoTag.className = 'timeline-status';
  estadoTag.style.color = 'var(--text-faint)';

  const controles = document.createElement('div');
  controles.className = 'timeline-controls';
  controles.style.display = 'flex';
  controles.style.alignItems = 'center';
  controles.style.gap = '6px';
  controles.style.flexWrap = 'wrap';

  const btnPlay = document.createElement('button');
  btnPlay.type = 'button';
  btnPlay.className = 'btn btn-ghost btn-sm';
  btnPlay.dataset.timeline = 'play';
  btnPlay.textContent = '▶ Reproduzir';
  btnPlay.setAttribute('aria-label', 'Reproduzir gravação');

  const btnPause = document.createElement('button');
  btnPause.type = 'button';
  btnPause.className = 'btn btn-ghost btn-sm';
  btnPause.dataset.timeline = 'pause';
  btnPause.textContent = '⏸ Pausar';
  btnPause.setAttribute('aria-label', 'Pausar reprodução');

  const rotuloVelocidade = document.createElement('label');
  rotuloVelocidade.className = 'speed-label';
  rotuloVelocidade.textContent = 'Velocidade';
  rotuloVelocidade.htmlFor = 'tl-speed';

  const velocidade = document.createElement('select');
  velocidade.className = 'select';
  velocidade.id = 'tl-speed';
  velocidade.setAttribute('aria-label', 'Velocidade do replay');
  for (const fator of VELOCIDADES) {
    const opcao = document.createElement('option');
    opcao.value = String(fator);
    opcao.textContent = `${fator}×`;
    velocidade.appendChild(opcao);
  }
  velocidade.value = '1';

  const btnLive = document.createElement('button');
  btnLive.type = 'button';
  btnLive.className = 'btn btn-ghost btn-sm';
  btnLive.dataset.timeline = 'live';
  btnLive.textContent = 'AO VIVO';
  btnLive.setAttribute('aria-label', 'Voltar para o ao vivo');
  btnLive.setAttribute('aria-pressed', 'true');

  const fim = document.createElement('span');
  fim.className = 'timeline-end';
  fim.style.color = 'var(--warn)';
  fim.hidden = true;
  fim.textContent = 'fim do histórico';

  controles.append(btnPlay, btnPause, rotuloVelocidade, velocidade, btnLive);
  info.append(instante, estadoTag, fim);
  // Controles próprios. Se a página já tem os equivalentes no rodapé
  // (#btn-play, #btn-pause, #speed, #btn-live) não duplicamos: os cliques são
  // delegados a eles quando nenhum callback é passado.
  const externoPlay = typeof document.querySelector === 'function' ? document.querySelector('#btn-play') : null;
  const temControlesExternos = Boolean(externoPlay);

  // Garante as velocidades do contrato mesmo usando o select da página.
  const seletorExterno = typeof document.querySelector === 'function' ? document.querySelector('#speed') : null;
  if (seletorExterno) {
    for (const fator of VELOCIDADES) {
      const valor = String(fator);
      if (![...seletorExterno.options].some((o) => o.value === valor)) {
        const opcao = document.createElement('option');
        opcao.value = valor;
        opcao.textContent = `${fator}×`;
        seletorExterno.appendChild(opcao);
      }
    }
  }

  el.append(caixa, info);
  if (!temControlesExternos) el.appendChild(controles);

  let lista = [];
  let atual = null;
  let playing = false;
  let speed = 1;
  let finished = false;
  let pctAtual = null;
  let arrastando = false;
  let destruido = false;

  function indiceAtual() {
    return indiceMaisProximo(lista, atual);
  }

  function desenharMarcas() {
    marcas.replaceChildren();
    if (lista.length < 2) return;
    const inicio = lista[0];
    const largura = lista[lista.length - 1] - inicio || 1;
    for (const ts of lista) {
      const marca = document.createElement('span');
      marca.className = 'timeline-mark';
      marca.style.left = `${((ts - inicio) / largura) * 100}%`;
      marca.title = fmtShortClock(ts);
      marcas.appendChild(marca);
    }
  }

  function aplicarEstado() {
    const navegavel = !finished && lista.length > 1;
    const indice = indiceAtual();
    const alvo = indice >= 0 ? lista[indice] : 0;

    principal.min = String(lista[0] ?? 0);
    principal.max = String(lista[lista.length - 1] ?? 0);
    principal.value = String(alvo);
    principal.disabled = !navegavel;

    const posicao = lista.length > 1 && indice >= 0 ? (indice / (lista.length - 1)) * 100 : 0;
    principal.style.setProperty('--progress', `${posicao}%`);
    principal.setAttribute('aria-valuetext', rotuloDoInstante(alvo, pctAtual));

    instante.textContent = rotuloDoInstante(atual, pctAtual);
    if (atual != null) instante.title = `Atualizado ${fmtTimeAgo(atual)}`;
    else instante.removeAttribute('title');

    estadoTag.textContent = lista.length > 1
      ? `${indice + 1} de ${lista.length}`
      : (lista.length === 1 ? '1 de 1' : '');

    btnPlay.disabled = finished || playing || !navegavel;
    btnPause.disabled = finished || !playing || !navegavel;
    velocidade.disabled = finished || !navegavel;
    if (velocidade.value !== String(speed)) velocidade.value = String(speed);
    if (seletorExterno && seletorExterno.value !== String(speed)
      && document.activeElement !== seletorExterno) {
      seletorExterno.value = String(speed);
    }

    // "ao vivo" = parado no último instante, sem reprodução e sem histórico encerrado
    const noFim = indice >= 0 && indice === lista.length - 1;
    btnLive.setAttribute('aria-pressed', String(!finished && !playing && noFim));

    fim.hidden = !finished;
  }

  function aoMover(evento) {
    const ts = Number(evento.target.value);
    if (!Number.isFinite(ts)) return;
    arrastando = true;
    atual = ts;
    aplicarEstado();
  }

  function aoSoltar(evento) {
    const ts = Number(evento.target.value);
    if (Number.isFinite(ts)) {
      atual = ts;
      aplicarEstado();
    }
    arrastando = false;
    if (Number.isFinite(ts) && ts > 0) {
      try { onSeek?.(ts); } catch { /* handler externo */ }
    }
  }

  function aoTeclar(evento) {
    if (finished || lista.length < 2) return;
    if (evento.key !== 'ArrowLeft' && evento.key !== 'ArrowRight') return;
    evento.preventDefault();
    const passo = evento.key === 'ArrowRight' ? 1 : -1;
    const indice = Math.max(0, Math.min(lista.length - 1, indiceAtual() + passo));
    const ts = lista[indice];
    if (!Number.isFinite(ts)) return;
    atual = ts;
    aplicarEstado();
    try { onSeek?.(ts); } catch { /* handler externo */ }
  }

  /* Sem callback, delega para os controles da página (quando existirem):
     o rodapé já traz #btn-play, #btn-pause, #speed e #btn-live. */
  function acionarSeletor(seletor) {
    const alvo = document.querySelector(seletor);
    if (!alvo) return false;
    alvo.click();
    return true;
  }

  function aoPlay() {
    if (btnPlay.disabled) return;
    if (onPlay) { try { onPlay(); } catch { /* handler externo */ } return; }
    acionarSeletor('#btn-play');
  }

  function aoPause() {
    if (btnPause.disabled) return;
    if (onPause) { try { onPause(); } catch { /* handler externo */ } return; }
    acionarSeletor('#btn-pause');
  }

  function aoLive() {
    if (onLive) { try { onLive(); } catch { /* handler externo */ } return; }
    acionarSeletor('#btn-live');
  }

  function aoVelocidade() {
    speed = Number(velocidade.value) || 1;
    if (onSpeed) { try { onSpeed(speed); } catch { /* handler externo */ } return; }
    const externo = document.querySelector('#speed');
    if (externo && 'value' in externo) {
      externo.value = String(speed);
      externo.dispatchEvent(new Event('change'));
    }
  }

  principal.addEventListener('input', aoMover);
  principal.addEventListener('change', aoSoltar);
  principal.addEventListener('keydown', aoTeclar);
  btnPlay.addEventListener('click', aoPlay);
  btnPause.addEventListener('click', aoPause);
  btnLive.addEventListener('click', aoLive);
  velocidade.addEventListener('change', aoVelocidade);

  aplicarEstado();

  return {
    update(dados) {
      if (destruido || !dados || typeof dados !== 'object') return;
      lista = normalizarLista(dados.timeline);
      const alvo = paraMs(dados.current);
      // durante o arrasto o valor do slider manda, para o update não puxar o cursor
      if (!arrastando) atual = alvo ?? (lista.length ? lista[lista.length - 1] : null);
      pctAtual = Number.isFinite(Number(dados.pct)) ? Number(dados.pct) : null;
      playing = Boolean(dados.playing);
      speed = Number(dados.speed) || 1;
      finished = Boolean(dados.finished);
      desenharMarcas();
      aplicarEstado();
    },
    destroy() {
      destruido = true;
      principal.removeEventListener('input', aoMover);
      principal.removeEventListener('change', aoSoltar);
      principal.removeEventListener('keydown', aoTeclar);
      btnPlay.removeEventListener('click', aoPlay);
      btnPause.removeEventListener('click', aoPause);
      btnLive.removeEventListener('click', aoLive);
      velocidade.removeEventListener('change', aoVelocidade);
      el.replaceChildren();
      lista = [];
    },
  };
}

/*
Exemplo de uso:

import { createTimeline } from './components/timeline.js';

const linha = createTimeline(document.querySelector('#timeline'), {
  onSeek: (ts) => console.log('buscar', new Date(ts)),
  onPlay: () => console.log('play'),
  onPause: () => console.log('pause'),
  onSpeed: (x) => console.log('velocidade', x),
  onLive: () => console.log('voltar ao vivo'),
});

// `timeline` aceita números em ms ou strings ISO; `current` aceita os dois
// formatos, o instante ou um objeto { ts }.
linha.update({
  timeline: [1759500000000, 1759500060000],
  current: 1759500060000,
  pct: 42.3,
  playing: false,
  speed: 1,
  finished: false,
});

// ao chegar ao fim do histórico os controles desabilitam e aparece o aviso:
linha.update({ ...ultimo, finished: true });

// ao desmontar:
linha.destroy();
*/
