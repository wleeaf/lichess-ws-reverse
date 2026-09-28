/**
 * Analyze a JSONL capture produced by src/capture.ts.
 *
 * Usage: tsx src/analyze.ts captures/<file>.jsonl
 */

import { readFileSync } from 'node:fs';
import { decodeFrame, type WireMessage } from './wire.js';

interface FrameRecord {
  ts: number;
  url: string;
  direction: 'sent' | 'received';
  length: number;
  encoding: 'text' | 'binary';
  data: string;
}

if (process.argv.length < 3) {
  console.error('usage: tsx src/analyze.ts <capture.jsonl>');
  process.exit(1);
}

const lines = readFileSync(process.argv[2]!, 'utf8')
  .split('\n')
  .filter(Boolean);
const frames: FrameRecord[] = lines.map(l => JSON.parse(l));

const endpoints = new Map<string, { sent: number; received: number; bytes: number; binary: number }>();
const sentTypes = new Map<string, number>();
const recvTypes = new Map<string, number>();
const recvVersions = new Map<string, number[]>();
const samples = new Map<string, string>();
let binaryFrames = 0;
const binarySamples: string[] = [];

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function classify(msg: WireMessage): { tag: string; dir: 'sent' | 'received' } | null {
  switch (msg.kind) {
    case 'pong':
      return { tag: 'pong ("0")', dir: 'received' };
    case 'ping':
      return { tag: msg.lagDeciseconds !== undefined ? 'ping (with lag)' : 'ping ("p")', dir: 'sent' };
    case 'lobby-pong':
      return { tag: 'lobby-pong ("n")', dir: 'received' };
    case 'batch':
      return { tag: `batch x${msg.messages.length}`, dir: 'received' };
    case 'message':
      return { tag: msg.type, dir: 'received' };
    case 'raw-binary':
    case 'unknown':
      return null;
  }
}

for (const f of frames) {
  const ep = endpoints.get(endpointOf(f.url)) ?? { sent: 0, received: 0, bytes: 0, binary: 0 };
  if (f.direction === 'sent') ep.sent++;
  else ep.received++;
  ep.bytes += f.length;
  if (f.encoding === 'binary') {
    ep.binary++;
    binaryFrames++;
    if (binarySamples.length < 10) binarySamples.push(`${endpointOf(f.url)} ${f.direction} ${f.data.slice(0, 64)}`);
  }
  endpoints.set(endpointOf(f.url), ep);

  const raw: string | Buffer = f.encoding === 'binary' ? Buffer.from(f.data, 'base64') : f.data;
  const msg = decodeFrame(raw);

  // For client-sent frames, parse the "t" field directly when possible.
  if (f.direction === 'sent') {
    const c = classifyFromRaw(f.data);
    bump(sentTypes, c);
  } else {
    const c = classify(msg);
    if (c) bump(recvTypes, c.tag);
    if (f.data === 'p') bump(sentTypes, 'ping ("p")');
    if (f.data === '0') bump(recvTypes, 'pong ("0")');
  }

  if (msg.kind === 'message' && msg.version !== undefined) {
    const arr = recvVersions.get(msg.type) ?? [];
    arr.push(msg.version);
    recvVersions.set(msg.type, arr);
  }

  if (f.direction === 'received' && msg.kind === 'message' && msg.data !== undefined && !samples.has(msg.type)) {
    samples.set(msg.type, JSON.stringify(msg.data).slice(0, 300));
  }
  if (msg.kind === 'unknown' && !samples.has('(unknown)')) samples.set('(unknown)', msg.raw.slice(0, 200));
}

function classifyFromRaw(text: string): string {
  if (text === 'p') return 'ping ("p")';
  if (text === 'null') return 'ping (null)';
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    return typeof o.t === 'string' ? `sent:${o.t}` : 'sent:?';
  } catch {
    return 'sent:non-json';
  }
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const line = (a: string, b: string | number, c?: string): string =>
  `  ${pad(a, 26)} ${pad(String(b), 8)}${c ? '  ' + c : ''}`;

console.log(`\n=== CAPTURE SUMMARY (${frames.length} frames) ===`);
console.log(`Binary frames: ${binaryFrames === 0 ? 'NONE — the socket is text/JSON' : binaryFrames}`);

console.log('\nEndpoints:');
for (const [ep, s] of endpoints) {
  console.log(line(ep, `${s.sent}↑/${s.received}↓`, `${s.bytes} bytes${s.binary ? `, ${s.binary} binary` : ''}`));
}

console.log('\nServer -> client message types:');
[...recvTypes.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
  const vs = recvVersions.get(t);
  const v = vs && vs.length ? `v: ${vs[0]}..${vs[vs.length - 1]}` : '';
  console.log(line(t, n, v));
});

console.log('\nClient -> server message types:');
[...sentTypes.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(line(t, n)));

console.log('\nSample payloads (server -> client):');
for (const [t, s] of samples) console.log(`  ${t}: ${s}`);

if (binarySamples.length) {
  console.log('\nBinary samples:');
  binarySamples.forEach(s => console.log('  ' + s));
}
console.log();
