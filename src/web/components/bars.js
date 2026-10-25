// Barras horizontais da apuração nacional, ordenadas por votos.
// Cada linha é um botão (teclado nativo) que filtra o candidato; a variação vem do
// update anterior, com glifo e cor semântica. Nada de innerHTML: só DOM criado aqui.

import { CANDIDATE_COLORS, DEFAULT_COLOR } from '../../shared/config.js';
import { fmtCompact, fmtInt, fmtPct } from '../lib/format.js';

export function createBars(el, { onSelectCandidate } = {}) {
  if (!el) throw new TypeError('createBars: elemento obrigatório');
  el.replaceChildren();

  const lista = document.createElement('div');
  lista.className = 'bars';
  lista.setAttribute('role', 'list');
  lista.setAttribute('aria-label', 'Votos por candidato, ordenados por total');

  el.appendChild(lista);

  let anterior = new Map();
  let selecionado = null;
  let destruido = false;
  let aviso = null;

  // Criado sob demanda: o app limpa `.card-empty` do container depois de montar.
  function avisar(mensagem) {
    if (!mensagem) {
      aviso?.remove();
      aviso = null;
      return;
    }
    if (!aviso || !el.contains?.(aviso)) {
      aviso = document.createElement('p');
      aviso.className = 'card-empty';
      el.appendChild(aviso);
    }
    aviso.textContent = mensagem;
  }

  function corDe(candidato) {
    return candidato?.color || CANDIDATE_COLORS[candidato?.n] || DEFAULT_COLOR;
  }

  function variacao(candidato) {
    const antes = anterior.get(String(candidato.n));
    if (!Number.isFinite(antes)) return null;
    const delta = (Number(candidato.votes) || 0) - antes;
    return delta === 0 ? null : delta;
  }

  function criarLinha(candidato, posicao) {
    const n = String(candidato.n ?? '');
    const nome = candidato.nmu || candidato.nm || n || '—';
    const partido = candidato.party ? String(candidato.party) : '';
    const votos = Number(candidato.votes) || 0;
    const pctBruto = Math.max(0, Number(candidato.pct) || 0);
    const pct = Math.min(100, pctBruto); // a barra satura em 100, o rótulo mostra o valor real
    const cor = corDe(candidato);
    const delta = variacao(candidato);
    const primeiro = posicao === 0;
    const segundo = posicao === 1;

    const item = document.createElement('div');
    item.setAttribute('role', 'listitem');

    const linha = document.createElement('button');
    linha.type = 'button';
    linha.className = 'bar-row';
    linha.dataset.candidate = n;
    linha.setAttribute('aria-pressed', String(selecionado === n));
    linha.style.display = 'grid';
    linha.style.gap = '0';
    linha.style.width = '100%';
    linha.style.padding = '7px 8px';
    linha.style.border = `1px solid ${primeiro ? cor : 'transparent'}`;
    linha.style.borderRadius = '9px';
    linha.style.background = primeiro ? 'color-mix(in srgb, var(--bg-elev-2) 78%, transparent)' : 'transparent';
    linha.style.textAlign = 'left';
    linha.style.cursor = 'pointer';

    const cabeca = document.createElement('span');
    cabeca.className = 'bar-head';

    const blocoNome = document.createElement('span');
    blocoNome.className = 'bar-name';

    const swatch = document.createElement('span');
    swatch.className = 'bar-swatch';
    swatch.style.background = cor;
    swatch.setAttribute('aria-hidden', 'true');

    const rotulo = document.createElement('span');
    rotulo.textContent = nome;

    const numero = document.createElement('span');
    numero.className = 'bar-party';
    numero.textContent = partido ? `${partido} · ${n}` : n;
    numero.style.fontFamily = 'var(--mono)';

    blocoNome.append(swatch, rotulo, numero);

    if (primeiro || segundo) {
      const medalha = document.createElement('span');
      medalha.textContent = primeiro ? '1º' : '2º';
      medalha.style.font = '700 0.62rem/1 var(--mono)';
      medalha.style.padding = '2px 5px';
      medalha.style.borderRadius = '999px';
      medalha.style.background = 'color-mix(in srgb, var(--bg-elev-2) 70%, transparent)';
      medalha.style.border = `1px solid ${cor}`;
      medalha.style.color = 'var(--text-dim)';
      medalha.setAttribute('aria-label', primeiro ? 'primeiro lugar' : 'segundo lugar');
      blocoNome.appendChild(medalha);
    }

    const numeros = document.createElement('span');
    numeros.className = 'bar-nums';

    const pctEl = document.createElement('span');
    pctEl.className = 'bar-pct';
    pctEl.textContent = fmtPct(pctBruto, 1);

    const votosEl = document.createElement('span');
    votosEl.className = 'bar-votes';
    votosEl.textContent = fmtCompact(votos);
    votosEl.title = `${fmtInt(votos)} votos`;

    numeros.append(pctEl, votosEl);

    if (delta != null) {
      const variacaoEl = document.createElement('span');
      const subiu = delta > 0;
      variacaoEl.className = 'bar-delta';
      variacaoEl.textContent = `${subiu ? '▲' : '▼'} ${fmtCompact(Math.abs(delta))}`;
      variacaoEl.style.font = '600 0.7rem/1 var(--mono)';
      variacaoEl.style.marginLeft = '5px';
      variacaoEl.style.color = subiu ? 'var(--accent)' : 'var(--danger)';
      variacaoEl.title = `${subiu ? 'subiu' : 'caiu'} ${fmtInt(Math.abs(delta))} votos desde a atualização anterior`;
      numeros.appendChild(variacaoEl);
    }

    cabeca.append(blocoNome, numeros);

    const trilha = document.createElement('span');
    trilha.className = 'bar-track';

    const preenchimento = document.createElement('span');
    preenchimento.className = 'bar-fill';
    preenchimento.style.display = 'block';
    preenchimento.style.width = `${pct}%`;
    preenchimento.style.background = cor;
    trilha.appendChild(preenchimento);

    linha.append(cabeca, trilha);

    const partes = [nome];
    if (partido) partes.push(partido);
    partes.push(`número ${n}`, fmtPct(pctBruto, 1), `${fmtInt(votos)} votos`);
    linha.setAttribute('aria-label', partes.join(', '));

    item.appendChild(linha);
    return item;
  }

  function render(estado) {
    const candidatos = Array.isArray(estado?.candidates) ? estado.candidates.filter(Boolean) : [];
    const ordenados = [...candidatos].sort((a, b) => {
      const diff = (Number(b.votes) || 0) - (Number(a.votes) || 0);
      return diff !== 0 ? diff : String(a.n).localeCompare(String(b.n));
    });

    const ativo = document.activeElement;
    const focoEm = ativo && lista.contains?.(ativo) ? ativo.closest?.('.bar-row')?.dataset.candidate : null;

    lista.replaceChildren();
    ordenados.forEach((candidato, indice) => {
      lista.appendChild(criarLinha(candidato, indice));
    });

    avisar(ordenados.length ? null : 'Ainda sem votos contabilizados.');

    if (focoEm) {
      lista.querySelector(`.bar-row[data-candidate="${CSS.escape(focoEm)}"]`)?.focus({ preventScroll: true });
    }

    anterior = new Map(ordenados.map((c) => [String(c.n), Number(c.votes) || 0]));
  }

  function aoClicar(evento) {
    const linha = evento.target.closest?.('.bar-row');
    if (!linha) return;
    const n = linha.dataset.candidate;
    selecionado = selecionado === n ? null : n;
    for (const outra of lista.querySelectorAll('.bar-row')) {
      outra.setAttribute('aria-pressed', String(outra.dataset.candidate === selecionado));
    }
    try { onSelectCandidate?.(n); } catch { /* handler externo */ }
  }

  lista.addEventListener('click', aoClicar);

  return {
    update(estado) {
      if (destruido || !estado || typeof estado !== 'object') return;
      if (!Array.isArray(estado.candidates)) return; // payload parcial não apaga o que já está na tela
      render(estado);
    },
    destroy() {
      destruido = true;
      lista.removeEventListener('click', aoClicar);
      el.replaceChildren();
      anterior = new Map();
      aviso = null;
    },
  };
}

/*
Exemplo de uso:

import { createBars } from './components/bars.js';

const barras = createBars(document.querySelector('#bars'), {
  onSelectCandidate: (n) => console.log('candidato filtrado:', n),
});

barras.update(estadoRecebido); // { candidates: [{ n, nmu, party, color, votes, pct }] }

// ao desmontar:
barras.destroy();
*/
