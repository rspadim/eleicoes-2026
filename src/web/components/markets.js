// Mercados de previsão (Polymarket / Kalshi) com consenso entre fontes.
// Probabilidade implícita — não é pesquisa. Cada linha mostra probabilidade, variação,
// volume e barra fina; o topo agrega a média das duas fontes por candidato.
// As fontes entregam prob como fração (0..1); valores > 1 são tratados como já em %.

import { CANDIDATE_COLORS, DEFAULT_COLOR } from '../../shared/config.js';
import { fmtCompact, fmtPct } from '../lib/format.js';

const FONTES = [
  { chave: 'polymarket', titulo: 'Polymarket', rotulo: 'só Poly' },
  { chave: 'kalshi', titulo: 'Kalshi', rotulo: 'só Kalshi' },
];

const ORDEM = ['13', '22'];

function normalizarNome(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function chaveDe(item) {
  if (item?.candidateNumber != null && String(item.candidateNumber) !== '') {
    return `n:${String(item.candidateNumber)}`;
  }
  return `e:${normalizarNome(item?.entity)}`;
}

function num(valor) {
  const n = typeof valor === 'string' ? Number(valor.replace(',', '.')) : Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** Converte fração 0..1 (ou percentual já pronto) em percentual 0..100. */
function emPercentual(valor) {
  const n = num(valor);
  if (n == null) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}

function limparNome(valor) {
  return String(valor ?? '').trim() || '—';
}

function corDe(candidatoNumber, entidade) {
  const porNumero = CANDIDATE_COLORS[String(candidatoNumber ?? '')];
  if (porNumero) return porNumero;
  const texto = normalizarNome(entidade);
  if (/lula|inacio/.test(texto)) return CANDIDATE_COLORS['13'] ?? DEFAULT_COLOR;
  if (/flavio|bolsonaro/.test(texto)) return CANDIDATE_COLORS['22'] ?? DEFAULT_COLOR;
  return DEFAULT_COLOR;
}

/**
 * Média das fontes disponíveis, ignorando leituras zeradas.
 * Contrato já resolvido/encerrado costuma vir como 0 e não é opinião de preço:
 * se alguma fonte tem preço positivo, ela sozinha define o consenso.
 */
function consenso(itens) {
  const comValor = itens.filter((i) => i.prob != null);
  const positivos = comValor.filter((i) => i.prob > 0);
  const validos = positivos.length ? positivos : comValor;
  if (!validos.length) return { prob: null, fontes: [] };
  const soma = validos.reduce((acc, i) => acc + i.prob, 0);
  return { prob: soma / validos.length, fontes: validos.map((i) => i.fonte) };
}

export function createMarkets(el) {
  if (!el) throw new TypeError('createMarkets: elemento obrigatório');
  el.replaceChildren();

  let anterior = new Map();
  let destruido = false;
  let mostrarZerados = lerPreferencia();

  const raiz = document.createElement('div');
  raiz.className = 'markets';

  // Filtro persistente: por padrão esconde contratos já resolvidos (0%).
  const filtro = document.createElement('div');
  filtro.className = 'market-filter';
  const filtroLabel = document.createElement('label');
  filtroLabel.className = 'market-filter-label';
  const filtroInput = document.createElement('input');
  filtroInput.type = 'checkbox';
  filtroInput.id = 'mk-hide-zero';
  filtroInput.checked = !mostrarZerados;
  const filtroTexto = document.createElement('span');
  filtroTexto.textContent = 'Ocultar contratos abaixo de 0,5%';
  filtroLabel.append(filtroInput, filtroTexto);
  filtro.appendChild(filtroLabel);

  const nota = document.createElement('p');
  nota.className = 'market-foot';
  nota.textContent = 'Probabilidade implícita, não é pesquisa. O consenso é a média entre as fontes disponíveis.';

  el.append(filtro, raiz, nota);

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
      el.insertBefore(aviso, nota);
    }
    aviso.textContent = mensagem;
  }

  function aoFiltrar() {
    mostrarZerados = !filtroInput.checked;
    salvarPreferencia(mostrarZerados);
    render(ultimoPayload ?? {});
  }
  filtroInput.addEventListener('change', aoFiltrar);

  function barraFina(prob) {
    const trilha = document.createElement('span');
    trilha.className = 'bar-track';
    trilha.style.height = '4px';
    trilha.style.marginTop = '3px';
    trilha.style.border = '0';
    trilha.style.display = 'block';
    const preenchimento = document.createElement('span');
    preenchimento.className = 'bar-fill';
    preenchimento.style.display = 'block';
    preenchimento.style.width = `${Math.max(0, Math.min(100, prob ?? 0))}%`;
    preenchimento.style.background = 'currentColor';
    trilha.appendChild(preenchimento);
    return trilha;
  }

  function deltaEl(prob, chave) {
    const antes = anterior.get(chave);
    if (antes == null) return null;
    const delta = prob - antes;
    if (Math.abs(delta) < 0.05) return null;
    const subiu = delta > 0;
    const tag = document.createElement('span');
    tag.className = subiu ? 'market-up' : 'market-down';
    tag.style.font = '600 0.7rem/1 var(--mono)';
    tag.style.marginLeft = '5px';
    tag.textContent = `${subiu ? '▲' : '▼'} ${fmtPct(Math.abs(delta), 1)}`;
    tag.title = `${subiu ? 'subiu' : 'caiu'} ${fmtPct(Math.abs(delta), 1)} desde a leitura anterior`;
    return tag;
  }

  function linhaBase(grupo) {
    const item = document.createElement('div');
    item.className = 'market-row';
    item.setAttribute('role', 'listitem');
    item.style.color = grupo.cor;

    const esquerda = document.createElement('div');
    esquerda.style.minWidth = '0';

    const entidade = document.createElement('div');
    entidade.className = 'market-entity';
    const swatch = document.createElement('span');
    swatch.className = 'bar-swatch';
    swatch.style.background = grupo.cor;
    swatch.setAttribute('aria-hidden', 'true');
    const nome = document.createElement('span');
    nome.textContent = grupo.nome;
    entidade.append(swatch, nome);

    const direita = document.createElement('div');
    direita.style.textAlign = 'right';

    item.append(esquerda, direita);
    return { item, esquerda, entidade, nome, direita };
  }

  function montarResumo(grupos) {
    const secao = document.createElement('section');
    secao.className = 'market-consensus';

    const titulo = document.createElement('h3');
    titulo.className = 'market-group-head';
    titulo.textContent = 'Consenso do mercado';
    secao.appendChild(titulo);

    const legenda = document.createElement('p');
    legenda.className = 'market-meta';
    legenda.style.marginBottom = '6px';
    legenda.textContent = 'Média das duas fontes quando ambas listam o candidato.';
    secao.appendChild(legenda);

    const comDados = grupos
      .map((grupo) => {
        const itens = Object.entries(grupo.itens).map(([fonte, dados]) => ({ prob: dados.prob, fonte }));
        return { grupo, ...consenso(itens) };
      })
      .filter((linha) => linha.prob != null)
      .sort((a, b) => b.prob - a.prob || ordemDe(a.grupo) - ordemDe(b.grupo));

    if (!comDados.length) {
      const vazio = document.createElement('p');
      vazio.className = 'card-empty';
      vazio.textContent = 'Sem probabilidade divulgada pelas fontes.';
      secao.appendChild(vazio);
      return secao;
    }

    const lista = document.createElement('div');
    lista.setAttribute('role', 'list');
    lista.setAttribute('aria-label', 'Consenso do mercado por candidato');

    for (const linha of comDados) {
      const base = linhaBase(linha.grupo);

      const meta = document.createElement('div');
      meta.className = 'market-meta';
      const soUma = linha.fontes.length === 1;
      const rotuloFonte = FONTES.find((f) => f.chave === linha.fontes[0])?.rotulo ?? 'uma fonte';
      meta.textContent = soUma ? `(${rotuloFonte})` : 'média Poly + Kalshi';

      base.esquerda.append(base.entidade, meta, barraFina(linha.prob));

      const prob = document.createElement('div');
      prob.className = 'market-prob';
      prob.style.color = 'var(--text)';
      prob.textContent = fmtPct(linha.prob, 1);
      const delta = deltaEl(linha.prob, linha.grupo.chave);
      if (delta) prob.appendChild(delta);
      base.direita.appendChild(prob);

      base.item.setAttribute(
        'aria-label',
        `${linha.grupo.nome}: ${fmtPct(linha.prob, 1)} de probabilidade implícita pelo consenso, ${linha.fontes.length} fonte(s)`,
      );
      lista.appendChild(base.item);
    }

    secao.appendChild(lista);
    return secao;
  }

  function montarFonte(fonte, grupos) {
    const secao = document.createElement('section');
    secao.className = 'market-group';

    const cabecalho = document.createElement('h3');
    cabecalho.className = 'market-group-head';
    const nomeFonte = document.createElement('span');
    nomeFonte.textContent = fonte.titulo;
    const contagem = document.createElement('span');
    const comFonte = grupos.filter((g) => g.itens[fonte.chave]?.prob != null);
    contagem.textContent = `${comFonte.length} contrato${comFonte.length === 1 ? '' : 's'}`;
    cabecalho.append(nomeFonte, contagem);
    secao.appendChild(cabecalho);

    if (!comFonte.length) {
      const vazio = document.createElement('p');
      vazio.className = 'market-meta';
      vazio.textContent = 'Sem contratos divulgados agora.';
      secao.appendChild(vazio);
      return secao;
    }

    const lista = document.createElement('div');
    lista.setAttribute('role', 'list');
    lista.setAttribute('aria-label', `Probabilidades no ${fonte.titulo}`);

    for (const grupo of comFonte.sort((a, b) => {
      return (b.itens[fonte.chave].prob ?? 0) - (a.itens[fonte.chave].prob ?? 0) || ordemDe(a) - ordemDe(b);
    })) {
      const dados = grupo.itens[fonte.chave];
      const base = linhaBase(grupo);

      const meta = document.createElement('div');
      meta.className = 'market-meta';
      meta.textContent = `Volume ${fmtCompact(dados.volume)}`;
      base.esquerda.append(base.entidade, meta, barraFina(dados.prob));

      const prob = document.createElement('div');
      prob.className = 'market-prob';
      prob.style.color = 'var(--text)';
      prob.textContent = fmtPct(dados.prob, 1);
      const delta = deltaEl(dados.prob, `${fonte.chave}|${grupo.chave}`);
      if (delta) prob.appendChild(delta);
      base.direita.appendChild(prob);

      base.item.setAttribute(
        'aria-label',
        `${grupo.nome} no ${fonte.titulo}: ${fmtPct(dados.prob, 1)}, volume ${fmtCompact(dados.volume)}`,
      );
      lista.appendChild(base.item);
    }

    secao.appendChild(lista);
    return secao;
  }

  /**
   * Junta as fontes por candidato: [{ chave, nome, numero, cor, itens: { poly, kalshi } }]
   */
  function agrupar(markets) {
    const mapa = new Map();
    for (const fonte of FONTES) {
      const lista = Array.isArray(markets?.[fonte.chave]) ? markets[fonte.chave] : [];
      for (const item of lista) {
        if (!item || typeof item !== 'object') continue;
        const prob = emPercentual(item.prob);
        if (prob == null) continue;
        const chave = chaveDe(item);
        if (chave === 'e:') continue;
        if (!mapa.has(chave)) {
          mapa.set(chave, {
            chave,
            nome: limparNome(item.entity),
            numero: item.candidateNumber == null ? null : String(item.candidateNumber),
            itens: {},
          });
        }
        const atual = mapa.get(chave);
        if (!atual.numero && item.candidateNumber != null) atual.numero = String(item.candidateNumber);
        if (atual.nome === '—' && item.entity) atual.nome = limparNome(item.entity);
        atual.itens[fonte.chave] = { prob, volume: num(item.volume) ?? 0 };
      }
    }
    return [...mapa.values()].map((grupo) => ({ ...grupo, cor: corDe(grupo.numero, grupo.nome) }));
  }

  function ordemDe(grupo) {
    const indice = ORDEM.indexOf(String(grupo.numero ?? ''));
    return indice === -1 ? 99 : indice;
  }

  function ocultarZerado(grupo) {
    if (mostrarZerados) return false;
    const probs = Object.values(grupo.itens).map((i) => i.prob).filter((p) => p != null);
    // Contratos resolvidos em 0% (ou abaixo do ruído de 0,5%) só poluem a lista.
    return !probs.length || probs.every((p) => p < 0.5);
  }

  let ultimoPayload = null;

  function render(markets) {
    const grupos = agrupar(markets);
    const ativos = grupos.filter((g) => Object.keys(g.itens).length > 0);
    const validos = ativos.filter((g) => !ocultarZerado(g));
    const ocultos = ativos.length - validos.length;

    raiz.replaceChildren();

    if (!validos.length) {
      avisar(ativos.length
        ? 'Todos os contratos estão abaixo de 0,5% (encerrados). Desmarque o filtro para vê-los.'
        : (markets ? 'Nenhum contrato disponível no momento.' : 'Aguardando mercados…'));
      return;
    }
    avisar(null);

    // Consenso no topo, depois cada fonte.
    raiz.appendChild(montarResumo(validos));

    for (const fonte of FONTES) raiz.appendChild(montarFonte(fonte, validos));

    const proximo = new Map();
    for (const grupo of validos) {
      for (const [chaveFonte, dados] of Object.entries(grupo.itens)) {
        proximo.set(`${chaveFonte}|${grupo.chave}`, dados.prob);
      }
      const media = consenso(Object.entries(grupo.itens).map(([fonte, dados]) => ({ prob: dados.prob, fonte })));
      if (media.prob != null) proximo.set(grupo.chave, media.prob);
    }
    anterior = proximo;

    if (ocultos > 0) {
      const rodape = document.createElement('p');
      rodape.className = 'market-meta market-hidden-count';
      rodape.textContent = `${ocultos} contrato${ocultos === 1 ? '' : 's'} abaixo de 0,5% oculto${ocultos === 1 ? '' : 's'}`;
      raiz.appendChild(rodape);
    }
  }

  return {
    update(markets) {
      if (destruido || !markets || typeof markets !== 'object') return;
      ultimoPayload = markets;
      render(markets);
    },
    destroy() {
      destruido = true;
      filtroInput.removeEventListener('change', aoFiltrar);
      el.replaceChildren();
      anterior = new Map();
      ultimoPayload = null;
      aviso = null;
    },
  };
}

function lerPreferencia() {
  try {
    return localStorage.getItem('mercados:mostrarZerados') === '1';
  } catch {
    return false;
  }
}

function salvarPreferencia(valor) {
  try {
    localStorage.setItem('mercados:mostrarZerados', valor ? '1' : '0');
  } catch { /* armazenamento indisponível */ }
}

/*
Exemplo de uso:

import { createMarkets } from './components/markets.js';

const mercados = createMarkets(document.querySelector('#markets'));

mercados.update({
  polymarket: [{ entity: 'Lula', prob: 0.57, volume: 1_250_000, candidateNumber: '13' }],
  kalshi: [{ entity: 'Flávio Bolsonaro', prob: 0.43, volume: 320_000, candidateNumber: '22' }],
});

// ao desmontar:
mercados.destroy();
*/
