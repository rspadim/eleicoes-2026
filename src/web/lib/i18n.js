// i18n sem dependências: catálogos JSON, interpolação e aplicação por atributos.
// Cascata de fallback: locale atual -> pt-BR -> própria chave.

export const SUPPORTED_LOCALES = Object.freeze(['pt-BR', 'en', 'es']);
export const FALLBACK_LOCALE = 'pt-BR';

const STORAGE_KEY = 'locale';
const LOCALE_DIR = Object.freeze({ 'pt-BR': 'ltr', en: 'ltr', es: 'ltr' });

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredLocale() {
  try {
    return safeStorage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeLocale(locale) {
  try {
    safeStorage()?.setItem(STORAGE_KEY, locale);
  } catch {
    /* armazenamento indisponível */
  }
}

/**
 * Normaliza qualquer etiqueta BCP-47 para um locale suportado.
 * "en-US" -> "en", "pt-PT" -> "pt-BR", "es-419" -> "es", desconhecido -> null.
 * @param {string} input
 * @returns {'pt-BR'|'en'|'es'|null}
 */
export function normalizeLocale(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const supported of SUPPORTED_LOCALES) {
    if (supported.toLowerCase() === lower) return supported;
  }
  const base = lower.split(/[-_]/)[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'en') return 'en';
  if (base === 'es') return 'es';
  return null;
}

/** Detecta o locale inicial: preferência salva, idioma do navegador, padrão. */
export function detectLocale(defaultLocale = FALLBACK_LOCALE) {
  const stored = normalizeLocale(readStoredLocale());
  if (stored) return stored;
  const navigatorLang = (() => {
    try {
      return globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || '';
    } catch {
      return '';
    }
  })();
  const detected = normalizeLocale(navigatorLang);
  if (detected) return detected;
  return normalizeLocale(defaultLocale) ?? FALLBACK_LOCALE;
}

function parseVars(el) {
  const raw = el?.getAttribute?.('data-i18n-vars');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    vars[name] == null ? match : String(vars[name])
  ));
}

function createElementList(root) {
  const list = [];
  if (!root) return list;
  if (root.nodeType === 1) list.push(root);
  const scope = root.querySelectorAll ? root : globalThis.document;
  if (scope?.querySelectorAll) {
    list.push(...scope.querySelectorAll(
      '[data-i18n],[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]',
    ));
  }
  return list;
}

/**
 * Cria uma instância de internacionalização.
 * @param {{defaultLocale?: string}} [options]
 */
export function createI18n({ defaultLocale = FALLBACK_LOCALE } = {}) {
  /** @type {Map<string, Promise<object|null>>} */
  const loads = new Map();
  /** @type {Map<string, object>} */
  const dicts = new Map();
  /** @type {Set<Function>} */
  const listeners = new Set();

  let locale = detectLocale(defaultLocale);
  let root = null;
  let observer = null;

  function syncDocumentAttrs() {
    const html = globalThis.document?.documentElement;
    if (!html) return;
    html.setAttribute('lang', locale);
    html.setAttribute('dir', LOCALE_DIR[locale] ?? 'ltr');
  }

  /** Carrega e memoiza um catálogo. Falhas viram catálogo vazio (cascata assume). */
  function load(target) {
    if (!target) return Promise.resolve(null);
    if (loads.has(target)) return loads.get(target);
    const promise = (async () => {
      if (typeof globalThis.fetch !== 'function') return null;
      try {
        const res = await globalThis.fetch(`/locales/${target}.json`, {
          headers: { accept: 'application/json' },
        });
        if (!res || res.ok === false) return null;
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        return data;
      } catch {
        return null;
      }
    })().then((data) => {
      if (data) dicts.set(target, data);
      return data;
    });
    loads.set(target, promise);
    return promise;
  }

  function lookup(key, vars) {
    const direct = dicts.get(locale)?.[key];
    if (typeof direct === 'string' && direct) return interpolate(direct, vars);
    const fallback = dicts.get(FALLBACK_LOCALE)?.[key];
    if (typeof fallback === 'string' && fallback) return interpolate(fallback, vars);
    return key;
  }

  /**
   * Traduz uma chave, interpolando {var}.
   * @param {string} key
   * @param {Record<string, unknown>} [vars]
   */
  function t(key, vars) {
    const id = String(key ?? '');
    if (!id) return '';
    return lookup(id, vars);
  }

  /** Aplica as traduções a um subárvore (ou ao root montado / documento). */
  function apply(scope = root ?? globalThis.document) {
    if (!scope) return;
    for (const el of createElementList(scope)) {
      const vars = parseVars(el);
      const textKey = el.getAttribute?.('data-i18n');
      const titleKey = el.getAttribute?.('data-i18n-title');
      const ariaKey = el.getAttribute?.('data-i18n-aria');
      const placeholderKey = el.getAttribute?.('data-i18n-placeholder');
      if (textKey) el.textContent = lookup(textKey, vars);
      if (titleKey) el.setAttribute('title', lookup(titleKey, vars));
      if (ariaKey) el.setAttribute('aria-label', lookup(ariaKey, vars));
      if (placeholderKey) el.setAttribute('placeholder', lookup(placeholderKey, vars));
    }
  }

  function emit() {
    for (const cb of listeners) {
      try {
        cb(locale);
      } catch {
        /* um assinante com erro não derruba os demais */
      }
    }
  }

  /**
   * Troca o idioma, persiste, atualiza <html lang/dir>, reaplica e notifica.
   * @param {string} next
   */
  async function setLocale(next) {
    const normalized = normalizeLocale(next) ?? normalizeLocale(defaultLocale) ?? FALLBACK_LOCALE;
    const changed = normalized !== locale;
    locale = normalized;
    storeLocale(locale);
    syncDocumentAttrs();
    if (changed) emit();
    apply();
    await load(locale);
    apply();
    return locale;
  }

  /** Assina mudanças de idioma. Devolve função de cancelamento. */
  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** Define o root, aplica e passa a observar nós inseridos dinamicamente. */
  function mount(scope = globalThis.document) {
    disconnectObserver();
    root = scope ?? globalThis.document;
    apply(root);
    const Observer = globalThis.MutationObserver;
    if (Observer && root && typeof root === 'object') {
      observer = new Observer((records) => {
        for (const record of records) {
          for (const node of record.addedNodes ?? []) {
            if (node?.nodeType === 1) apply(node);
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    }
    return api;
  }

  function disconnectObserver() {
    try {
      observer?.disconnect();
    } catch {
      /* ignora */
    }
    observer = null;
  }

  function destroy() {
    disconnectObserver();
    listeners.clear();
  }

  // Pré-carrega o catálogo padrão e sincroniza o documento o quanto antes.
  void load(FALLBACK_LOCALE);
  if (locale !== FALLBACK_LOCALE) void load(locale);
  syncDocumentAttrs();

  const api = {
    get locale() {
      return locale;
    },
    get dir() {
      return LOCALE_DIR[locale] ?? 'ltr';
    },
    supported: SUPPORTED_LOCALES,
    t,
    apply,
    setLocale,
    onChange,
    mount,
    destroy,
  };

  return api;
}
