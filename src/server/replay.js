// Replay por cliente: repassa snapshots historicos na cadencia original / speed.
// Uma sessao por socket; o modo e sempre individual (nunca global).
import { timeline, snapshotAt, changesSince, previousSnapshot } from './db.js';
import { latestMarketRows } from './markets.js';

export const DEFAULT_SPEED = 20;
const MIN_DELAY_MS = 10;
const MAX_DELAY_MS = 5_000;
const BATCH = 500;

/** Limita a velocidade a faixa util. */
export function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPEED;
  return Math.min(1_000, Math.max(0.1, n));
}

/**
 * Sessao de replay de um cliente.
 * `send(msg)` entrega ao socket; `onFinish` avisa o fim do historico.
 */
export class ReplaySession {
  constructor({ db, send, onFinish = () => {}, speed = DEFAULT_SPEED } = {}) {
    if (!db) throw new Error('ReplaySession: db obrigatorio');
    if (typeof send !== 'function') throw new Error('ReplaySession: send obrigatorio');
    this.db = db;
    this.send = send;
    this.onFinish = onFinish;
    this.speed = clampSpeed(speed);
    this.mode = 'live';
    this.finished = false;
    this.active = false;
    this.lastTs = null;
    this.lastPct = null;
    this.buffer = [];
    this.timer = null;
  }

  /** Estado publico (vai em todo replayState). */
  get state() {
    return {
      mode: this.mode,
      ts: this.lastTs,
      current: this.lastTs,
      pct: this.lastPct,
      speed: this.speed,
      finished: this.finished,
      playing: this.active,
    };
  }

  emitState(extra = {}) {
    this.send({ type: 'replayState', replay: { ...this.state, ...extra } });
  }

  /** Entra em replay no snapshot imediatamente <= ts. */
  seek(ts) {
    this.stop();
    this.mode = 'replay';
    this.finished = false;
    this.buffer = [];

    const start = snapshotAt(this.db, ts);
    if (!start) {
      this.finished = true;
      this.lastTs = null;
      this.emitState({ reason: 'sem snapshot anterior' });
      this.onFinish(this);
      return false;
    }

    this.lastTs = start.ts;
    this.lastPct = start.pct;
    this.buffer = this.after(start.ts);
    this.active = true;
    this.emitState();
    this.play(start);
    return true;
  }

  /** Snapshots estritamente posteriores ao ts, em ordem crescente. */
  after(ts) {
    const rows = timeline(this.db, { from: ts, limit: BATCH });
    return rows.filter((r) => r.ts > ts).reverse();
  }

  /** Mudancas registradas ate o snapshot (contra o anterior). */
  changesFor(ts) {
    try {
      const prev = previousSnapshot(this.db, ts);
      if (!prev) return [];
      return changesSince(this.db, prev.ts).filter((c) => c.ts <= ts)
        .map((c) => ({ scope: c.scope, candidate: c.candidate, votes: c.votes, delta: c.delta }));
    } catch {
      return [];
    }
  }

  /** Emite o snapshot e agenda o proximo pela distancia original / speed. */
  play(row) {
    if (!this.active) return;
    const gap = this.nextGap(row.ts);
    const markets = latestMarketRows(this.db, row.ts);
    this.send({ type: 'snapshot', state: parse(row), changes: this.changesFor(row.ts), ts: row.ts, markets });
    if (gap === null) {
      this.finished = true;
      this.active = false;
      this.timer = null;
      this.emitState({ reason: 'fim do historico' });
      this.onFinish(this);
      return;
    }
    const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, gap / this.speed));
    this.timer = setTimeout(() => this.advance(), delay);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  /** Distancia em ms ate o proximo snapshot (ou null no fim). */
  nextGap(currentTs) {
    if (!this.buffer.length) this.buffer = this.after(currentTs);
    const next = this.buffer[0];
    if (!next) return null;
    const current = Date.parse(currentTs);
    const following = Date.parse(next.ts);
    return Number.isFinite(current) && Number.isFinite(following) ? Math.max(0, following - current) : 0;
  }

  advance() {
    const next = this.buffer.shift();
    this.timer = null;
    if (!next) {
      this.finished = true;
      this.active = false;
      this.emitState({ reason: 'fim do historico' });
      this.onFinish(this);
      return;
    }
    if (next.ts === this.lastTs) {
      // Nunca reenvia o mesmo snapshot.
      this.advance();
      return;
    }
    this.lastTs = next.ts;
    this.lastPct = next.pct;
    this.play(next);
  }

  /** Mantem o modo replay e troca a velocidade em curso. */
  setSpeed(x) {
    this.speed = clampSpeed(x);
    if (this.active) {
      this.stopTimer();
      const current = this.lastTs;
      if (current) {
        this.buffer = this.after(current);
        const gap = this.nextGap(current);
        if (gap !== null) {
          this.timer = setTimeout(() => this.advance(), Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, gap / this.speed)));
          if (typeof this.timer?.unref === 'function') this.timer.unref();
        }
      }
    }
    this.emitState();
    return this.speed;
  }

  stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Congela o replay (socket fechou ou voltou ao vivo). */
  stop() {
    this.stopTimer();
    this.active = false;
    this.buffer = [];
  }

  /** Volta ao modo ao vivo mantendo o ultimo ts conhecido. */
  toLive() {
    this.stop();
    this.mode = 'live';
    this.finished = false;
    this.emitState();
  }
}

function parse(row) {
  try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

export default ReplaySession;
