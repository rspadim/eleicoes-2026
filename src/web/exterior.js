// UI do voto no exterior: mapa-múndi com bolhas, comparativo com o Brasil,
// ranking e tabelas. Consome /api/exterior (e WS /ws type 'exterior').
//
// i18n: catálogo local pt-BR/en/es; integra ./lib/i18n.js (se existir) apenas
// para persistir/trocar o locale global. Texto pt-BR já vem no HTML.
import { fmtInt, fmtPct, fmtClock, escapeHtml } from './lib/format.js';

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  status: $('#ext-status'),
  statusText: $('#ext-status-text'),
  clock: $('#ext-clock'),
  lang: $('#ext-lang'),
  theme: $('#ext-theme'),
  banner: $('#ext-banner'),
  bannerText: $('#ext-banner-text'),
  retry: $('#ext-retry'),
  limitation: $('#ext-limitation'),
  partial: $('#ext-partial'),
  votes: $('#ext-votes'),
  pct: $('#ext-pct'),
  pctSub: $('#ext-pct-sub'),
  posts: $('#ext-posts'),
  updated: $('#ext-updated'),
  compare: $('#ext-compare-body'),
  compareFoot: $('#ext-compare-foot'),
  map: $('#ext-map'),
  mapCountries: $('#ext-map-countries'),
  mapBubbles: $('#ext-map-bubbles'),
  tip: $('#ext-tip'),
  legend: $('#ext-legend'),
  ranking: $('#ext-ranking'),
  tableBody: $('#ext-table-body'),
  postsBody: $('#ext-posts-body'),
};

const POLL_MS = 60_000;
const store = { state: null, selected: null, countries: null, socket: null, retryTimer: null, status: null };
let i18n = null;
let lang = 'pt-BR';
let theme = null;

/* ------------------------------------------------------------------- i18n */

