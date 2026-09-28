/**
 * Play lichess anonymously through the internal WebSocket.
 *
 * Modes:
 *   tsx src/play.ts ai  [level] [color] [minutes]   vs server Stockfish (safe)
 *   tsx src/play.ts hook [minutes] [increment]      vs a human (real lobby game)
 *   tsx src/play.ts accept <challenge-url>          accept a "play with a friend" link
 *
 * Example — play the Nezhmetdinov model against you:
 *   # create the friend link in your browser, then:
 *   npm run play -- accept https://lichess.org/XXXXXXXX --engine /path/to/uci-engine --as black
 *
 * Commands while playing:
 *   <uci>        e.g. e2e4, e7e8q, or "e2 e4"
 *   moves        list legal moves
 *   resign | draw | abort | quit
 *
 * Flags:
 *   --engine [path]     local Stockfish plays our side (auto-detects vendor/stockfish)
 *   --movetime <ms>     engine thinking time per move (default 300)
 *   --games <n>         play n engine games, alternating colors
 *   --script a,b,c      play a fixed move list instead of stdin
 *   --quiet             suppress board/clock spam (keep results)
 *
 * Examples:
 *   tsx src/play.ts ai 8 white 3 --engine --movetime 200 --games 4 --quiet
 *   STOCKFISH=/usr/bin/stockfish tsx src/play.ts ai 8 --engine
 *
 * Notes:
 *   - anonymous games are always unrated/casual
 *   - --engine is only allowed in ai mode; never drive it against humans
 *     (use the official Bot API https://lichess.org/api#tag/Bot for bots)
 */

import { Chess, type Square } from 'chess.js';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import {
  acceptChallenge,
  createAiGame,
  createHook,
  parseChallengeId,
  pickSocketHost,
  randomSri,
  type NewGame,
} from './lichess.js';
import { findEngine, UciEngine } from './uci.js';
import { decodeFrame, encode, encodePing } from './wire.js';

interface Args {
  mode: 'ai' | 'hook' | 'accept';
  level: number;
  color: 'white' | 'black' | 'random';
  time: number;
  increment: number;
  script?: string[];
  enginePath?: string; // undefined = none, '' = auto-detect
  movetime: number;
  games: number;
  quiet: boolean;
  challenge?: string; // accept mode: challenge URL or id
  acceptColor?: 'white' | 'black';
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const mode = (['hook', 'accept'].includes(argv[0] ?? '') ? argv[0] : 'ai') as Args['mode'];
  const rest = argv.slice(1);
  const positional: string[] = [];
  let script: string[] | undefined;
  let enginePath: string | undefined;
  let movetime = 300;
  let games = 1;
  let quiet = false;
  let acceptColor: 'white' | 'black' | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--script') {
      script = (rest[++i] ?? '').split(',').filter(Boolean);
    } else if (a === '--engine') {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        enginePath = next;
        i++;
      } else enginePath = '';
    } else if (a === '--movetime') {
      movetime = Number(rest[++i] ?? 300);
    } else if (a === '--games') {
      games = Math.max(1, Number(rest[++i] ?? 1));
    } else if (a === '--quiet') {
      quiet = true;
    } else if (a === '--as') {
      const c = rest[++i];
      if (c === 'white' || c === 'black') acceptColor = c;
    } else {
      positional.push(a);
    }
  }

  const base = { script, enginePath, movetime, games, quiet };
  if (mode === 'accept') {
    return {
      ...base,
      mode,
      level: 3,
      color: acceptColor ?? 'black',
      time: 5,
      increment: 3,
      challenge: positional[0],
      acceptColor,
    };
  }
  if (mode === 'hook') {
    return { ...base, mode, level: 3, color: 'random', time: Number(positional[0] ?? 3), increment: Number(positional[1] ?? 0) };
  }
  return {
    ...base,
    mode,
    level: Number(positional[0] ?? 3),
    color: (positional[1] as Args['color']) ?? 'white',
    time: Number(positional[2] ?? 5),
    increment: 0,
  };
}

