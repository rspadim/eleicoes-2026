import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8787/ws');
const timer = setTimeout(() => { console.log('timeout'); process.exit(1); }, 8000);
ws.on('open', () => console.log('aberto'));
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  console.log('msg', msg.type, msg.state ? `pct=${msg.state.national?.pct} ufs=${Object.keys(msg.state.ufs ?? {}).length}` : '');
  if (msg.type === 'hello') {
    ws.send(JSON.stringify({ type: 'seek', t: Date.now() - 300000 }));
  }
  if (msg.type === 'replayState') {
    console.log('replay', JSON.stringify(msg.replay).slice(0, 160));
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('erro', e.message); process.exit(1); });