// Catálogo local: as chaves ext.* não existem nos catálogos globais. Chaves
// compartilhadas também são duplicadas para a página não depender deles.
const TEXT = {
  'pt-BR': {
    'ext.title': 'Voto no exterior',
    'ext.back': 'Voltar ao mapa do Brasil',
    'ext.limitation': 'O TSE publica votos por posto consular, não por país. Os países são agregados localmente e o detalhamento pode ficar incompleto.',
    'ext.kpi_votes': 'Votos no exterior',
    'ext.kpi_votes_sub': 'votos válidos apurados',
    'ext.kpi_pct': '% apurado exterior',
    'ext.kpi_posts': 'Postos consulares',
    'ext.kpi_posts_sub': 'com seção apurada',
    'ext.kpi_updated': 'Última atualização',
    'ext.kpi_no_sections': 'seções ainda não iniciadas',
    'ext.compare_title': 'Exterior × Brasil',
    'ext.compare_hint': 'Comparação direta entre o comparecimento no exterior e no Brasil.',
    'ext.cmp_turnout_ext': 'Comparecimento no exterior',
    'ext.cmp_turnout_br': 'Comparecimento no Brasil',
    'ext.cmp_share_votes': 'Votos válidos do exterior sobre o total nacional',
    'ext.cmp_share_electorate': 'Eleitorado no exterior sobre o nacional',
    'ext.cmp_delta': 'Diferença de comparecimento (Brasil − exterior)',
    'ext.map_title': 'Mapa-múndi',
    'ext.map_hint': 'Bolhas proporcionais aos votos válidos por país. Países sem dado ficam neutros.',
    'ext.legend_small': 'até 500 votos',
    'ext.legend_mid': 'até 10 mil votos',
    'ext.legend_big': 'acima de 10 mil',
    'ext.legend_none': 'sem dado',
    'ext.ranking_title': 'Ranking por país',
    'ext.ranking_hint': 'Ordenado por votos válidos no exterior.',
    'ext.table_title': 'País a país',
    'ext.table_hint': 'Seções apuradas, votos válidos e liderança.',
    'ext.posts_title': 'Postos consulares',
    'ext.posts_hint': 'Detalhe oficial do TSE por posto, base da agregação por país.',
    'ext.col_country': 'País',
    'ext.col_pct': 'Apurado',
    'ext.col_votes': 'Válidos',
    'ext.col_leader': 'Líder',
    'ext.col_post': 'Posto',
    'ext.col_sections': 'Seções',
    'ext.awaiting': 'Aguardando os primeiros dados do exterior.',
    'app.skip_link': 'Ir para os dados',
    'app.lang_aria': 'Escolher idioma da interface',
    'app.theme_toggle': 'Alternar tema claro e escuro',
    'conn.connecting': 'Conectando',
    'conn.live': 'Ao vivo',
    'conn.offline': 'Sem conexão',
    'conn.lost': 'Conexão perdida. Tentando reconectar…',
    'conn.retry': 'Tentar agora',
    'warn.partial': 'Dados parciais: a apuração ainda está em andamento. Os percentuais podem mudar a cada atualização.',
    'kpi.updated_sub': 'horário de Brasília',
    'footer.source': 'Fonte: TSE · dados oficiais',
    'footer.disclaimer': 'Apuração independente a partir dos dados públicos do TSE.',
    'noscript.body': 'Ative o JavaScript para acompanhar a apuração em tempo real, o mapa e o replay.',
  },
  en: {
    'ext.title': 'Votes from abroad',
    'ext.back': 'Back to the Brazil map',
    'ext.limitation': 'The TSE publishes votes per consular post, not per country. Countries are aggregated locally and the breakdown may be incomplete.',
    'ext.kpi_votes': 'Votes from abroad',
    'ext.kpi_votes_sub': 'valid votes counted',
    'ext.kpi_pct': '% counted abroad',
    'ext.kpi_posts': 'Consular posts',
    'ext.kpi_posts_sub': 'with counted sections',
    'ext.kpi_updated': 'Last update',
    'ext.kpi_no_sections': 'sections not started yet',
    'ext.compare_title': 'Abroad × Brazil',
    'ext.compare_hint': 'Direct comparison between turnout abroad and in Brazil.',
    'ext.cmp_turnout_ext': 'Turnout abroad',
    'ext.cmp_turnout_br': 'Turnout in Brazil',
    'ext.cmp_share_votes': 'Valid votes abroad over the national total',
    'ext.cmp_share_electorate': 'Electorate abroad over the national one',
    'ext.cmp_delta': 'Turnout gap (Brazil − abroad)',
    'ext.map_title': 'World map',
    'ext.map_hint': 'Bubbles proportional to valid votes per country. Countries without data stay neutral.',
    'ext.legend_small': 'up to 500 votes',
    'ext.legend_mid': 'up to 10k votes',
    'ext.legend_big': 'above 10k',
    'ext.legend_none': 'no data',
    'ext.ranking_title': 'Ranking by country',
    'ext.ranking_hint': 'Sorted by valid votes abroad.',
    'ext.table_title': 'Country by country',
    'ext.table_hint': 'Counted sections, valid votes and leader.',
    'ext.posts_title': 'Consular posts',
    'ext.posts_hint': 'Official TSE detail per post, basis of the country aggregation.',
    'ext.col_country': 'Country',
    'ext.col_pct': 'Counted',
    'ext.col_votes': 'Valid',
    'ext.col_leader': 'Leader',
    'ext.col_post': 'Post',
    'ext.col_sections': 'Sections',
    'ext.awaiting': 'Waiting for the first data from abroad.',
    'app.skip_link': 'Skip to the data',
    'app.lang_aria': 'Choose interface language',
    'app.theme_toggle': 'Toggle light and dark theme',
    'conn.connecting': 'Connecting',
    'conn.live': 'Live',
    'conn.offline': 'Offline',
    'conn.lost': 'Connection lost. Reconnecting…',
    'conn.retry': 'Retry now',
    'warn.partial': 'Partial data: counting is still in progress. Percentages may change with each update.',
    'kpi.updated_sub': 'Brasília time',
    'footer.source': 'Source: TSE · official data',
    'footer.disclaimer': 'Independent count from TSE public data.',
    'noscript.body': 'Enable JavaScript to follow the count in real time, the map and the replay.',
  },
  es: {
    'ext.title': 'Voto en el exterior',
    'ext.back': 'Volver al mapa de Brasil',
    'ext.limitation': 'El TSE publica votos por puesto consular, no por país. Los países se agregan localmente y el detalle puede quedar incompleto.',
    'ext.kpi_votes': 'Votos en el exterior',
    'ext.kpi_votes_sub': 'votos válidos escrutados',
    'ext.kpi_pct': '% escrutado en el exterior',
    'ext.kpi_posts': 'Puestos consulares',
    'ext.kpi_posts_sub': 'con sección escrutada',
    'ext.kpi_updated': 'Última actualización',
    'ext.kpi_no_sections': 'secciones aún no iniciadas',
    'ext.compare_title': 'Exterior × Brasil',
    'ext.compare_hint': 'Comparación directa entre la participación en el exterior y en Brasil.',
    'ext.cmp_turnout_ext': 'Participación en el exterior',
    'ext.cmp_turnout_br': 'Participación en Brasil',
    'ext.cmp_share_votes': 'Votos válidos del exterior sobre el total nacional',
    'ext.cmp_share_electorate': 'Electorado en el exterior sobre el nacional',
    'ext.cmp_delta': 'Diferencia de participación (Brasil − exterior)',
    'ext.map_title': 'Mapa mundial',
    'ext.map_hint': 'Burbujas proporcionales a los votos válidos por país. Los países sin datos quedan neutros.',
    'ext.legend_small': 'hasta 500 votos',
    'ext.legend_mid': 'hasta 10 mil votos',
    'ext.legend_big': 'más de 10 mil',
    'ext.legend_none': 'sin datos',
    'ext.ranking_title': 'Ranking por país',
    'ext.ranking_hint': 'Ordenado por votos válidos en el exterior.',
    'ext.table_title': 'País por país',
    'ext.table_hint': 'Secciones escrutadas, votos válidos y liderazgo.',
    'ext.posts_title': 'Puestos consulares',
    'ext.posts_hint': 'Detalle oficial del TSE por puesto, base de la agregación por país.',
    'ext.col_country': 'País',
    'ext.col_pct': 'Escrutado',
    'ext.col_votes': 'Válidos',
    'ext.col_leader': 'Líder',
    'ext.col_post': 'Puesto',
    'ext.col_sections': 'Secciones',
    'ext.awaiting': 'Esperando los primeros datos del exterior.',
    'app.skip_link': 'Ir a los datos',
    'app.lang_aria': 'Elegir idioma de la interfaz',
    'app.theme_toggle': 'Alternar tema claro y oscuro',
    'conn.connecting': 'Conectando',
    'conn.live': 'En vivo',
    'conn.offline': 'Sin conexión',
    'conn.lost': 'Conexión perdida. Reconectando…',
    'conn.retry': 'Reintentar ahora',
    'warn.partial': 'Datos parciales: el escrutinio sigue en curso. Los porcentajes pueden cambiar en cada actualización.',
    'kpi.updated_sub': 'hora de Brasilia',
    'footer.source': 'Fuente: TSE · datos oficiales',
    'footer.disclaimer': 'Escrutinio independiente a partir de los datos públicos del TSE.',
    'noscript.body': 'Active el JavaScript para seguir el escrutinio en tiempo real, el mapa y la repetición.',
  },
};