/** Promotion piece from a `move` event: `promotion` field or the SAN suffix. */
function promotionOf(d: any): string | undefined {
  const valid = (s: unknown): string | undefined =>
    typeof s === 'string' && /^[qrbn]/i.test(s) ? s[0]!.toLowerCase() : undefined;
  const direct =
    (typeof d?.promotion === 'string' ? d.promotion : undefined) ??
    (d?.promotion && typeof d.promotion === 'object'
      ? d.promotion.key ?? d.promotion.role ?? d.promotion.name
      : undefined);
  const fromField = valid(direct);
  if (fromField) return fromField;
  if (typeof d?.san === 'string') {
    const m = /=([qrbn])/i.exec(d.san);
    if (m) return m[1]!.toLowerCase();
  }
  return undefined;
}

const PIECES: Record<string, string> = { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' };

function renderBoard(chess: Chess, ourColor: 'white' | 'black' | undefined): string {
  const rows = chess.board();
  const flip = ourColor === 'black';
  const ordered = flip ? [...rows].reverse() : rows;
  const lines: string[] = [];
  for (let r = 0; r < 8; r++) {
    const rank = flip ? r + 1 : 8 - r;
    const cells = (flip ? [...ordered[r]!].reverse() : ordered[r]!).map(c =>
      c ? (c.color === 'w' ? PIECES[c.type]!.toUpperCase() : PIECES[c.type]) : '.',
    );
    lines.push(`${rank}  ${cells.join(' ')}`);
  }
  const files = flip ? 'h g f e d c b a' : 'a b c d e f g h';
  lines.push(`   ${files}`);
  return lines.join('\n');
}

class RoundClient {
  private ws?: WebSocket;
  private chess = new Chess();
  private ourColor?: 'white' | 'black';
  private version = 0;
  private pingTimer?: NodeJS.Timeout;
  private lastMove = '';
  private ended = false;
  private listeners: ((line: string) => void)[] = [];
  private pendingEcho: string[] = [];
  private readonly quiet: boolean;
  private endResolve?: () => void;
  private readonly endPromise = new Promise<void>(r => {
    this.endResolve = r;
  });

  public winner?: 'white' | 'black';
  public status?: string;

  constructor(
    private readonly fullId: string,
    private readonly startVersion: number,
    opts: { quiet?: boolean } = {},
  ) {
    this.quiet = !!opts.quiet;
  }

  private log(...args: unknown[]): void {
    if (!this.quiet) console.log(...args);
  }

  get fen(): string {
    return this.chess.fen();
  }

  async connect(): Promise<void> {
    const host = pickSocketHost();
    const sri = randomSri();
    const url = `wss://${host}/play/${this.fullId}/v6?from=website&sri=${sri}&v=${this.startVersion}`;
    console.log(`\nConnecting to ${url}`);
    this.ws = new WebSocket(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      },
    });
    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => resolve());
      this.ws!.on('error', reject);
      this.ws!.on('unexpected-response', (_r, res) =>
        reject(new Error(`socket upgrade failed: ${res.statusCode}`)),
      );
    });
    console.log('Connected.');
    this.pingTimer = setInterval(() => this.ws?.send(encodePing()), 2500);
    this.ws.on('message', (data, isBinary) =>
      this.onMessage(decodeFrame(isBinary ? (data as Buffer) : data.toString())),
    );
    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`\nSocket closed ${code} ${reason.toString()}`);
      if (this.pingTimer) clearInterval(this.pingTimer);
    });
  }

  setColor(c: 'white' | 'black'): void {
    this.ourColor = c;
  }

  get color(): 'white' | 'black' | undefined {
    return this.ourColor;
  }

  private onMessage(msg: ReturnType<typeof decodeFrame>): void {
    if (msg.kind === 'pong' || msg.kind === 'lobby-pong') return;
    if (msg.kind === 'batch') {
      msg.messages.forEach(m => this.onMessage(m));
      return;
    }
    if (msg.kind !== 'message') {
      console.log(`[socket] ${JSON.stringify(msg)}`);
      return;
    }
    if (msg.version !== undefined) {
      if (msg.version <= this.version) return;
      this.version = msg.version;
    }
    const d: any = msg.data;
    switch (msg.type) {
      case 'crowd':
        this.log(`[crowd] white:${!!d.white} black:${!!d.black} watchers:${d.watchers?.nb ?? 0}`);
        break;
      case 'move':
      case 'drop': {
        // lichess `uci` is orig+dest only (no promotion piece) and castling is
        // king-to-rook; canonicalize before matching our pending echo.
        const uci = msg.type === 'move' ? d.uci : `${d.role}@${d.pos}`;
        const key = msg.type === 'move' ? this.canonicalUci(uci) : uci;
        if (this.pendingEcho[0] === key) {
          this.pendingEcho.shift();
        } else if (msg.type === 'move') {
          if (process.env.DEBUG_SYNC)
            console.log(`[dbg] mismatch uci=${uci} key=${key} pending=${JSON.stringify(this.pendingEcho)}`);
          this.applyServerMove(uci, promotionOf(d));
        }
        this.lastMove = msg.type === 'move' ? d.san : `${d.role}@${d.pos}`;
        if (d.dests && !this.ourColor) {
          this.ourColor = d.ply % 2 === 0 ? 'white' : 'black';
        }
        if (d.clock && !this.quiet) this.log(`[clock] white:${d.clock.white} black:${d.clock.black}`);
        this.render();
        this.promptIfTurn();
        break;
      }
      case 'endData':
        this.ended = true;
        this.winner = d?.winner;
        this.status = d?.status?.name ?? d?.status;
        this.log(`\n[game over] winner=${this.winner ?? '-'} status=${this.status ?? '?'} ${JSON.stringify(d).slice(0, 200)}`);
        this.endResolve?.();
        this.emit('end');
        break;
      case 'resync':
        this.log('\n[resync] server asked to resync');
        break;
      case 'gone':
        this.log(`\n[opponent ${d ? 'left' : 'returned'}]`);
        break;
      case 'goneIn':
        this.log(`\n[opponent will be gone in ${d}s]`);
        break;
      case 'takebackOffers':
        this.log(`[takeback] ${JSON.stringify(d)}`);
        break;
      case 'drawOffer':
        this.log(`[draw offer] by ${d ?? 'opponent'}`);
        break;
      case 'ack':
        break;
      default:
        this.log(`[${msg.type}] ${JSON.stringify(d)?.slice(0, 200)}`);
    }
  }

  /**
   * Canonical orig+dest. lichess encodes castling as king-to-rook (e1h1/e1a1,
   * e8h8/e8a8); normalize to chess.js king-two-squares (e1g1/e1c1, ...).
   * Must NOT depend on the current board, because we canonicalize our own move
   * echo after having already applied that move locally.
   */
  private canonicalUci(uci: string): string {
    const from = uci.slice(0, 2);
    let to = uci.slice(2, 4);
    if (
      (from === 'e1' || from === 'e8') &&
      (to === 'h1' || to === 'a1' || to === 'h8' || to === 'a8')
    ) {
      to = (to[0] === 'h' ? 'g' : 'c') + from[1];
    }
    return from + to;
  }

  private applyServerMove(uci: string, promotion?: string): void {
    const from = uci.slice(0, 2);
    const to = this.canonicalUci(uci).slice(2, 4);
    const piece = this.chess.get(from as Square);
    // promotion piece may be absent/invalid in `uci`; fall back to queen on the last rank
    const promo =
      promotion && 'qrbn'.includes(promotion)
        ? promotion
        : piece?.type === 'p' && (to[1] === '8' || to[1] === '1')
          ? 'q'
          : undefined;
    try {
      this.chess.move({ from, to, promotion: promo });
    } catch {
      console.log(
        `[warn] could not apply move ${uci} (promo=${promo ?? '-'}) turn=${this.chess.turn()} fen=${this.chess.fen()}`,
      );
    }
  }

  private render(): void {
    if (this.quiet) return;
    console.log(
      `\n${this.lastMove ? `last: ${this.lastMove}  ` : ''}turn: ${this.chess.turn() === 'w' ? 'white' : 'black'}`,
    );
    console.log(renderBoard(this.chess, this.ourColor));
  }

  private isOurTurn(): boolean {
    if (this.ended || !this.ourColor) return false;
    return (this.chess.turn() === 'w' ? 'white' : 'black') === this.ourColor;
  }

  private promptIfTurn(): void {
    if (this.isOurTurn()) this.emit('your move');
  }

  private emit(line: string): void {
    const listeners = this.listeners;
    this.listeners = [];
    listeners.forEach(l => l(line));
  }

  /** Resolves with the next input line when it is our turn. */
  nextTurn(): Promise<string> {
    if (this.isOurTurn()) return Promise.resolve('your move');
    return new Promise(resolve => this.listeners.push(resolve));
  }

  send(type: string, data?: unknown): void {
    this.ws?.send(encode(type, data));
  }

  sendMove(uci: string): void {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.slice(4, 5);
    const move = this.chess.move(promotion ? { from, to, promotion } : { from, to });
    if (!move) {
      console.log(`[illegal] ${uci}`);
      return;
    }
    this.lastMove = move.san;
    const outUci = move.from + move.to + (move.promotion ?? '');
    this.pendingEcho.push(move.from + move.to); // echo key: no promotion piece
    this.log(`>> ${move.san} (${outUci})`);
    this.send('move', { u: outUci });
  }

  legalMoves(): string[] {
    return this.chess.moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
  }

  get finished(): boolean {
    // server is authoritative: chess.js would flag threefold/50-move/insufficient
    // material as game over, but lichess keeps the game running until it ends.
    return this.ended;
  }

  /** Resolves when the server reports game end, or after `ms` as a fallback. */
  waitEnd(ms: number): Promise<void> {
    return Promise.race([this.endPromise, new Promise<void>(r => setTimeout(r, ms))]);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

async function readRedirect(sri: string): Promise<string> {
  const host = pickSocketHost();
  const url = `wss://${host}/lobby/socket/v5?from=website&sri=${sri}`;
  console.log(`Waiting for a human opponent on ${url}`);
  const ws = new WebSocket(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    },
  });
  const ping = setInterval(() => ws.send(encodePing()), 2500);
  return new Promise<string>((resolve, reject) => {
    ws.on('open', () => console.log('Lobby connected; waiting for pairing...'));
    ws.on('error', reject);
    ws.on('unexpected-response', (_r, res) =>
      reject(new Error(`lobby upgrade failed: ${res.statusCode}`)),
    );
    ws.on('message', (data, isBinary) => {
      const msg = decodeFrame(isBinary ? (data as Buffer) : data.toString());
      if (msg.kind === 'message' && msg.type === 'redirect') {
        const d: any = msg.data;
        clearInterval(ping);
        ws.close();
        console.log(`Paired: ${d.url}`);
        resolve(d.id);
      }
    });
  });
}

