/**
 * Minimal standalone Node client for the lichess internal website socket.
 *
 * Proves the reverse-engineered protocol: text/JSON frames, custom ping/pong
 * keep-alive, versioned events. Anonymous by default (no login).
 *
 * Usage:
 *   tsx src/client.ts [path] [seconds] [host]
 *   tsx src/client.ts /socket/v5 15 socket0.lichess.org
 *   tsx src/client.ts /watch/<gameId>/white/v0 30
 *   tsx src/client.ts /lobby/socket/v5 30
 *
 * Env: LICHESS_ORIGIN (set only if you need to match csrf.origin),
 *      LICHESS_VERSION (resume a versioned socket), LICHESS_UA.
 */

import WebSocket from 'ws';
import { decodeFrame, encode, encodePing, SERVER_MESSAGES } from './wire.js';

const path = process.argv[2] ?? '/socket/v5';
const seconds = Number(process.argv[3] ?? 12);
const host = process.argv[4] ?? 'socket0.lichess.org';

// lila-ws `Controller.WebSocket`:
//   CSRF.check  -> 403 when an Origin header is present and != csrf.origin.
//                  Omitting Origin passes (the "new mobile app" path).
//   ValidSri    -> 400 when the `sri` query param is missing.
//                  Sri.from() accepts ANY string without a space; not validated
//                  for anonymous connections.
const params = new URLSearchParams({ from: 'website', sri: randomSri() });
if (process.env.LICHESS_VERSION) params.append('v', process.env.LICHESS_VERSION);
const url = `wss://${host}${path}?${params}`;

function randomSri(): string {
  return Math.random().toString(36).slice(2, 14);
}

console.log(`Connecting to ${url}`);
const headers: Record<string, string> = {
  'User-Agent':
    process.env.LICHESS_UA ??
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
};
// Only set Origin when explicitly requested; otherwise CSRF.check rejects us.
if (process.env.LICHESS_ORIGIN) headers.Origin = process.env.LICHESS_ORIGIN;

const ws = new WebSocket(url, { headers });

let pingTimer: NodeJS.Timeout | undefined;
let lastPingAt = 0;
let lagMillis = 0;

ws.on('open', () => {
  console.log('OPEN');
  pingTimer = setInterval(sendPing, 2500);
  sendPing();
});

ws.on('message', (data, isBinary) => {
  const msg = decodeFrame(isBinary ? (data as Buffer) : data.toString());
  if (msg.kind === 'pong') {
    lagMillis = Date.now() - lastPingAt;
    console.log(`<< PONG  (lag ~${lagMillis}ms)`);
    return;
  }
  if (msg.kind === 'lobby-pong') {
    console.log(`<< LOBBY-PONG members=${msg.members} rounds=${msg.rounds}`);
    return;
  }
  if (msg.kind === 'batch') {
    console.log(`<< BATCH x${msg.messages.length}`);
    return;
  }
  if (msg.kind === 'message') {
    const doc = SERVER_MESSAGES[msg.type] ?? '';
    console.log(
      `<< t=${msg.type}${msg.version !== undefined ? ` v=${msg.version}` : ''} ${doc ? `(${doc})` : ''}\n   ${JSON.stringify(msg.data)?.slice(0, 240)}`,
    );
    return;
  }
  console.log(`<< ${JSON.stringify(msg)}`);
});

ws.on('error', e => console.log(`ERROR ${e.message}`));
ws.on('unexpected-response', (_req, res) => {
  console.log(`UNEXPECTED RESPONSE ${res.statusCode} ${res.statusMessage}`);
  console.log(`  location: ${res.headers.location ?? '(none)'}`);
  res.resume();
});
ws.on('close', (code, reason) => console.log(`CLOSE ${code} ${reason.toString()}`));

let pingCount = 0;
function sendPing(): void {
  lastPingAt = Date.now();
  // The real client sends a bare "p" almost always, and a lag report
  // {"t":"p","l":<deciseconds>} every 10th ping once authenticated.
  const payload = pingCount++ % 10 === 2 ? encode('p', { l: Math.round(0.1 * lagMillis) }) : encodePing();
  ws.send(payload);
}

setTimeout(() => {
  if (pingTimer) clearInterval(pingTimer);
  ws.close();
  setTimeout(() => process.exit(0), 250);
}, seconds * 1000);
