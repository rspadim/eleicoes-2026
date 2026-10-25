// Tabela compacta e ordenável de UFs (apurado %, líder, margem) com barra por linha.
// Em telas estreitas a tabela é substituída por uma lista de botões (sem tabela).
// Ordenação por clique no cabeçalho, com aria-sort; clique/Enter na linha abre o detalhe.

import { CANDIDATE_COLORS, DEFAULT_COLOR, UF_NAMES } from '../../shared/config.js';
import { fmtInt, fmtPct } from '../lib/format.js';

const COLUNAS = [
  { chave: 'uf', titulo: 'UF' },
  { chave: 'pct', titulo: 'Apurado' },
  { chave: 'leader', titulo: 'Líder' },
  { chave: 'margin', titulo: 'Margem' },
];

function corDoCandidato(n) {
  return CANDIDATE_COLORS[n] ?? DEFAULT_COLOR;
}

function liderDe(ufDados) {
  const n = ufDados?.leader;
  if (!n) return null;
  return (ufDados?.candidates ?? []).find((c) => c && String(c.n) === String(n)) ?? null;
}

/** Margem em pontos percentuais entre 1º e 2º. */
function margemDe(ufDados) {
  const candidatos = (ufDados?.candidates ?? [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));
  if (candidatos.length < 2) return null;
  const primeiro = Number(candidatos[0].pct) || 0;
  const segundo = Number(candidatos[1].pct) || 0;
  if (!primeiro && !segundo && !Number(ufDados?.pct)) return null;
  return Math.max(0, primeiro - segundo);
}

function linhasDe(estado) {
  const ufs = estado?.ufs;
  if (!ufs || typeof ufs !== 'object') return [];
  return Object.entries(ufs).map(([uf, dados]) => {
    const lider = liderDe(dados);
    const votos = typeof dados?.votes === 'number'
      ? dados.votes
      : Object.values(dados?.votes ?? {}).reduce((soma, v) => soma + (Number(v) || 0), 0);
    return {
      uf,
      nome: dados?.name || UF_NAMES[uf] || uf.toUpperCase(),
      pct: Math.max(0, Math.min(100, Number(dados?.pct) || 0)),
      lider,
      nomeLider: lider?.nmu || lider?.n || '—',
      cor: lider ? (lider.color || corDoCandidato(lider.n)) : DEFAULT_COLOR,
      margem: margemDe(dados),
      votos,
    };
  });
}

function ordenar(linhas, chave, direcao) {
  const fator = direcao === 'asc' ? 1 : -1;
  return [...linhas].sort((a, b) => {
    let cmp = 0;
    if (chave === 'uf') cmp = a.uf.localeCompare(b.uf);
    else if (chave === 'leader') cmp = a.nomeLider.localeCompare(b.nomeLider, 'pt-BR');
    else if (chave === 'margin') cmp = (a.margem ?? -1) - (b.margem ?? -1);
    else cmp = a.pct - b.pct;
    return cmp !== 0 ? cmp * fator : a.uf.localeCompare(b.uf);
  });
}

