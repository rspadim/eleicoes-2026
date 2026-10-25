import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://localhost:8787/';
const out = process.argv[3] ?? 'C:/Users/rober/AppData/Local/Temp/opencode/shots/page.png';
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 1600);
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9335;
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--hide-scrollbars', `--window-size=${width},${height}`,
  `--remote-debugging-port=${port}`,
  '--user-data-dir=C:/Users/rober/AppData/Local/Temp/opencode/cdp-profile3',
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
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(9000);
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(out, Buffer.from(data, 'base64'));
console.log(out);
ws.close();
proc.kill();
process.exit(0);
