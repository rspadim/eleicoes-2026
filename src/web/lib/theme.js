// Tema claro/escuro/auto com persistência e respeito a prefers-color-scheme.

const STORAGE_KEY = 'theme';
const MODES = Object.freeze(['light', 'dark', 'auto']);
const DEFAULT_MODE = 'auto';
const QUERY = '(prefers-color-scheme: dark)';

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStored() {
  try {
    return safeStorage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function store(mode) {
  try {
    safeStorage()?.setItem(STORAGE_KEY, mode);
  } catch {
    /* armazenamento indisponível */
  }
}

function normalizeMode(input) {
  return MODES.includes(input) ? input : null;
}

function query() {
  try {
    return globalThis.matchMedia?.(QUERY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cria o controlador de tema.
 * @returns {{ current: string, resolved: string, set(mode:string):string, toggle():string, follow(cb:Function):Function, destroy():void }}
 */
export function createTheme() {
  /** @type {Set<Function>} */
  const listeners = new Set();
  let mode = normalizeMode(readStored()) ?? DEFAULT_MODE;
  let mql = null;

  function resolve() {
    if (mode !== 'auto') return mode;
    return query()?.matches ? 'dark' : 'light';
  }

  function paint() {
    const resolved = resolve();
    const html = globalThis.document?.documentElement;
    if (html) {
      html.dataset.theme = resolved;
      html.dataset.themeMode = mode;
      html.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
    }
    for (const cb of listeners) {
      try {
        cb({ mode, resolved });
      } catch {
        /* assinante com erro não interrompe os demais */
      }
    }
    return resolved;
  }

  function onSystemChange() {
    if (mode !== 'auto') return;
    paint();
  }

  function bindQuery() {
    if (mql) return;
    const next = query();
    if (!next) return;
    mql = next;
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onSystemChange);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onSystemChange);
    }
  }

  function unbindQuery() {
    if (!mql) return;
    if (typeof mql.removeEventListener === 'function') {
      mql.removeEventListener('change', onSystemChange);
    } else if (typeof mql.removeListener === 'function') {
      mql.removeListener(onSystemChange);
    }
    mql = null;
  }

  /** Define o modo ('light' | 'dark' | 'auto'), persiste e repinta. */
  function set(next) {
    const normalized = normalizeMode(next);
    if (!normalized) return resolve();
    mode = normalized;
    store(mode);
    if (mode === 'auto') bindQuery();
    else unbindQuery();
    return paint();
  }

  /** Alterna claro <-> escuro partindo do tema efetivamente exibido. */
  function toggle() {
    return set(resolve() === 'dark' ? 'light' : 'dark');
  }

  /** Notifica mudanças com { mode, resolved }. Devolve cancelamento. */
  function follow(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function destroy() {
    unbindQuery();
    listeners.clear();
  }

  if (mode === 'auto') bindQuery();
  paint();

  return {
    get current() {
      return mode;
    },
    get resolved() {
      return resolve();
    },
    modes: MODES,
    set,
    toggle,
    follow,
    apply: paint,
    destroy,
  };
}

/**
 * Aplica o tema antes da primeira pintura, evitando flash de tema errado.
 * Uso típico num <script> inline no <head>.
 */
export function applyThemeEarly() {
  const stored = normalizeMode(readStored()) ?? DEFAULT_MODE;
  const resolved = stored === 'auto' ? (query()?.matches ? 'dark' : 'light') : stored;
  const html = globalThis.document?.documentElement;
  if (!html) return resolved;
  html.dataset.theme = resolved;
  html.dataset.themeMode = stored;
  html.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
  return resolved;
}
