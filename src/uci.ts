/**
 * Minimal UCI engine wrapper (spawns a Stockfish-compatible binary).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

interface Waiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
}

export class UciEngine {
  private proc: ChildProcessWithoutNullStreams;
  private waiters: Waiter[] = [];
  private ready: Promise<void>;

  constructor(
    readonly path: string,
    private readonly log = false,
  ) {
    this.proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', line => this.onLine(line));
    this.proc.stderr.on('data', d => {
      if (this.log) process.stderr.write(`[engine] ${d}`);
    });
    this.proc.on('exit', code => {
      if (code) console.error(`engine exited with code ${code}`);
    });
    this.ready = this.init();
  }

  private onLine(line: string): void {
    if (this.log) console.log(`[engine] ${line}`);
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i]!.match(line)) {
        const w = this.waiters.splice(i, 1)[0]!;
        w.resolve(line);
        return;
      }
    }
  }

  private waitFor(match: (line: string) => boolean): Promise<string> {
    return new Promise(resolve => this.waiters.push({ match, resolve }));
  }

  private send(cmd: string): void {
    this.proc.stdin.write(cmd + '\n');
  }

  private async init(): Promise<void> {
    this.send('uci');
    await this.waitFor(l => l === 'uciok');
    this.send('isready');
    await this.waitFor(l => l === 'readyok');
  }

  async setOption(name: string, value: string | number): Promise<void> {
    this.send(`setoption name ${name} value ${value}`);
    this.send('isready');
    await this.waitFor(l => l === 'readyok');
  }

  async newGame(): Promise<void> {
    this.send('ucinewgame');
    this.send('isready');
    await this.waitFor(l => l === 'readyok');
  }

  /** Returns the best move in UCI (e.g. "e2e4", "e7e8q", "0000"). */
  async bestMove(fen: string, movetimeMs: number): Promise<string> {
    await this.ready;
    this.send('position fen ' + fen);
    this.send(`go movetime ${Math.max(20, Math.round(movetimeMs))}`);
    const line = await this.waitFor(l => l.startsWith('bestmove'));
    const move = line.split(/\s+/)[1] ?? '0000';
    return move;
  }

  quit(): void {
    try {
      this.send('quit');
    } catch {
      /* already gone */
    }
    setTimeout(() => this.proc.kill(), 200);
  }
}

/** Find a Stockfish binary from common locations. */
export function findEngine(): string | undefined {
  const candidates = [
    process.env.STOCKFISH,
    'vendor/stockfish/stockfish-linux-x86-64-universal',
    'vendor/stockfish/stockfish',
    '/usr/bin/stockfish',
    '/usr/local/bin/stockfish',
    'stockfish',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === 'stockfish') return c;
    if (existsSync(c)) return c;
  }
  return undefined;
}
