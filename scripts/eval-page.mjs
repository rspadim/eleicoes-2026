import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://localhost:8787/';
const expr = process.argv[3] ?? 'document.body.innerText.slice(0,2000)';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9334;
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  `--remote-debugging-port=${port}`,
  '--user-data-dir=C:/Users/rober/AppData/Local/Temp/opencode/cdp-profile2',
  'about:blank',
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
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
await new Promise((r) => ws.once('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(9000);
const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(typeof result?.value === 'string' ? result.value : JSON.stringify(result?.value, null, 2));
ws.close();
proc.kill();
process.exit(0);