function lookup(key, fallback = '') {
  return TEXT[lang]?.[key] ?? TEXT['pt-BR']?.[key] ?? fallback ?? key;
}

/** Aplica o catálogo local a todos os atributos data-i18n* do documento. */
function applyStatic() {
  const nodes = document.querySelectorAll(
    '[data-i18n],[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]',
  );
  for (const el of nodes) {
    const text = el.getAttribute('data-i18n');
    const title = el.getAttribute('data-i18n-title');
    const aria = el.getAttribute('data-i18n-aria');
    if (text) el.textContent = lookup(text, el.textContent);
    if (title) el.setAttribute('title', lookup(title));
    if (aria) el.setAttribute('aria-label', lookup(aria));
  }
  document.documentElement.lang = lang;
}

/* ------------------------------------------------------------------ utils */

let displayNames = null;

function makeDisplayNames() {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' });
  } catch {
    return null;
  }
}

function countryName(iso2) {
  if (!iso2) return '—';
  try {
    return displayNames?.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

function t(key, fallback) {
  return lookup(key, fallback);
}

function setStatus(kind, text) {
  store.status = { kind, text };
  els.status.dataset.state = kind;
  els.statusText.textContent = text;
}

function applyLabels() {
  applyStatic();
  els.legend.innerHTML = [
    [3, t('ext.legend_small', 'até 500 votos')],
    [6, t('ext.legend_mid', 'até 10 mil votos')],
    [10, t('ext.legend_big', 'acima de 10 mil')],
    [0, t('ext.legend_none', 'sem dado')],
  ].map(([r, label]) => `<li><span class="dot" style="width:${r ? r * 2 + 4 : 10}px;height:${r ? r * 2 + 4 : 10}px;${r ? '' : 'opacity:.25'}"></span>${escapeHtml(label)}</li>`).join('');
  els.limitation.textContent = t('ext.limitation', els.limitation.textContent);
  if (store.status) setStatus(store.status.kind, t(statusKey(store.status.kind), store.status.text));
  if (store.state) render(store.state);
}

function statusKey(kind) {
  return kind === 'live' ? 'conn.live' : kind === 'offline' ? 'conn.offline' : 'conn.connecting';
}

/* ------------------------------------------------------------------- dados */

async function loadWorld() {
  if (store.countries) return store.countries;
  const res = await fetch('/geo/world.json', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`world.json ${res.status}`);
  const geo = await res.json();
  store.countries = geo;
  return geo;
}

function renderMapBase(geo) {
  if (!geo?.countries) return;
  const active = new Set((store.state?.countries ?? []).map((c) => c.iso2));
  const parts = [];
  for (const [iso2, country] of Object.entries(geo.countries)) {
    const cls = iso2 === 'BR' ? 'ext-br' : active.has(iso2) ? 'ext-active' : '';
    parts.push(`<path d="${country.path}" data-iso="${iso2}" class="${cls}" />`);
  }
  els.mapCountries.innerHTML = parts.join('');
  els.map.setAttribute('viewBox', `0 0 ${geo.viewBox?.[0] ?? 1000} ${geo.viewBox?.[1] ?? 708}`);
}

function bubbleRadius(votes, max) {
  if (!votes) return 0;
  const ratio = max > 0 ? votes / max : 0;
  return 3 + Math.sqrt(ratio) * 13;
}

function renderBubbles(geo) {
  const list = (store.state?.countries ?? []).filter((c) => c.validVotes > 0);
  if (!geo?.countries || !list.length) {
    els.mapBubbles.innerHTML = '';
    return;
  }
  const max = Math.max(...list.map((c) => c.validVotes));
  const parts = [];
  for (const country of list) {
    const point = geo.countries[country.iso2]?.centroid;
    if (!point) continue;
    const r = bubbleRadius(country.validVotes, max);
    const selected = country.iso2 === store.selected ? ' ext-selected' : '';
    const name = countryName(country.iso2);
    parts.push(
      `<circle cx="${point[0]}" cy="${point[1]}" r="${r.toFixed(1)}" tabindex="0" role="button"`
      + ` class="ext-bubble${selected}" data-iso="${country.iso2}"`
      + ` aria-label="${escapeHtml(`${name}: ${fmtInt(country.validVotes)}`)}">`
      + `<title>${escapeHtml(`${name}: ${fmtInt(country.validVotes)}`)}</title></circle>`,
    );
  }
  els.mapBubbles.innerHTML = parts.join('');
}

/* ----------------------------------------------------------------- render */

function candidateById(n) {
  return (store.state?.exterior?.candidates ?? []).find((c) => c.n === n) ?? null;
}

function candidateCell(n) {
  const cand = candidateById(n);
  if (!cand) return '—';
  return `<span class="ext-cand"><i style="background:${escapeHtml(cand.color)}"></i>${escapeHtml(cand.nmu || cand.nm)}</span>`;
}

function renderKpis(state) {
  const ext = state.exterior ?? {};
  els.votes.textContent = state.waiting ? '—' : fmtInt(ext.validVotes);
  els.pct.textContent = state.waiting ? '—' : fmtPct(ext.pct);
  els.pctSub.textContent = ext.totalSections
    ? `${fmtInt(ext.countedSections)} / ${fmtInt(ext.totalSections)}`
    : t('ext.kpi_no_sections', 'seções ainda não iniciadas');
  const started = (state.posts ?? []).filter((p) => p.countedSections > 0).length;
  els.posts.textContent = state.waiting ? '—' : fmtInt(started);
  els.updated.textContent = state.ts ? fmtClock(state.ts) : '—';
  els.partial.hidden = !!state.waiting || (ext.pct ?? 0) >= 100;
}

function renderComparison(state) {
  const cmp = state.comparison;
  if (!cmp) {
    els.compare.innerHTML = `<p class="ext-empty">${escapeHtml(t('ext.awaiting', 'Aguardando os primeiros dados do exterior.'))}</p>`;
    els.compareFoot.textContent = '—';
    return;
  }
  const rows = [
    {
      label: t('ext.cmp_turnout_ext', 'Comparecimento no exterior'),
      value: cmp.exteriorTurnoutPct,
      cls: '',
    },
    {
      label: t('ext.cmp_turnout_br', 'Comparecimento no Brasil'),
      value: cmp.nationalTurnoutPct,
      cls: 'ext-br',
    },
  ];
  els.compare.innerHTML = rows.map((row) => `
    <div class="ext-cmp-row">
      <div class="ext-cmp-head"><span>${escapeHtml(row.label)}</span><strong>${fmtPct(row.value, 2)}</strong></div>
      <div class="ext-cmp-bar ${row.cls}"><span style="width:${Math.min(100, row.value).toFixed(2)}%"></span></div>
    </div>`).join('');
  els.compareFoot.textContent = [
    `${t('ext.cmp_share_votes', 'Votos válidos do exterior sobre o total nacional')}: ${fmtPct(cmp.validSharePct, 3)}`,
    `${t('ext.cmp_share_electorate', 'Eleitorado no exterior sobre o nacional')}: ${fmtPct(cmp.electorateSharePct, 3)}`,
    `${t('ext.cmp_delta', 'Diferença de comparecimento (Brasil − exterior)')}: ${fmtPct(cmp.abstentionDeltaPct, 2)}`,
  ].join(' · ');
}

function renderRanking(state) {
  const list = [...(state.countries ?? [])].sort((a, b) => b.validVotes - a.validVotes).slice(0, 15);
  if (!list.length) {
    els.ranking.innerHTML = `<li class="ext-empty">${escapeHtml(t('ext.awaiting', 'Aguardando os primeiros dados do exterior.'))}</li>`;
    return;
  }
  els.ranking.innerHTML = list.map((country, index) => `
    <li><button type="button" data-iso="${country.iso2}" aria-pressed="${country.iso2 === store.selected}">
      <span class="pos">${index + 1}</span>
      <span>${escapeHtml(countryName(country.iso2))}</span>
      <span class="votes">${fmtInt(country.validVotes)}</span>
    </button></li>`).join('');
}

function renderTable(state) {
  const list = [...(state.countries ?? [])].sort((a, b) => b.validVotes - a.validVotes);
  if (!list.length) {
    els.tableBody.innerHTML = `<tr><td colspan="4" class="ext-empty">${escapeHtml(t('ext.awaiting', 'Aguardando os primeiros dados do exterior.'))}</td></tr>`;
    return;
  }
  els.tableBody.innerHTML = list.map((country) => `
    <tr data-iso="${country.iso2}" class="${country.iso2 === store.selected ? 'ext-active' : ''}">
      <td>${escapeHtml(countryName(country.iso2))}</td>
      <td class="num"><span class="ext-pct-cell"><span class="mini"><span style="width:${Math.min(100, country.pct).toFixed(1)}%"></span></span>${fmtPct(country.pct)}</span></td>
      <td class="num">${fmtInt(country.validVotes)}</td>
      <td>${candidateCell(country.leader)}</td>
    </tr>`).join('');
}

function renderPosts(state) {
  const list = [...(state.posts ?? [])].filter((p) => p.countedSections > 0 || p.valid > 0);
  if (!list.length) {
    els.postsBody.innerHTML = `<tr><td colspan="4" class="ext-empty">${escapeHtml(t('ext.awaiting', 'Aguardando os primeiros dados do exterior.'))}</td></tr>`;
    return;
  }
  els.postsBody.innerHTML = list.map((post) => `
    <tr>
      <td>${escapeHtml(post.name)} <span class="ext-hint">${escapeHtml(post.iso2)}</span></td>
      <td class="num">${fmtPct(post.pct)}</td>
      <td class="num">${fmtInt(post.countedSections)} / ${fmtInt(post.totalSections)}</td>
      <td class="num">${fmtInt(post.valid)}</td>
    </tr>`).join('');
}

function render(state) {
  store.state = state;
  renderKpis(state);
  renderComparison(state);
  renderRanking(state);
  renderTable(state);
  renderPosts(state);
  if (store.countries) {
    renderMapBase(store.countries);
    renderBubbles(store.countries);
  }
}

function select(iso2) {
  store.selected = store.selected === iso2 ? null : iso2;
  if (store.state) render(store.state);
}

/* ------------------------------------------------------------- fetch / ws */

async function load() {
  const res = await fetch('/api/exterior?limit=120', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`api ${res.status}`);
  const data = await res.json();
  if (data?.state) render(data.state);
  setStatus('live', t('conn.live', 'Ao vivo'));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch {
    schedulePoll();
    return;
  }
  store.socket = ws;
  ws.onopen = () => {
    setStatus('live', t('conn.live', 'Ao vivo'));
    els.banner.hidden = true;
    // O WS principal hoje so emite 'snapshot'/'hello'; mantém o polling como garantia.
    schedulePoll();
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg?.type === 'exterior' && msg.state) render(msg.state);
    if (msg?.type === 'snapshot' && msg.state?.scope === 'zz') render(msg.state);
  };
  ws.onclose = () => {
    setStatus('offline', t('conn.offline', 'Sem conexão'));
    els.banner.hidden = false;
    els.bannerText.textContent = t('conn.lost', 'Conexão perdida. Tentando reconectar…');
    schedulePoll();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignora */ } };
}

