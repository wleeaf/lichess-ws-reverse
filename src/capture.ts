/**
 * Capture lichess.org WebSocket traffic with Playwright.
 *
 * Attaches to every WebSocket the page opens, logs every frame (direction,
 * size, text or base64) as JSONL, and live-decodes it with src/wire.ts.
 *
 * Usage:
 *   tsx src/capture.ts [url] [seconds] [outfile]
 *   HEADFUL=1 tsx src/capture.ts                 # show the browser
 *   CHROME_PATH=/path/to/chrome tsx src/capture.ts
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { decodeFrame, type WireMessage } from './wire.js';

const url = process.argv[2] ?? 'https://lichess.org';
const seconds = Number(process.argv[3] ?? 25);
const outFile = process.argv[4] ?? join('captures', `lichess-${Date.now()}.jsonl`);

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

interface FrameRecord {
  ts: number;
  url: string;
  direction: 'sent' | 'received';
  length: number;
  encoding: 'text' | 'binary';
  data: string;
}

function iso(): string {
  return new Date().toISOString();
}

function describe(msg: WireMessage): string {
  switch (msg.kind) {
    case 'pong':
      return 'PONG (bare "0")';
    case 'ping':
      return `PING${msg.lagDeciseconds !== undefined ? ` lag=${msg.lagDeciseconds}ds` : ''}`;
    case 'lobby-pong':
      return `LOBBY-PONG members=${msg.members} rounds=${msg.rounds}`;
    case 'batch':
      return `BATCH x${msg.messages.length}`;
    case 'raw-binary':
      return `BINARY ${msg.bytes.length}B ${msg.bytes.subarray(0, 32).toString('hex')}`;
    case 'message':
      return `MSG t=${msg.type}${msg.version !== undefined ? ` v=${msg.version}` : ''} d=${truncate(JSON.stringify(msg.data), 160)}`;
    case 'unknown':
      return `UNKNOWN ${JSON.stringify(truncate(msg.raw, 120))}`;
  }
}

const truncate = (s: string | undefined, n: number): string =>
  s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + '…' : s;

async function main(): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, '');

  const executablePath = findChrome();
  const browser: Browser = await chromium.launch({
    headless: !process.env.HEADFUL,
    executablePath,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page: Page = await context.newPage();

  let sockets = 0;
  const seen = new Map<string, number>();

  page.on('websocket', ws => {
    sockets++;
    const wsUrl = ws.url();
    console.log(`\n[${iso()}] WS#${sockets} ${wsUrl}`);

    const record = (direction: 'sent' | 'received', payload: string | Buffer): void => {
      const isText = typeof payload === 'string';
      const text = isText ? payload : payload.toString('utf8');
      const rec: FrameRecord = {
        ts: Date.now(),
        url: wsUrl,
        direction,
        length: isText ? Buffer.byteLength(text) : payload.length,
        encoding: isText ? 'text' : 'binary',
        data: isText ? text : payload.toString('base64'),
      };
      appendFileSync(outFile, JSON.stringify(rec) + '\n');

      const arrow = direction === 'received' ? '<<' : '>>';
      console.log(`  ${arrow} ${describe(decodeFrame(payload))}`);
      const key = `${direction}:${text.slice(0, 40)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    };

    ws.on('framesent', e => record('sent', e.payload));
    ws.on('framereceived', e => record('received', e.payload));
    ws.on('close', () => console.log(`  -- closed ${wsUrl}`));
  });

  page.on('console', m => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });

  console.log(`Opening ${url} (headless=${!process.env.HEADFUL}) for ${seconds}s...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
    console.log(`navigation: ${e.message}`);
  });

  await new Promise(r => setTimeout(r, seconds * 1000));
  await browser.close();

  console.log(`\nCaptured ${sockets} websocket(s). Wrote ${outFile}`);
  const total = [...seen.values()].reduce((a, b) => a + b, 0);
  console.log(`Frames: ${total}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
