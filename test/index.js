// Agregador para `node --test test/`.
// O Node 21+ trata um diretório passado ao runner como módulo (não varre),
// então este arquivo existe para ser descoberto e disparar os demais. Cada
// *.test.mjs roda em processo próprio, sem herdar NODE_TEST_CONTEXT: o mock
// global de fetch do teste de i18n, por exemplo, não vaza para a API.
// Também funciona direto: `node test/index.js`.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort();

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

/** Roda um arquivo em processo limpo; resolve com o exit code. */
const runFile = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, file)], { stdio: 'inherit', env: childEnv });
    child.on('close', (code) => resolve({ file, code: code ?? 1 }));
  });

test('suite completa', { timeout: 900_000 }, async (t) => {
  const failed = [];
  for (const file of files) {
    const { code } = await runFile(file);
    if (code === 0) t.diagnostic(`ok ${file}`);
    else failed.push(file);
  }
  if (failed.length) throw new Error(`falharam ${failed.length}/${files.length}: ${failed.join(', ')}`);
});
