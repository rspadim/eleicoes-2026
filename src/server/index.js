// Servidor HTTP: estáticos de public/ + API/WS/markets/exterior opcionais.
// Os módulos de outros donos são importados dinamicamente: se ainda não
// existirem, o boot segue e só o estático responde.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize as normPath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, PORT } from '../shared/config.js';
import { openDb } from './db.js';
import bus from './bus.js';
import * as poller from './poller.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '../..');
const PUBLIC_DIR = join(RAIZ, 'public');
const PORT_NUM = Number(process.env.PORT ?? PORT);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve caminho dentro de public/ (bloqueia traversal). */
function resolveStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const rel = normPath(clean).replace(/^[/\\]+/, '');
  // Modulos ESM do front vivem fora de public/.
  const base = rel.replace(/\\/g, '/').startsWith('src/') ? RAIZ : PUBLIC_DIR;
  const full = resolve(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function serveFile(res, file, status = 200) {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // Sem cache: durante a apuracao o front e o JSON mudam a cada ciclo.
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

/** Handler estático com fallback para index.html (SPA). */
function staticHandler(req, res) {
  let file = resolveStatic(req.url ?? '/');
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (existsSync(file) && statSync(file).isFile()) {
    serveFile(res, file);
    return;
  }
  const fallback = join(PUBLIC_DIR, 'index.html');
  if (existsSync(fallback)) {
    serveFile(res, fallback, 200);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404');
}

/** Tenta montar um módulo opcional; nunca derruba o boot. */
async function mount(arquivo, label, server, deps) {
  try {
    const mod = await import(`./${arquivo}`);
    if (typeof mod.attach === 'function') await mod.attach(server, deps);
    else if (typeof mod.start === 'function') await mod.start(deps);
    else if (typeof mod.default?.attach === 'function') await mod.default.attach(server, deps);
    else if (typeof mod.default?.start === 'function') await mod.default.start(deps);
    else return null;
    return mod;
  } catch (err) {
    console.log(`[server] ${label} indisponivel: ${err?.message ?? err}`);
    return null;
  }
}

/** Cria servidor, abre banco e sobe as rotas/coletas. */
export async function createApp(options = {}) {
  const dbPath = options.dbPath ?? DB_PATH;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = options.db ?? openDb(dbPath);

  const server = createServer((req, res) => {
    try {
      staticHandler(req, res);
    } catch (err) {
      bus.emit('error', { code: 'http', message: err?.message ?? String(err) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('500');
    }
  });

  // Anexa as rotas dinâmicas antes de escutar (nada de requisição sem rota).
  const deps = { db, dbPath, bus };
  // Listener de 'error' sempre presente: sem ele o EventEmitter lança em vez
  // de só logar uma falha de coleta.
  const logBusError = (e) => console.log(`[bus] ${e?.code ?? 'erro'} ${e?.scope ?? ''} ${e?.message ?? ''}`.trim());
  bus.on('error', logBusError);
  // Cada attach embrulha o handler anterior e checa a rota antes dele, então
  // os módulos mais específicos (exterior, derivados) entram por último.
  await mount('api.js', 'api', server, deps);
  await mount('ws.js', 'ws', server, deps);
  const exterior = await mount('exterior.js', 'exterior', server, deps);
  await mount('movement.js', 'movement', server, deps);
  await mount('evolution.js', 'evolution', server, deps);
  const markets = await mount('markets.js', 'markets', server, deps);

  poller.start({ db });
  const exteriorPoller = await mount('exterior-poller.js', 'exterior-poller', server, deps);

  const shutdown = async () => {
    await poller.stop();
    await exteriorPoller?.stop?.();
    await markets?.stop?.();
    exterior?.dispose?.();
    bus.off('error', logBusError);
    if (!options.db) {
      try { db.close(); } catch { /* ja fechado */ }
    }
  };

  return { server, db, shutdown };
}

async function main() {
  const { server, shutdown } = await createApp();
  const url = `http://localhost:${PORT_NUM}`;

  server.on('error', (err) => {
    console.error(`[server] falha ao escutar: ${err?.message ?? err}`);
    process.exit(1);
  });
  server.listen(PORT_NUM, HOST, () => console.log(`[server] ouvindo em ${url}`));

  let fechando = false;
  const encerrar = async (sinal) => {
    if (fechando) return;
    fechando = true;
    console.log(`[server] ${sinal}: encerrando`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await shutdown();
      await new Promise((r) => server.close(r));
    } catch (err) {
      console.log(`[server] erro no shutdown: ${err?.message ?? err}`);
    }
    clearTimeout(force);
    process.exit(0);
  };

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export default main;