export function createStateTable(el, { onSelect } = {}) {
  if (!el) throw new TypeError('createStateTable: elemento obrigatório');
  el.replaceChildren();

  const consulta = window.matchMedia('(max-width: 640px)');

  let estado = null;
  let conteudo = null;
  let chave = 'pct';
  let direcao = 'desc';
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

  function abrir(uf) {
    try { onSelect?.(uf); } catch { /* handler externo */ }
  }

  // A linha continua sendo <tr> (preserva a semântica de tabela) mas é focável.
  function ligarLinha(tr, uf, rotulo) {
    tr.tabIndex = 0;
    tr.dataset.uf = uf;
    const nome = UF_NAMES[uf] ?? uf.toUpperCase();
    tr.setAttribute('aria-label', `Abrir detalhe de ${nome}${rotulo ? ` — ${rotulo}` : ''}`);
    tr.addEventListener('click', () => abrir(uf));
    tr.addEventListener('keydown', (evento) => {
      if (evento.key === 'Enter' || evento.key === ' ') {
        evento.preventDefault();
        abrir(uf);
      }
    });
  }

  function barraDaLinha(pct, cor) {
    const trilha = document.createElement('div');
    trilha.className = 'bar-track';
    trilha.style.height = '6px';
    trilha.style.marginTop = '4px';
    const preenchimento = document.createElement('div');
    preenchimento.className = 'bar-fill';
    preenchimento.style.width = `${pct}%`;
    preenchimento.style.background = cor;
    trilha.appendChild(preenchimento);
    return trilha;
  }

  function montarTabela(linhas) {
    const caixa = document.createElement('div');
    caixa.className = 'table-wrap';

    const tabela = document.createElement('table');
    tabela.className = 'states-table';

    const legenda = document.createElement('caption');
    legenda.className = 'sr-only';
    legenda.textContent = 'Apuração por estado, com colunas ordenáveis';
    tabela.appendChild(legenda);

    const thead = document.createElement('thead');
    const trCabecalho = document.createElement('tr');

    for (const coluna of COLUNAS) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (chave === coluna.chave) th.setAttribute('aria-sort', direcao === 'asc' ? 'ascending' : 'descending');

      const botao = document.createElement('button');
      botao.type = 'button';
      botao.dataset.coluna = coluna.chave;
      botao.textContent = coluna.titulo;
      if (chave === coluna.chave) {
        const seta = document.createElement('span');
        seta.setAttribute('aria-hidden', 'true');
        seta.textContent = direcao === 'asc' ? '▲' : '▼';
        botao.appendChild(seta);
      }
      botao.addEventListener('click', () => {
        if (chave === coluna.chave) direcao = direcao === 'asc' ? 'desc' : 'asc';
        else {
          chave = coluna.chave;
          direcao = coluna.chave === 'uf' || coluna.chave === 'leader' ? 'asc' : 'desc';
        }
        render();
      });

      th.appendChild(botao);
      trCabecalho.appendChild(th);
    }

    thead.appendChild(trCabecalho);
    tabela.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const linha of linhas) {
      const tr = document.createElement('tr');
      ligarLinha(tr, linha.uf, linha.lider ? `líder ${linha.nomeLider}, ${fmtPct(linha.pct, 1)} apurado` : `sem apuração, ${fmtPct(linha.pct, 1)} apurado`);

      const tdUf = document.createElement('td');
      const sigla = document.createElement('span');
      sigla.className = 'uf';
      sigla.textContent = linha.uf.toUpperCase();
      const nome = document.createElement('span');
      nome.className = 'uf-name';
      nome.textContent = linha.nome;
      tdUf.append(sigla, document.createElement('br'), nome);

      const tdPct = document.createElement('td');
      tdPct.className = 'num';
      const pctTexto = document.createElement('span');
      pctTexto.textContent = fmtPct(linha.pct, 1);
      if (linha.pct < 100) pctTexto.className = 'pct-low';
      const barra = barraDaLinha(linha.pct, linha.cor);
      barra.setAttribute('role', 'presentation');
      tdPct.append(pctTexto, barra);

      const tdLider = document.createElement('td');
      const liderBox = document.createElement('span');
      liderBox.className = 'leader';
      const swatch = document.createElement('span');
      swatch.className = 'leader-swatch';
      swatch.style.background = linha.cor;
      swatch.setAttribute('aria-hidden', 'true');
      const nomeLider = document.createElement('span');
      nomeLider.textContent = linha.lider ? linha.nomeLider : '—';
      if (linha.lider) {
        liderBox.append(swatch, nomeLider);
      } else {
        nomeLider.className = 'pct-low';
        liderBox.appendChild(nomeLider);
      }
      tdLider.appendChild(liderBox);

      const tdMargem = document.createElement('td');
      tdMargem.className = 'num';
      tdMargem.textContent = linha.margem == null ? '—' : `${fmtPct(linha.margem, 1)} p.p.`;
      tdMargem.title = linha.margem == null ? 'sem margem calculada' : `${fmtInt(linha.votos)} votos apurados no estado`;

      tr.append(tdUf, tdPct, tdLider, tdMargem);
      tbody.appendChild(tr);
    }

    tabela.appendChild(tbody);
    caixa.appendChild(tabela);
    return caixa;
  }

  function montarLista(linhas) {
    const bloco = document.createElement('div');
    bloco.style.display = 'grid';
    bloco.style.gap = '8px';

    // no mobile não há cabeçalho de tabela: a ordenação vira um controle explícito
    const barra = document.createElement('div');
    barra.style.display = 'flex';
    barra.style.alignItems = 'center';
    barra.style.gap = '6px';
    barra.style.fontSize = '0.72rem';
    barra.style.color = 'var(--text-faint)';

    const rotulo = document.createElement('label');
    rotulo.textContent = 'Ordenar por';
    rotulo.htmlFor = 'states-sort';

    const seletor = document.createElement('select');
    seletor.className = 'select';
    seletor.id = 'states-sort';
    seletor.setAttribute('aria-label', 'Ordenar estados por');
    for (const coluna of COLUNAS) {
      const opcao = document.createElement('option');
      opcao.value = coluna.chave;
      opcao.textContent = coluna.titulo;
      seletor.appendChild(opcao);
    }
    seletor.value = chave;
    seletor.addEventListener('change', () => {
      chave = seletor.value;
      direcao = chave === 'uf' || chave === 'leader' ? 'asc' : 'desc';
      render();
    });

    const inverter = document.createElement('button');
    inverter.type = 'button';
    inverter.className = 'btn btn-ghost btn-sm';
    inverter.textContent = direcao === 'asc' ? '▲ Crescente' : '▼ Decrescente';
    inverter.setAttribute('aria-label', `Ordem ${direcao === 'asc' ? 'crescente' : 'decrescente'}, clique para inverter`);
    inverter.addEventListener('click', () => {
      direcao = direcao === 'asc' ? 'desc' : 'asc';
      render();
    });

    barra.append(rotulo, seletor, inverter);
    bloco.appendChild(barra);

    const lista = document.createElement('ul');
    lista.className = 'states-list';
    lista.style.listStyle = 'none';
    lista.style.display = 'grid';
    lista.style.gap = '6px';
    lista.style.margin = '0';
    lista.style.padding = '0';

    for (const linha of linhas) {
      const item = document.createElement('li');
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.dataset.uf = linha.uf;
      botao.style.display = 'grid';
      botao.style.gap = '4px';
      botao.style.width = '100%';
      botao.style.padding = '8px 10px';
      botao.style.textAlign = 'left';
      botao.style.border = `1px solid ${linha.lider ? linha.cor : 'var(--border)'}`;
      botao.style.borderRadius = '9px';
      botao.style.background = 'var(--bg-elev-2)';
      botao.style.cursor = 'pointer';
      botao.setAttribute('aria-label', `${linha.nome}: ${linha.lider ? `lidera ${linha.nomeLider} com ${fmtPct(linha.lider.pct ?? 0, 1)}` : 'sem apuração'}, ${fmtPct(linha.pct, 1)} apurado`);

      const topo = document.createElement('span');
      topo.style.display = 'flex';
      topo.style.justifyContent = 'space-between';
      topo.style.gap = '8px';

      const sigla = document.createElement('strong');
      sigla.textContent = `${linha.uf.toUpperCase()} · ${linha.nome}`;
      sigla.style.fontSize = '0.8rem';

      const pct = document.createElement('span');
      pct.textContent = fmtPct(linha.pct, 1);
      pct.style.font = '600 0.78rem/1 var(--mono)';
      pct.style.color = 'var(--text-dim)';

      topo.append(sigla, pct);

      const trilha = document.createElement('span');
      trilha.className = 'bar-track';
      trilha.style.height = '6px';
      trilha.style.marginTop = '0';
      const preenchimento = document.createElement('span');
      preenchimento.className = 'bar-fill';
      preenchimento.style.display = 'block';
      preenchimento.style.width = `${linha.pct}%`;
      preenchimento.style.background = linha.cor;
      trilha.appendChild(preenchimento);

      const lider = document.createElement('span');
      lider.style.fontSize = '0.7rem';
      lider.style.color = 'var(--text-faint)';
      lider.textContent = linha.lider
        ? `Líder: ${linha.nomeLider}${linha.margem == null ? '' : ` · margem ${fmtPct(linha.margem, 1)} p.p.`}`
        : 'Sem apuração';

      botao.append(topo, trilha, lider);
      botao.addEventListener('click', () => abrir(linha.uf));
      item.appendChild(botao);
      lista.appendChild(item);
    }

    bloco.appendChild(lista);
    return bloco;
  }

  function render() {
    if (destruido) return;
    const linhas = ordenar(linhasDe(estado), chave, direcao);
    const foco = document.activeElement;
    const chaveFoco = foco && el.contains(foco)
      ? (foco.dataset?.coluna ?? foco.dataset?.uf ?? foco.getAttribute?.('aria-label'))
      : null;

    const novo = document.createElement('div');
    if (linhas.length) {
      novo.appendChild(consulta.matches ? montarLista(linhas) : montarTabela(linhas));
    }
    if (conteudo?.parentNode === el) conteudo.replaceWith(novo);
    else el.appendChild(novo);
    conteudo = novo;

    avisar(linhas.length ? null : (estado ? 'Nenhum estado com apuração iniciada.' : 'Aguardando dados por estado…'));

    if (chaveFoco) {
      const alvo = el.querySelector(`[data-coluna="${CSS.escape(chaveFoco)}"]`)
        ?? el.querySelector(`[data-uf="${CSS.escape(chaveFoco)}"]`);
      alvo?.focus({ preventScroll: true });
    }
  }

  function aoMudarTela() {
    render();
  }
  consulta.addEventListener('change', aoMudarTela);

  return {
    update(novo) {
      if (destruido || !novo || typeof novo !== 'object') return;
      estado = novo;
      render();
    },
    destroy() {
      destruido = true;
      consulta.removeEventListener('change', aoMudarTela);
      el.replaceChildren();
      estado = null;
      conteudo = null;
      aviso = null;
    },
  };
}

/*
Exemplo de uso:

import { createStateTable } from './components/states.js';

const tabela = createStateTable(document.querySelector('#states'), {
  onSelect: (uf) => console.log('abrir detalhe:', uf),
});

tabela.update(estadoRecebido); // { ufs: { sp: { name, pct, leader, candidates, votes } } }

// ao desmontar:
tabela.destroy();
*/