// Fallback: sem WS, consulta a API periodicamente.
let pollTimer = null;
function schedulePoll() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      await load();
      els.banner.hidden = true;
    } catch {
      setStatus('offline', t('conn.offline', 'Sem conexão'));
      els.banner.hidden = false;
    }
  };
  tick();
  pollTimer = setInterval(tick, POLL_MS);
}

/* ------------------------------------------------------------------ setup */

function startClock() {
  const tick = () => { els.clock.textContent = `${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false })} BRT`; };
  tick();
  setInterval(tick, 1000);
}

function bindEvents() {
  els.mapBubbles.addEventListener('click', (event) => {
    const iso2 = event.target?.closest?.('[data-iso]')?.dataset.iso;
    if (iso2) select(iso2);
  });
  els.mapBubbles.addEventListener('pointerover', (event) => {
    const iso2 = event.target?.closest?.('[data-iso]')?.dataset.iso;
    const country = (store.state?.countries ?? []).find((c) => c.iso2 === iso2);
    if (!iso2 || !country) { els.tip.hidden = true; return; }
    els.tip.innerHTML = `<strong>${escapeHtml(countryName(iso2))}</strong><br>${fmtInt(country.validVotes)} · ${fmtPct(country.pct)}`;
    els.tip.hidden = false;
  });
  els.mapBubbles.addEventListener('pointerout', () => { els.tip.hidden = true; });
  els.mapBubbles.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const iso2 = event.target?.dataset?.iso;
    if (iso2) { event.preventDefault(); select(iso2); }
  });
  els.ranking.addEventListener('click', (event) => {
    const iso2 = event.target?.closest?.('[data-iso]')?.dataset.iso;
    if (iso2) select(iso2);
  });
  els.tableBody.addEventListener('click', (event) => {
    const iso2 = event.target?.closest?.('tr[data-iso]')?.dataset.iso;
    if (iso2) select(iso2);
  });
  els.retry.addEventListener('click', () => {
    try { store.socket?.close(); } catch { /* ignora */ }
    store.socket = null;
    connect();
  });
  els.lang.addEventListener('change', async () => {
    lang = els.lang.value;
    try { localStorage.setItem('locale', lang); } catch { /* ignora */ }
    await i18n?.setLocale?.(lang);
    lang = els.lang.value;
    displayNames = makeDisplayNames();
    applyLabels();
  });
  els.theme.addEventListener('click', () => {
    if (theme) { theme.toggle(); return; }
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    els.theme.setAttribute('aria-pressed', String(next === 'dark'));
    try { localStorage.setItem('theme', next); } catch { /* ignora */ }
  });
}

