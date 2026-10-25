import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9336;
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--window-size=1500,1200', `--remote-debugging-port=${port}`,
  '--user-data-dir=C:/Users/rober/AppData/Local/Temp/opencode/cdp-audit', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { proc.kill(); } catch { /* ignore */ } });

let targets;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch { /* subindo */ }
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const erros = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') erros.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') erros.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
});
await new Promise((r) => ws.once('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

for (const path of ['/', '/exterior.html']) {
  erros.length = 0;
  await send('Page.navigate', { url: `http://localhost:8787${path}` });
  await sleep(8000);
  const { result } = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      path: ${JSON.stringify(path)},
      title: document.title,
      h: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      hasNaN: /NaN|undefined|null%/.test(document.body.innerText),
      texts: [...document.querySelectorAll('h1,h2,.kpi-label,.mv-col-head')].slice(0,8).map(e => e.innerText),
    })`,
    returnByValue: true,
  });
  console.log(result.value);
  console.log('erros:', erros.length ? erros.slice(0, 4) : 'nenhum');
}

ws.close();
proc.kill();
process.exit(0);
