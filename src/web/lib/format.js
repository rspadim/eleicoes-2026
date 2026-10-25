// Formatação pt-BR e utilitários de texto seguros para a UI.

const intFmt = new Intl.NumberFormat('pt-BR');
const decFmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clockFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const shortClockFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Inteiro com separador de milhar pt-BR. */
export function fmtInt(value) {
  return intFmt.format(Math.round(toNumber(value)));
}

/** Percentual com 1 casa, vírgula decimal. */
export function fmtPct(value, digits = 1) {
  const n = toNumber(value);
  if (digits === 1) return `${decFmt.format(n)}%`;
  return `${n.toFixed(digits).replace('.', ',')}%`;
}

/** Notação compacta: 1,2 mi / 345 mil. */
export function fmtCompact(value) {
  const n = Math.abs(toNumber(value));
  if (n >= 1_000_000_000) return `${decFmt.format(n / 1_000_000_000)} bi`;
  if (n >= 1_000_000) return `${decFmt.format(n / 1_000_000)} mi`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} mil`;
  return fmtInt(n);
}

/** "agora", "há 3 min", "há 2 h", data curta depois de 1 dia. */
export function fmtTimeAgo(ts, now = Date.now()) {
  const then = typeof ts === 'string' ? Date.parse(ts) : toNumber(ts);
  if (!Number.isFinite(then) || then <= 0) return '—';
  const diff = Math.max(0, toNumber(now) - then);
  if (diff < 20_000) return 'agora';
  if (diff < MINUTE) return `há ${Math.round(diff / 1000)} s`;
  if (diff < HOUR) return `há ${Math.round(diff / MINUTE)} min`;
  if (diff < DAY) return `há ${Math.round(diff / HOUR)} h`;
  return `há ${Math.round(diff / DAY)} d`;
}

/** Relógio HH:MM:SS em America/Sao_Paulo. */
export function fmtClock(date = new Date()) {
  const d = paraData(date);
  try {
    return clockFmt.format(d);
  } catch {
    return '--:--:--';
  }
}

/** HH:MM em Brasília — usado no replay. */
export function fmtShortClock(ts) {
  const d = paraData(ts);
  try {
    return shortClockFmt.format(d);
  } catch {
    return '--:--';
  }
}

/** Aceita Date, epoch ms ou ISO; inválido vira "agora". */
function paraData(valor) {
  if (valor instanceof Date) return valor;
  if (typeof valor === 'string') {
    const parsed = Date.parse(valor);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  const n = Number(valor);
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto para interpolação em HTML. */
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
