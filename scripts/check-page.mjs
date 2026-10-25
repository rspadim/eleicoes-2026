// Diagnóstico rápido: abre a página no Chrome headless via CDP e imprime
// erros de console/rede. Uso: node scripts/check-page.mjs [url]
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://localhost:8787/';
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9333;

const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', `--remote-debugging-port=${port}`,
  '--user-data-dir=C:/Users/rober/AppData/Local/Temp/opencode/cdp-profile',
  'about:blank',
], { stdio: 'ignore' });

const stop = () => { try { proc.kill(); } catch { /* ignore */ } };
process.on('exit', stop);

let targets;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await res.json();
    if (targets.length) break;
  } catch { /* ainda subindo */ }
}
if (!targets) { console.log('chrome nao subiu'); process.exit(1); }

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  id += 1;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`[console.${msg.params.type}]`, text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('[exception]', d.text, d.exception?.description ?? '', `@${d.url}:${d.lineNumber}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error') console.log('[log]', e.text, e.url ?? '');
  }
});

await new Promise((r) => ws.once('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(9000);

const { result } = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    kpi: document.querySelector('#kpi-sections')?.textContent,
    mapPaths: document.querySelectorAll('#map path[data-uf]').length,
    bars: document.querySelectorAll('#bars .bar-row').length,
    states: document.querySelectorAll('#states tr').length,
    markets: document.querySelectorAll('#markets .market-row').length,
    movement: document.querySelectorAll('#movement .mv-row').length,
    evo: document.querySelectorAll('#evolution svg path').length,
    status: document.querySelector('#status-text')?.textContent,
  })`,
  returnByValue: true,
});
console.log(result?.value ?? '(sem resultado)');

ws.close();
stop();
process.exit(0);
