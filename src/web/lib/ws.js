// Cliente WebSocket com reconexão exponencial (1s → 15s), fila e ping.

const MIN_DELAY = 1_000;
const MAX_DELAY = 15_000;
const PING_MS = 25_000;
const MAX_QUEUE = 50;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Cria um socket resiliente.
 * @param {{onOpen?:Function,onMessage?:Function,onClose?:Function,onRetry?:Function}} handlers
 */
export function createSocket({ onOpen, onMessage, onClose, onRetry } = {}) {
  let socket = null;
  let attempt = 0;
  let token = 0;
  let timer = null;
  let pingTimer = null;
  let closedByUser = false;
  let online = false;
  const queue = [];

  function connect() {
    if (closedByUser || socket) return;
    token += 1;
    const seq = token;

    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleRetry(seq);
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (seq !== token) return;
      attempt = 0;
      online = true;
      startPing();
      try { onOpen?.(); } catch { /* ignora */ }
      flush();
    };

    ws.onmessage = (event) => {
      if (seq !== token) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      try { onMessage?.(msg); } catch { /* ignora handler quebrado */ }
    };

    ws.onerror = () => { /* onclose cuida da retentativa */ };

    ws.onclose = () => {
      if (seq !== token) return;
      socket = null;
      stopPing();
      if (online) {
        online = false;
        try { onClose?.(); } catch { /* ignora */ }
      }
      if (closedByUser) return;
      scheduleRetry(seq);
    };
  }

  function scheduleRetry(seq) {
    if (closedByUser) return;
    attempt += 1;
    const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** Math.max(0, attempt - 1));
    const delay = base * (0.85 + Math.random() * 0.3);
    try { onRetry?.(Math.round(delay), attempt); } catch { /* ignora */ }
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (socket || closedByUser) return;
      connect();
    }, delay);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function flush() {
    while (queue.length && socket?.readyState === WebSocket.OPEN) {
      const payload = queue.shift();
      try { socket.send(payload); } catch { queue.unshift(payload); break; }
    }
  }

  function send(message) {
    const payload = JSON.stringify(message);
    if (socket?.readyState === WebSocket.OPEN) {
      flush();
      try { socket.send(payload); } catch { queue.push(payload); }
    } else if (queue.length < MAX_QUEUE) {
      queue.push(payload);
    }
  }

  function manualRetry() {
    if (closedByUser) return;
    clearTimeout(timer);
    timer = null;
    if (socket) {
      const old = socket;
      socket = null;
      token += 1;
      try { old.close(); } catch { /* ignora */ }
    }
    attempt = 0;
    connect();
  }

  function close() {
    closedByUser = true;
    clearTimeout(timer);
    stopPing();
    token += 1;
    if (socket) {
      try { socket.close(); } catch { /* ignora */ }
      socket = null;
    }
    online = false;
  }

  connect();

  return {
    send,
    retry: manualRetry,
    close,
    get online() { return online; },
    get attempt() { return attempt; },
  };
}
