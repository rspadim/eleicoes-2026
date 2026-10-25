import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createI18n, normalizeLocale, detectLocale, SUPPORTED_LOCALES } from '../src/web/lib/i18n.js';

const catalogs = {
  'pt-BR': { 'greet.hello': 'Olá', 'only.pt': 'Só em português', 'votes.count': '{n} votos' },
  en: { 'greet.hello': 'Hello', 'votes.count': '{n} votes' },
  es: { 'greet.hello': 'Hola', 'votes.count': '{n} votos' },
};

/* ------------------------------------------------------------------ ambiente */

function fakeNode(attrs = {}) {
  const el = {
    nodeType: 1,
    textContent: '',
    attrs: { ...attrs },
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
  return el;
}

function fakeDocument(nodes = []) {
  const html = fakeNode({});
  return {
    documentElement: html,
    querySelectorAll: () => nodes,
  };
}

function installGlobals({ language = 'pt-BR', nodes = [], fail } = {}) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language, languages: [language] },
    configurable: true,
    writable: true,
  });

  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    configurable: true,
    writable: true,
  });

  const calls = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      calls.push(String(url));
      const locale = String(url).split('/').pop().replace('.json', '');
      if (fail?.includes(locale)) return { ok: false, json: async () => ({}) };
      const data = catalogs[locale];
      if (!data) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => data };
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument(nodes),
    configurable: true,
    writable: true,
  });

  return { store, calls };
}

const saved = {
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  document: globalThis.document,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

let env;
beforeEach(() => {
  env = installGlobals();
});

/* --------------------------------------------------------------------- testes */

test('normalizeLocale mapeia etiquetas BCP-47 conhecidas', () => {
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('es-419'), 'es');
  assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
  assert.equal(normalizeLocale('PT-br'), 'pt-BR');
  assert.equal(normalizeLocale('fr-FR'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
});

test('detectLocale usa navigator.language com mock', () => {
  assert.equal(detectLocale(), 'pt-BR');
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-GB', languages: ['en-GB'] },
    configurable: true,
    writable: true,
  });
  assert.equal(detectLocale(), 'en');
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'es-MX', languages: ['es-MX'] },
    configurable: true,
    writable: true,
  });
  assert.equal(detectLocale(), 'es');
});

test('detectLocale ignora idioma não suportado e cai no padrão', () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'ja-JP', languages: ['ja-JP'] },
    configurable: true,
    writable: true,
  });
  assert.equal(detectLocale(), 'pt-BR');
});

test('detectLocale prioriza o locale salvo sobre o navegador', () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', languages: ['en-US'] },
    configurable: true,
    writable: true,
  });
  globalThis.localStorage.setItem('locale', 'es');
  assert.equal(detectLocale(), 'es');
});

test('traduz a chave no idioma atual', async () => {
  env = installGlobals({ language: 'en-US' });
  const i18n = createI18n({ defaultLocale: 'en' });
  assert.equal(i18n.locale, 'en', 'navigator.language define o idioma inicial');
  await i18n.setLocale('en');
  assert.equal(i18n.t('greet.hello'), 'Hello');
});

test('chave inexistente cai para a própria chave', async () => {
  const i18n = createI18n();
  await i18n.setLocale('en');
  assert.equal(i18n.t('nao.existe.mesmo'), 'nao.existe.mesmo');
  assert.equal(i18n.t(''), '');
});

test('cascata: chave ausente no locale atual usa pt-BR', async () => {
  const i18n = createI18n();
  await i18n.setLocale('en');
  assert.equal(i18n.t('only.pt'), 'Só em português');
});

test('interpolação substitui {var} preservando ausentes', async () => {
  const i18n = createI18n();
  await i18n.setLocale('en');
  assert.equal(i18n.t('votes.count', { n: 1234 }), '1234 votes');
  assert.equal(i18n.t('votes.count', {}), '{n} votes');
  assert.equal(i18n.t('votes.count', { n: 0 }), '0 votes');
});