type Result = 'win' | 'loss' | 'draw' | 'unknown';

async function playGame(
  args: Args,
  game: NewGame,
  engine: UciEngine | undefined,
): Promise<Result> {
  const client = new RoundClient(game.fullId, game.version, { quiet: args.quiet });
  if (game.color === 'white' || game.color === 'black') client.setColor(game.color);
  await client.connect();

  const script = args.script ? [...args.script] : undefined;
  const rl = !script && !engine ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  if (rl) console.log('\nType a move in UCI (e2e4). Commands: moves, resign, draw, quit.');

  while (!client.finished) {
    const turn = await client.nextTurn();
    if (client.finished || turn === 'end') break;

    let cmd: string;
    if (engine) {
      cmd = await engine.bestMove(client.fen, args.movetime);
      if (cmd === '0000' || cmd === '(none)') break;
    } else if (script) {
      if (!script.length) break;
      cmd = script.shift()!;
      if (!args.quiet) console.log(`\nscript> ${cmd}`);
    } else {
      cmd = (await new Promise<string>(resolve => rl!.question('\nyour move> ', resolve)))
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    }

    if (!cmd) continue;
    if (cmd === 'quit' || cmd === 'exit') break;
    if (cmd === 'moves') {
      console.log(client.legalMoves().join(' '));
      continue;
    }
    if (cmd === 'resign' || cmd === 'draw' || cmd === 'abort') {
      client.send(cmd === 'draw' ? 'draw-yes' : cmd);
      if (cmd === 'resign' || cmd === 'abort') break;
      continue;
    }
    client.sendMove(cmd);
  }

  rl?.close();
  const ourColor = client.color;
  await client.waitEnd(3000);
  const winner = client.winner;
  const status = client.status;
  client.close();

  if (winner && ourColor) return winner === ourColor ? 'win' : 'loss';
  if (status === 'draw' || status === 'stalemate') return 'draw';
  return 'unknown';
}

