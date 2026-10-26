// Orquestrador da UI: socket, estado, componentes e replay.
// Componentes vivem em ./components e podem não existir — daí o import dinâmico defensivo.

import './lib/env.js';
import { CANDIDATE_COLORS, UF_NAMES, DEFAULT_COLOR } from '../shared/config.js';
import { fmtInt, fmtPct, fmtCompact, fmtTimeAgo, fmtClock, fmtShortClock, escapeHtml } from './lib/format.js';
import { createSocket } from './lib/ws.js';
import { createI18n } from './lib/i18n.js';
import { createTheme } from './lib/theme.js';

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  status: $('#status'),
  statusText: $('#status-text'),
  clock: $('#clock'),
  themeToggle: $('#theme-toggle'),
  btnLive: $('#btn-live'),
  footerControls: $('#footer-controls'),
  kpis: $('#kpis'),
  kpiSections: $('#kpi-sections'),
  kpiSectionsSub: $('#kpi-sections-sub'),
  kpiVotes: $('#kpi-votes'),
  kpiVotesSub: $('#kpi-votes-sub'),
  kpiUfs: $('#kpi-ufs'),
  kpiUfsSub: $('#kpi-ufs-sub'),
  kpiUpdated: $('#kpi-updated'),
  partial: $('#partial-warning'),
  legend: $('#legend'),
  map: $('#map'),
  bars: $('#bars'),
  states: $('#states'),
  markets: $('#markets'),
  timeline: $('#timeline'),
  movement: $('#movement'),
  evolution: $('#evolution'),
  btnPlay: $('#btn-play'),
  btnPause: $('#btn-pause'),
  speed: $('#speed'),
  replayTime: $('#replay-time'),
  panel: $('#panel'),
  panelTitle: $('#panel-title'),
  panelBody: $('#panel-body'),
  panelClose: $('#panel-close'),
  banner: $('#conn-banner'),
  bannerText: $('#conn-text'),
  btnRetry: $('#btn-retry'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const store = {
  state: null,
  markets: null,
  replay: { timeline: [], current: null, pct: 0, playing: false, speed: 1, finished: false, pauseTs: null },
  selectedUf: null,
  mode: 'live',
  lastTs: 0,
  timelineLoaded: false,
  loadingInitial: false,
};

// uf-codes é opcional: normaliza códigos IBGE sem derrubar o app se faltar o módulo.
const IBGE_FALLBACK = { 11: 'ro', 12: 'ac', 13: 'am', 14: 'rr', 15: 'pa', 16: 'ap', 17: 'to', 21: 'ma', 22: 'pi', 23: 'ce', 24: 'rn', 25: 'pb', 26: 'pe', 27: 'al', 28: 'se', 29: 'ba', 31: 'mg', 32: 'es', 33: 'rj', 35: 'sp', 41: 'pr', 42: 'sc', 43: 'rs', 50: 'ms', 51: 'mt', 52: 'go', 53: 'df' };
let ufFromIbgeFn = (code) => IBGE_FALLBACK[String(code ?? '').trim().replace(/^0+/, '')] ?? null;

import('../shared/uf-codes.js')
  .then((mod) => { if (typeof mod?.ufFromIbge === 'function') ufFromIbgeFn = mod.ufFromIbge; })
  .catch(() => {});

const components = { map: null, bars: null, states: null, markets: null, timeline: null, movement: null, evolution: null };
const pending = { map: null, bars: null, states: null, markets: null, timeline: null, movement: null, evolution: null };

/* ------------------------------------------------------------------ status */

const STATUS_KEYS = {
  connecting: 'app.status_connecting',
  live: 'app.status_live',
  replay: 'app.status_replay',
  offline: 'app.status_offline',
  replayPaused: 'app.status_replay_paused',
};

function setStatus(kind) {
  if (!els.status) return;
  els.status.dataset.state = kind;
  if (els.statusText) {
    els.statusText.textContent = t(STATUS_KEYS[kind] ?? 'app.status_connecting');
  }
}

function setBanner(visible, text) {
  if (!els.banner) return;
  if (text) els.bannerText.textContent = text;
  els.banner.hidden = !visible;
}

/* ------------------------------------------------------------- i18n/tema */

const i18n = createI18n();
const theme = createTheme();
const langSelect = $('#lang-select');
if (langSelect) langSelect.value = i18n.locale;

const t = (key, vars) => i18n.t(key, vars);

// Tema: o controlador grava data-theme; aqui só espelhamos o botão.
theme.follow(() => {
  const light = document.documentElement.dataset.theme === 'light';
  els.themeToggle?.setAttribute('aria-pressed', String(light));
  els.themeToggle?.setAttribute('aria-label', t(light ? 'app.theme_dark' : 'app.theme_light'));
});

els.themeToggle?.addEventListener('click', () => theme.toggle());

// Rótulos estáticos traduzíveis (mantidos em um mapa para reaplicar na troca).
let baseTitle = document.title;

const STATIC_KEYS = {
  'h1': 'app.title',
  '.source-label': 'app.source',
  '.skip-link': 'app.skip_link',
  '#kpi-sections-label': 'kpi.sections_label',
  '#kpi-sections-sub': 'kpi.sections_sub',
  '#kpi-votes-label': 'kpi.votes_label',
  '#kpi-votes-sub': 'kpi.votes_sub',
  '#kpi-ufs-label': 'kpi.ufs_label',
  '#kpi-updated-label': 'kpi.updated_label',
  '#kpi-updated-sub': 'kpi.updated_sub',
  '#map-title': 'map.title',
  '.map-card .hint': 'map.hint',
  '#bars-title': 'bars.title',
  '#bars-card .hint': 'bars.hint',
  '#states-title': 'states.title',
  '#states-card .hint': 'states.hint',
  '#markets-title': 'markets.title',
  '#markets-card .hint': 'markets.hint',
  '#partial-warning': 'app.partial',
  '#panel .panel-kicker': 'panel.kicker',
  '#btn-live-label': 'timeline.live',
  '#btn-play-label': 'timeline.play',
  '#btn-pause-label': 'timeline.pause',
  '.speed-label': 'timeline.speed',
  '#btn-retry': 'conn.retry',
};

function applyStaticText() {
  for (const [sel, key] of Object.entries(STATIC_KEYS)) {
    for (const node of document.querySelectorAll(sel)) node.textContent = t(key);
  }
  if (els.kpiUfsSub) els.kpiUfsSub.textContent = t('kpi.ufs_sub', { total: 27 });
  if (els.status) setStatus(els.status.dataset.state ?? 'connecting');
  if (els.btnLive) els.btnLive.title = t('timeline.back_to_live');
  if (els.clock) els.clock.setAttribute('aria-label', t('time.brasilia'));
  if (els.speed) els.speed.setAttribute('aria-label', t('timeline.speed_aria'));
  if (els.btnPlay) els.btnPlay.setAttribute('aria-label', t('timeline.play'));
  if (els.btnPause) els.btnPause.setAttribute('aria-label', t('timeline.pause'));
  if (els.panelClose) els.panelClose.setAttribute('aria-label', t('panel.close_aria'));
  if (els.map) els.map.setAttribute('aria-label', t('map.aria'));
  if (els.legend) els.legend.setAttribute('aria-label', t('map.legend_aria'));
  if (els.bannerText && !els.banner?.hidden) els.bannerText.textContent = t('conn.lost');
  if (langSelect) langSelect.setAttribute('aria-label', t('app.lang_aria'));
  document.title = baseTitle;
}

langSelect?.addEventListener('change', async () => {
  await i18n.setLocale(langSelect.value);
  baseTitle = t('app.title');
  applyStaticText();
  renderAll();
});

let localeBusy = false;
i18n.onChange(async () => {
  // setLocale emite antes de carregar o catálogo; reaplicamos depois.
  if (localeBusy) return;
  localeBusy = true;
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  baseTitle = t('app.title');
  applyStaticText();
  renderAll();
  localeBusy = false;
});

/* ------------------------------------------------------------------ relógio */

function tickClock() {
  if (els.clock) els.clock.textContent = `${fmtClock()} BRT`;
}

tickClock();
setInterval(tickClock, 1_000);

/* ------------------------------------------------------------------ helpers */

function candidateColor(candidate) {
  if (!candidate) return DEFAULT_COLOR;
  return candidate.color
    || CANDIDATE_COLORS[candidate.n]
    || CANDIDATE_COLORS[candidate.nmu]
    || DEFAULT_COLOR;
}

function ufName(uf) {
  return ufData(uf)?.name || UF_NAMES[uf] || String(uf).toUpperCase();
}

/** Busca dados da UF tolerando chaves em maiúsculas ou códigos IBGE. */
function ufData(value) {
  const ufs = store.state?.ufs;
  if (!ufs) return null;
  const uf = normalizeUf(value);
  if (!uf) return null;
  return ufs[uf] ?? ufs[uf.toUpperCase()] ?? null;
}

/** Aceita sigla ou código IBGE e devolve a sigla (ou o valor original). */
function normalizeUf(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (UF_NAMES[raw]) return raw;
  const mapped = ufFromIbgeFn(raw);
  return mapped ?? raw;
}

function voteTotalOf(ufData) {
  const votes = ufData?.votes;
  if (typeof votes === 'number') return votes;
  if (votes && typeof votes === 'object') {
    return Object.values(votes).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }
  return Number(ufData?.totalVotes) || 0;
}

/** Converte ts ISO ou epoch em milissegundos. */
function toTs(value) {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function clearEmpty(el) {
  el?.querySelector('.card-empty, .map-empty')?.remove();
}

/* ---------------------------------------------------------------- KPIs */

function renderKpis(state) {
  const total = Number(state?.national?.totalSections) || 0;
  const counted = Number(state?.national?.countedSections) || 0;
  const sectionsPct = Number(state?.national?.pct) || 0;
  const totalsPct = Number(state?.totals?.pct);
  const pct = Number.isFinite(totalsPct) ? totalsPct : sectionsPct;
  const ufs = state?.ufs ? Object.values(state.ufs) : [];
  const comDados = ufs.filter((u) => (Number(u?.countedSections) || 0) > 0).length;
  const concluidas = ufs.filter((u) => {
    const contadas = Number(u?.countedSections) || 0;
    const total = Number(u?.totalSections) || 0;
    return total > 0 && contadas >= total;
  }).length;

  const national = state?.national ?? {};
  const votes = national.totalVotes ?? Object.values(national.votes ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);

  if (els.kpiSections) els.kpiSections.textContent = fmtPct(pct, 2);
  if (els.kpiSectionsSub) {
    els.kpiSectionsSub.textContent = total
      ? t('sections.of_total', { counted: fmtCompact(counted), total: fmtCompact(total) })
      : `${fmtCompact(counted)} seções`;
  }
  if (els.kpiVotes) els.kpiVotes.textContent = fmtCompact(votes);
  if (els.kpiVotesSub) {
    els.kpiVotesSub.textContent = `${fmtInt(votes)} ${t('totals.valid').toLowerCase()}`;
  }
  if (els.kpiUfs) els.kpiUfs.textContent = `${concluidas} / ${ufs.length || 27}`;
  if (els.kpiUfsSub) {
    const vars = { started: comDados, done: concluidas, total: ufs.length || 27 };
    // pluralização simples: a chave _one existe nos três idiomas
    const chave = concluidas === 1 ? 'kpi.ufs_sub_progress_one' : 'kpi.ufs_sub_progress';
    els.kpiUfsSub.textContent = t(chave, vars);
  }
  if (els.kpiUpdated) {
    const ts = toTs(state?.ts);
    els.kpiUpdated.textContent = ts ? `${fmtTimeAgo(ts)} · ${fmtShortClock(ts)}` : '—';
  }

  if (els.partial) {
    els.partial.hidden = !(pct < 100);
    if (pct < 100) {
      const official = state?.dataAge?.officialTs;
      const age = official ? fmtTimeAgo(official) : null;
      const hhmm = official ? fmtShortClock(official) : null;
      const ageText = age ? `dados do TSE de ${hhmm} (${age})` : '';
      els.partial.textContent = t('app.partial_age', {
        pct: fmtPct(pct, 2),
        age: ageText,
      });
    }
  }
}

setInterval(() => {
  if (store.state?.ts) renderKpis(store.state);
}, 30_000);

/* --------------------------------------------------------------- legenda */

function renderLegend(state) {
  if (!els.legend) return;
  const candidates = [...(state?.candidates ?? [])].sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));
  els.legend.innerHTML = candidates.slice(0, 6).map((c) => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${escapeHtml(candidateColor(c))}"></span>
      ${escapeHtml(c.nmu || c.n)} · ${escapeHtml(c.party ?? '')}
    </span>
  `).join('');
}

/* --------------------------------------------------------------- painel */

function openPanel(rawUf, { focus = true } = {}) {
  const uf = normalizeUf(rawUf);
  if (!uf || !els.panel || !store.state) return;
  const wasOpen = !els.panel.hidden && els.panel.dataset.open === 'true';
  store.selectedUf = uf;
  const data = ufData(uf);
  const name = ufName(uf);

  if (els.panelTitle) els.panelTitle.textContent = name;
  if (els.panelBody) {
    if (!data) {
      els.panelBody.innerHTML = '<p class="card-empty">Sem dados deste estado por enquanto.</p>';
    } else {
      const candidates = [...(data.candidates ?? [])].sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));
      const leader = candidates[0];
      const runnerUp = candidates[1];
      const lead = leader && runnerUp ? (Number(leader.pct) || 0) - (Number(runnerUp.pct) || 0) : 0;

      els.panelBody.innerHTML = `
        <dl class="panel-stats">
          <div class="panel-stat"><dt>Seções apuradas</dt><dd>${fmtPct(Number(data.pct) || 0, 2)}</dd></div>
          <div class="panel-stat"><dt>Votos válidos</dt><dd>${fmtCompact(voteTotalOf(data))}</dd></div>
          <div class="panel-stat"><dt>Liderança</dt><dd>${leader ? escapeHtml(leader.nmu || leader.n) : '—'}</dd></div>
          <div class="panel-stat"><dt>Margem</dt><dd>${leader && runnerUp ? `${fmtPct(lead)} p.p.` : '—'}</dd></div>
        </dl>
        <div class="bars">
          ${candidates.map((c) => `
            <div>
              <div class="bar-head">
                <span class="bar-name">
                  <span class="bar-swatch" style="background:${escapeHtml(candidateColor(c))}"></span>
                  ${escapeHtml(c.nmu || c.n)} <span class="bar-party">${escapeHtml(c.party ?? '')}</span>
                </span>
                <span class="bar-nums">
                  <span class="bar-pct">${fmtPct(Number(c.pct) || 0)}</span>
                  <span class="bar-votes">${fmtInt(c.votes)}</span>
                </span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, Number(c.pct) || 0))}%;background:${escapeHtml(candidateColor(c))}"></div></div>
            </div>
          `).join('') || '<p class="card-empty">Ainda sem votos contabilizados.</p>'}
        </div>
        ${Number(data.pct) < 100 ? '<p class="hint">Apuração local em andamento — números parciais.</p>' : ''}
      `;
    }
  }

  els.panel.hidden = false;
  els.panel.setAttribute('aria-hidden', 'false');
  safeCall('map', 'setSelected', uf);
  requestAnimationFrame(() => { els.panel.dataset.open = 'true'; });
  if (focus && !wasOpen) els.panelClose?.focus({ preventScroll: true });
}

function closePanel() {
  if (!els.panel || els.panel.hidden) return;
  store.selectedUf = null;
  safeCall('map', 'setSelected', null);
  els.panel.dataset.open = 'false';
  els.panel.setAttribute('aria-hidden', 'true');
  const hide = () => { if (els.panel.dataset.open !== 'true') els.panel.hidden = true; };
  if (reduceMotion.matches) hide();
  else setTimeout(hide, 240);
}

els.panelClose?.addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});

/* ------------------------------------------------------------ componentes */

function emptyNotice(el, text) {
  if (!el) return;
  if (el.querySelector(':scope > *:not(.card-empty):not(.map-empty)')) return;
  el.querySelectorAll('.card-empty, .map-empty').forEach((n) => n.remove());
  const p = document.createElement('p');
  p.className = el === els.map ? 'map-empty' : 'card-empty';
  p.textContent = text;
  el.appendChild(p);
}

async function loadComponent(key, path, factory, el) {
  if (!el) return null;
  let instance = null;
  try {
    const mod = await import(path);
    if (typeof mod?.[factory] !== 'function') throw new Error('componente indisponível');
    instance = mod[factory](el, factoryArgs(key));
    components[key] = instance;
    clearEmpty(el);
  } catch {
    emptyNotice(el, 'Componente carregando…');
    return null;
  }

  const queued = pending[key];
  pending[key] = null;
  if (queued) safeUpdate(key, queued);
  return instance;
}

function factoryArgs(key) {
  switch (key) {
    case 'map': return { onSelect: (uf) => openPanel(uf) };
    case 'bars': return { onSelectCandidate: (candidate) => highlightCandidate(candidate) };
    case 'states': return { onSelect: (uf) => openPanel(uf) };
    case 'timeline': return { onSeek, onPlay, onPause, onSpeed, onLive };
    case 'movement': return { onSelect: (uf) => openPanel(uf) };
    default: return {};
  }
}

function safeUpdate(key, payload) {
  const comp = components[key];
  if (!comp || typeof comp.update !== 'function') {
    pending[key] = payload;
    return;
  }
  try {
    comp.update(payload);
  } catch { /* componente tolerante a falhas */ }
}

function safeCall(key, method, ...args) {
  const comp = components[key];
  if (!comp || typeof comp[method] !== 'function') return;
  try { comp[method](...args); } catch { /* ignora */ }
}

function highlightCandidate(candidate) {
  const number = typeof candidate === 'object' && candidate ? (candidate.n ?? candidate.nmu) : candidate;
  const fallback = [...(store.state?.candidates ?? [])].sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0))[0];
  const n = number ?? fallback?.n;
  if (!n) return;
  safeCall('map', 'highlightCandidate', n);
}

/* -------------------------------------------------------------- render */

/* ---------------------------------------------------------------- title */

// Título da aba mostra o placar corrente, no mesmo formato e ordem do TSE:
// "Flavio 50,30% | 49,70% Lula".
function renderTitle(state) {
  const lista = (state?.candidates ?? []).filter((c) => Number(c.pct) > 0);
  if (lista.length < 2) {
    document.title = store.mode === 'replay' && store.replay.current
      ? `${fmtShortClock(store.replay.current)} · ${baseTitle}`
      : baseTitle;
    return;
  }
  const short = (c) => {
    const w = String(c.nmu ?? c.n).split(' ')[0];
    return w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w;
  };
  const [a, b] = lista;
  document.title = `${short(a)} ${fmtPct(a.pct, 2)} | ${fmtPct(b.pct, 2)} ${short(b)}`;
}

function renderAll() {
  renderTitle(store.state);
  renderKpis(store.state);
  renderLegend(store.state);
  safeUpdate('map', store.state);
  safeUpdate('bars', store.state);
  safeUpdate('states', store.state);
  if (store.selectedUf) openPanel(store.selectedUf, { focus: false });
  renderReplay();
}

function renderReplay() {
  const r = store.replay;
  // Percentual real de apuração vem do estado exibido (ao vivo ou replay),
  // nunca da posição do slider no histórico.
  const statePct = Number(store.state?.totals?.pct ?? store.state?.national?.pct);
  const displayPct = Number.isFinite(statePct) ? statePct : Math.min(100, Number(r.pct) || 0);
  safeUpdate('timeline', {
    timeline: r.timeline,
    current: r.current,
    pct: displayPct,
    playing: r.playing,
    speed: r.speed,
    finished: r.finished,
    mode: store.mode,
  });

  if (els.replayTime) {
    els.replayTime.textContent = store.mode === 'live'
      ? 'ao vivo'
      : (r.current ? fmtShortClock(r.current) : '--:--');
  }
  if (els.btnLive) els.btnLive.setAttribute('aria-pressed', String(store.mode === 'live'));
  if (els.btnPlay) els.btnPlay.disabled = r.playing;
  if (els.btnPause) els.btnPause.disabled = !r.playing;
  if (els.speed) {
    const speed = String(r.speed ?? 1);
    if (![...els.speed.options].some((o) => o.value === speed)) {
      const opt = document.createElement('option');
      opt.value = speed;
      opt.textContent = `${speed}×`;
      els.speed.appendChild(opt);
    }
    if (document.activeElement !== els.speed) els.speed.value = speed;
  }
  if (els.timeline) {
    els.timeline.disabled = !r.timeline.length;
    const range = els.timeline.querySelector?.('input[type="range"]');
    if (range && !r.timeline.length) range.disabled = true;
  }
  // Em "ao vivo" o rodapé é só a linha do tempo; play/pause/velocidade
  // aparecem quando o usuário arrasta o histórico e entra no replay.
  if (els.footerControls) els.footerControls.hidden = store.mode === 'live';

  if (!socket.online) setStatus('offline');
  else if (store.mode === 'replay') setStatus(r.playing ? 'replay' : 'replayPaused');
  else setStatus('live');

  safeCall('map', 'setMode', store.mode);
  for (const el of [els.btnPlay, els.btnPause, els.speed]) {
    if (el) el.setAttribute('aria-disabled', String(Boolean(el.disabled)));
  }
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  if (state.ufs && typeof state.ufs === 'object') {
    const normalized = {};
    for (const [key, value] of Object.entries(state.ufs)) {
      const uf = normalizeUf(key) ?? key;
      if (value && typeof value === 'object' && !value.name && UF_NAMES[uf]) normalized[uf] = { ...value, name: UF_NAMES[uf] };
      else normalized[uf] = value;
    }
    state = { ...state, ufs: normalized };
  }
  store.state = state;
  store.lastTs = state.ts ?? store.lastTs;
  renderAll();
}

function applyMarkets(markets) {
  if (!markets || typeof markets !== 'object') return;
  store.markets = markets;
  safeUpdate('markets', markets);
}

/** Busca movimento e evolução (fora do WebSocket: derivados do histórico). */
async function loadDerived() {
  // No replay os cards derivados acompanham o instante exibido, não o ao vivo.
  const at = store.mode === 'replay' && store.replay.current
    ? `?at=${encodeURIComponent(new Date(Number(store.replay.current)).toISOString())}`
    : '';
  try {
    const [mov, evo, mk] = await Promise.all([
      fetch(`/api/movement${at}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/evolution${at}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      // Odds do instante exibido (no ao vivo cai no latest).
      fetch(`/api/markets${at}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (mov) {
      safeUpdate('movement', mov);
      const linhas = [...(mov.rows ?? []), ...(mov.up ?? []), ...(mov.down ?? [])];
      safeCall('map', 'setMovement', linhas);
    }
    if (evo) safeUpdate('evolution', evo);
    if (mk) applyMarkets({ polymarket: mk.polymarket, kalshi: mk.kalshi, ts: mk.ts });
  } catch { /* derivados são opcionais */ }
}

function applyReplay(replay) {
  if (!replay || typeof replay !== 'object') return;
  if (Array.isArray(replay.timeline)) store.replay.timeline = replay.timeline;
  const next = { ...store.replay };
  if (replay.mode) store.mode = replay.mode === 'replay' ? 'replay' : 'live';
  const ts = toTs(replay.current ?? replay.ts);
  if (ts) next.current = ts;
  if (Number.isFinite(Number(replay.pct))) next.pct = Number(replay.pct);
  if (typeof replay.playing === 'boolean') next.playing = replay.playing;
  if (Number.isFinite(Number(replay.speed))) next.speed = Number(replay.speed);
  if (typeof replay.finished === 'boolean') next.finished = replay.finished;
  if (next.finished) next.playing = false;
  // Pausa local (o servidor não tem pausa) tem precedência.
  if (next.pauseTs) next.playing = false;

  // pct do replay derivado da posição no histórico quando o servidor não manda.
  if (!Number.isFinite(Number(replay.pct)) && next.timeline.length && next.current) {
    const idx = next.timeline.findIndex((p) => toTs(p?.ts ?? p) >= next.current);
    if (idx >= 0) next.pct = (idx / Math.max(1, next.timeline.length - 1)) * 100;
  }

  store.replay = next;
  renderReplay();
}

function flashChanges(changes) {
  if (!changes) return;
  const list = (Array.isArray(changes) ? changes : Object.keys(changes))
    .map((c) => normalizeUf(typeof c === 'string' ? c : c?.uf))
    .filter(Boolean);
  if (!list.length) return;
  safeCall('map', 'flash', list);
}

/* --------------------------------------------------------------- socket */

const socket = createSocket({
  onOpen() {
    setBanner(false);
    setStatus(store.mode === 'replay' ? 'replay' : 'live');
    if (store.mode === 'live') socket.send({ type: 'live' });
    else socket.send({ type: 'seek', t: timeToSeek() });
    loadInitial();
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        if (msg.mode) store.mode = msg.mode === 'replay' ? 'replay' : 'live';
        if (msg.state) applyState(msg.state);
        if (msg.markets) applyMarkets(msg.markets);
        if (msg.replay) applyReplay(msg.replay);
        setStatus(store.mode === 'replay' ? 'replayPaused' : 'live');
        break;
      }
      case 'snapshot': {
        if (store.mode === 'replay' && !store.replay.playing) {
          // Pausado: guarda o ponto e ignora avanço do servidor.
          break;
        }
        if (store.mode === 'replay' && msg.ts) {
          const ts = toTs(msg.ts);
          if (ts) store.replay.current = ts;
        }
        applyState(msg.state);
        if (msg.markets) applyMarkets(msg.markets);
        flashChanges(msg.changes);
        loadDerived();
        break;
      }
      case 'markets':
        applyMarkets(msg.markets);
        break;
      case 'replayState':
        applyReplay(msg.replay);
        break;
      case 'error':
        if (els.bannerText) {
          els.bannerText.textContent = msg.message || 'Não foi possível atualizar os dados.';
          setBanner(true, els.bannerText.textContent);
        }
        break;
      default:
        break;
    }
  },
  onClose() {
    setBanner(true, 'Conexão perdida. Tentando reconectar…');
    setStatus('offline');
    if (els.bannerText) els.bannerText.textContent = 'Conexão perdida. Tentando reconectar…';
  },
  onRetry(delay) {
    if (els.bannerText) {
      els.bannerText.textContent = `Sem conexão. Nova tentativa em ${Math.ceil(delay / 1000)} s…`;
    }
  },
});

els.btnRetry?.addEventListener('click', () => socket.retry());

/* ------------------------------------------------------------------ boot */

async function loadInitial() {
  if (store.loadingInitial) return;
  store.loadingInitial = true;
  try {
    const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    applyState(data?.state ?? data);
    if (data?.markets) applyMarkets(data.markets);
  } catch {
    emptyNotice(els.map, t('warn.no_data'));
    emptyNotice(els.bars, t('empty.awaiting'));
    emptyNotice(els.states, t('empty.awaiting'));
  } finally {
    store.loadingInitial = false;
  }

  if (!store.timelineLoaded) {
    store.timelineLoaded = true;
    try {
      const res = await fetch('/api/timeline', { headers: { accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const list = (data?.points ?? data?.timeline ?? [])
          .map((p) => ({ ts: toTs(p?.ts ?? p), pct: Number(p?.pct) || 0 }))
          .filter((p) => p.ts);
        if (list.length) {
          const last = list[list.length - 1];
          applyReplay({ timeline: list, current: last.ts, pct: last.pct });
        }
      }
    } catch { /* timeline é opcional */ }
  }
}

async function boot() {
  // Espera o catálogo antes de pintar rótulos (evita chave crua na tela).
  try { await i18n.setLocale(i18n.locale); } catch { /* segue com fallback */ }
  i18n.mount(document.body);
  baseTitle = t('app.title');
  applyStaticText();
  document.title = baseTitle;

  emptyNotice(els.map, t('a11y.loading'));
  emptyNotice(els.bars, t('a11y.loading'));
  emptyNotice(els.states, t('a11y.loading'));
  emptyNotice(els.markets, t('a11y.loading'));
  emptyNotice(els.movement, t('a11y.loading'));
  emptyNotice(els.evolution, t('a11y.loading'));

  await loadInitial();

  await Promise.all([
    loadComponent('map', './components/map.js', 'createMap', els.map),
    loadComponent('bars', './components/bars.js', 'createBars', els.bars),
    loadComponent('states', './components/states.js', 'createStateTable', els.states),
    loadComponent('markets', './components/markets.js', 'createMarkets', els.markets),
    loadComponent('timeline', './components/timeline.js', 'createTimeline', els.timeline),
    loadComponent('movement', './components/movement.js', 'createMovement', els.movement),
    loadComponent('evolution', './components/evolution.js', 'createEvolution', els.evolution),
  ]);

  for (const el of [els.map, els.bars, els.states, els.markets, els.timeline, els.movement, els.evolution]) clearEmpty(el);
  loadDerived();
  if (store.state) renderAll();
  else if (els.partial) els.partial.hidden = true;
  if (store.markets) safeUpdate('markets', store.markets);
}

/* --------------------------------------------------------------- replay */

function onSeek(t) {
  const ts = Number(t);
  if (!Number.isFinite(ts)) return;
  store.mode = 'replay';
  store.replay.playing = true;
  store.replay.pauseTs = null;
  socket.send({ type: 'seek', t: ts });
  renderReplay();
  loadDerived();
}

function onPlay() {
  const primeiro = store.replay.timeline[0];
  // Vindo do ao vivo, "reproduzir" começa do início do histórico; pausado,
  // retoma do ponto onde parou.
  const alvo = store.mode === 'live'
    ? toTs(primeiro?.ts ?? primeiro)
    : (store.replay.pauseTs ?? store.replay.current);
  store.mode = 'replay';
  store.replay.playing = true;
  store.replay.finished = false;
  store.replay.pauseTs = null;
  socket.send({ type: 'seek', t: Number(alvo) || Date.now() });
  renderReplay();
  loadDerived();
}

function onPause() {
  store.replay.playing = false;
  store.replay.pauseTs = store.replay.current ?? Date.now();
  renderReplay();
}

function onSpeed(x) {
  const speed = Number(x) || 1;
  store.replay.speed = speed;
  socket.send({ type: 'speed', x: speed });
  renderReplay();
}

function onLive() {
  store.mode = 'live';
  store.replay.playing = false;
  store.replay.pauseTs = null;
  store.replay.finished = false;
  socket.send({ type: 'live' });
  loadInitial();
  renderReplay();
  loadDerived();
}

const timeToSeek = () => {
  const current = Number(store.replay.current);
  return Number.isFinite(current) ? current : Date.now();
};

els.btnPlay?.addEventListener('click', onPlay);
els.btnPause?.addEventListener('click', onPause);
els.speed?.addEventListener('change', (e) => onSpeed(e.target.value));
els.btnLive?.addEventListener('click', onLive);

// Fallback do rodapé: funciona mesmo sem o componente de timeline.
let lastSeek = { value: null, at: 0 };
function seekFromInput(e) {
  if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'range') return;
  if (components.timeline) return;
  const value = Number(e.target.value);
  const now = Date.now();
  if (value === lastSeek.value && now - lastSeek.at < 120) return;
  lastSeek = { value, at: now };
  onSeek(value);
}

els.timeline?.addEventListener('input', seekFromInput);

window.addEventListener('beforeunload', () => socket.close());

setStatus('connecting');
boot();