test('cascata de catálogo: locale atual -> pt-BR -> chave', async () => {
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      if (String(url).endsWith('/es.json')) return { ok: true, json: async () => ({ 'greet.hello': 'Hola' }) };
      if (String(url).endsWith('/pt-BR.json')) {
        return { ok: true, json: async () => ({ 'greet.hello': 'Olá', 'only.pt': 'Só em português' }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    configurable: true,
    writable: true,
  });
  const i18n = createI18n();
  await i18n.setLocale('es');
  assert.equal(i18n.t('greet.hello'), 'Hola');
  assert.equal(i18n.t('only.pt'), 'Só em português');
  assert.equal(i18n.t('sumiu.total'), 'sumiu.total');
});

test('setLocale persiste, atualiza html lang/dir e notifica onChange', async () => {
  const i18n = createI18n();
  const seen = [];
  i18n.onChange((l) => seen.push(l));
  await i18n.setLocale('en');
  assert.equal(globalThis.localStorage.getItem('locale'), 'en');
  assert.equal(globalThis.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(globalThis.document.documentElement.getAttribute('dir'), 'ltr');
  assert.deepEqual(seen, ['en']);
  await i18n.setLocale('en');
  assert.deepEqual(seen, ['en'], 'repetir o mesmo idioma não notifica');
});

test('locale desconhecido em setLocale volta ao padrão', async () => {
  const i18n = createI18n();
  await i18n.setLocale('en');
  await i18n.setLocale('xx-YY');
  assert.equal(i18n.locale, 'pt-BR');
});

test('onChange devolve cancelamento', async () => {
  const i18n = createI18n();
  const seen = [];
  const off = i18n.onChange((l) => seen.push(l));
  await i18n.setLocale('es');
  off();
  await i18n.setLocale('en');
  assert.deepEqual(seen, ['es']);
});

test('apply escreve textContent, title, aria-label e placeholder sem innerHTML', async () => {
  const nodes = [
    fakeNode({ 'data-i18n': 'greet.hello' }),
    fakeNode({ 'data-i18n-title': 'greet.hello' }),
    fakeNode({ 'data-i18n-aria': 'greet.hello' }),
    fakeNode({ 'data-i18n-placeholder': 'greet.hello' }),
    fakeNode({ 'data-i18n': 'votes.count', 'data-i18n-vars': '{"n":42}' }),
  ];
  env = installGlobals({ nodes });
  const i18n = createI18n();
  await i18n.setLocale('es');

  i18n.apply(globalThis.document);
  assert.equal(nodes[0].textContent, 'Hola');
  assert.equal(nodes[1].getAttribute('title'), 'Hola');
  assert.equal(nodes[2].getAttribute('aria-label'), 'Hola');
  assert.equal(nodes[3].getAttribute('placeholder'), 'Hola');
  assert.equal(nodes[4].textContent, '42 votos');
  for (const node of nodes) assert.equal('innerHTML' in node, false);
});

test('mount aplica no root e define lang no boot', async () => {
  const root = fakeNode({});
  root.querySelectorAll = () => [fakeNode({ 'data-i18n': 'greet.hello' })];
  const i18n = createI18n();
  await i18n.setLocale('en');
  i18n.mount(root);
  assert.equal(globalThis.document.documentElement.getAttribute('lang'), 'en');
  i18n.destroy();
});

test('paridade: todos os locales têm as mesmas chaves que pt-BR', async () => {
  const base = JSON.parse(await readFile(new URL('../public/locales/pt-BR.json', import.meta.url), 'utf8'));
  const baseKeys = Object.keys(base).sort();
  assert.ok(baseKeys.length >= 100, `esperado ~120 chaves, encontrado ${baseKeys.length}`);

  for (const locale of SUPPORTED_LOCALES.slice(1)) {
    const dict = JSON.parse(await readFile(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(dict).sort(), baseKeys, `chaves divergentes em ${locale}`);

    for (const key of baseKeys) {
      assert.equal(typeof dict[key], 'string', `${locale}:${key} deve ser string`);
      assert.ok(dict[key].trim().length > 0, `${locale}:${key} vazio`);

      const baseVars = [...base[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const vars = [...dict[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(vars, baseVars, `${locale}:${key} diverge nos placeholders`);
    }
  }
});