async function playOneGame(
  args: Args,
  color: 'white' | 'black' | 'random',
  engine: UciEngine | undefined,
): Promise<Result> {
  let game: NewGame;
  if (args.mode === 'ai') {
    game = await createAiGame({ level: args.level, color, time: args.time, increment: args.increment });
    console.log(
      `Created AI game ${game.fullId} (color=${game.color}, level=${args.level}, ${args.time}+${args.increment})`,
    );
  } else {
    const sri = randomSri();
    const { hookId } = await createHook(sri, { time: args.time, increment: args.increment });
    console.log(`Created lobby hook ${hookId} (${args.time}+${args.increment}); waiting for opponent`);
    const fullId = await readRedirect(sri);
    game = {
      gameId: fullId.slice(0, 8),
      playerId: fullId.slice(8),
      fullId,
      color: 'random',
      variant: { key: 'standard', name: 'Standard' },
      version: 0,
      raw: null,
    };
  }
  return playGame(args, game, engine);
}

async function main(): Promise<void> {
  const args = parseArgs();
  setTimeout(() => {
    console.log('\n[timeout] exiting');
    process.exit(0);
  }, 3_600_000).unref();

  let engine: UciEngine | undefined;
  if (args.enginePath !== undefined) {
    if (args.mode === 'hook')
      throw new Error('refusing to use an engine against random humans in hook mode');
    const path = args.enginePath || findEngine();
    if (!path) throw new Error('No engine found. Pass --engine /path/to/stockfish or set STOCKFISH.');
    engine = new UciEngine(path);
    console.log(`Local engine: ${path}`);
  }

  if (args.mode === 'accept') {
    if (!args.challenge)
      throw new Error('usage: play.ts accept <challenge-url> [--engine /path/to/uci-engine] [--as white|black]');
    const game = await acceptChallenge(parseChallengeId(args.challenge), args.acceptColor);
    console.log(`Accepted ${args.challenge} -> game ${game.fullId} (we are ${game.color})`);
    const res = await playGame(args, game, engine);
    console.log(`\n[result] ${res}`);
    engine?.quit();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  const totalGames = engine ? args.games : 1;
  const tally: Record<Result, number> = { win: 0, loss: 0, draw: 0, unknown: 0 };

  for (let g = 1; g <= totalGames; g++) {
    const color: 'white' | 'black' | 'random' = engine
      ? g % 2 === 1
        ? 'white'
        : 'black'
      : args.color;
    if (engine) console.log(`\n===== Game ${g}/${totalGames} — local Stockfish plays ${color} =====`);
    const res = await playOneGame(args, color, engine);
    tally[res]++;
    if (engine) console.log(`[result] game ${g}: ${res}`);
  }

  if (engine) {
    engine.quit();
    console.log(`\n===== Match finished (${totalGames} games) =====`);
    console.log(`we won ${tally.win}, lost ${tally.loss}, drew ${tally.draw}, unknown ${tally.unknown}`);
  }
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
