// Polyfill mínimo de `process` para módulos compartilhados com o servidor.
// config.js lê process.env no topo, então este import precisa vir ANTES dele.

const global = globalThis;

if (!global.process || typeof global.process !== 'object') {
  global.process = { env: {} };
} else if (!global.process.env || typeof global.process.env !== 'object') {
  global.process.env = {};
}

export default global.process;