async function setupTheme() {
  try {
    const mod = await import('./lib/theme.js');
    theme = mod.createTheme();
    const paint = (state) => {
      const resolved = state?.resolved ?? document.documentElement.dataset.theme;
      els.theme.setAttribute('aria-pressed', String(resolved === 'dark'));
    };
    paint({ resolved: theme.resolved });
    theme.follow(paint);
  } catch {
    theme = null;
  }
}

async function setupI18n() {
  try {
    const mod = await import('./lib/i18n.js');
    // Sem mount(): o catálogo global não tem as chaves ext.*, então o texto é
    // aplicado só pelo catálogo local. O i18n serve para detectar/persistir o locale.
    i18n = mod.createI18n();
    lang = i18n.locale;
    displayNames = makeDisplayNames();
    els.lang.value = lang;
    i18n.onChange((next) => {
      lang = next;
      displayNames = makeDisplayNames();
      els.lang.value = next;
      applyLabels();
    });
  } catch {
    i18n = null;
  }
}

async function main() {
  startClock();
  await Promise.all([setupI18n(), setupTheme()]);
  if (!i18n) {
    try {
      const stored = localStorage.getItem('locale');
      if (stored && TEXT[stored]) lang = stored;
    } catch { /* ignora */ }
  }
  displayNames = makeDisplayNames();
  els.lang.value = lang;
  bindEvents();
  applyLabels();
  try {
    const geo = await loadWorld();
    renderMapBase(geo);
  } catch {
    els.map.setAttribute('height', '0');
  }
  try {
    await load();
  } catch {
    setStatus('offline', t('conn.offline', 'Sem conexão'));
    els.banner.hidden = false;
  }
  connect();
}

main();
