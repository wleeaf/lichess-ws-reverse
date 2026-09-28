/**
 * lichess.org internal WebSocket wire format.
 *
 * IMPORTANT FINDING: despite the "binary socket" reputation, the current
 * website socket (wss://lichess.org/socket/v5) is a **text/JSON** protocol.
 * It is NOT msgpack/binary. Each text frame is one JSON message:
 *
 *   server -> client : {"t": "<type>", "d": <data>, "v": <version>?}
 *   client -> server : {"t": "<type>", "d": <data>}
 *
 * Two bare (non-JSON) control strings exist for the ping/pong keep-alive:
 *   client sends: "p"  (or {"t":"p","l":<deciseconds>} for auth lag report)
 *   server reply: "0"
 *
 * Versioning: versioned events carry `v` (monotonic socket version). A client
 * that already has `v <= its current version` ignores the event. Version gaps
 * force a resync/reload.
 *
 * Sources: lichess-org/lila-ws `ipc/ClientIn.scala`, `ipc/ClientOut.scala`,
 * `netty/FrameHandler.scala`; client `ui/lib/src/socket.ts`.
 */

export type WireMessage =
  | { kind: 'ping'; lagDeciseconds?: number }
  | { kind: 'pong' }
  | { kind: 'lobby-pong'; members: number; rounds: number }
  | { kind: 'message'; type: string; data?: unknown; version?: number }
  | { kind: 'batch'; messages: WireMessage[] }
  | { kind: 'raw-binary'; bytes: Buffer }
  | { kind: 'unknown'; raw: string };

/** Decode one WebSocket frame from the lichess socket. */
export function decodeFrame(data: string | Buffer | ArrayBuffer): WireMessage {
  const buf = toBuffer(data);

  // Binary frame: the website socket never sends these. Surface it so a real
  // reverse-engineering session can prove/disprove the binary hypothesis.
  if (buf !== null && !looksLikeUtf8Json(buf)) return { kind: 'raw-binary', bytes: buf };

  const text = buf ? buf.toString('utf8') : String(data);
  return decodeText(text);
}

function toBuffer(data: string | Buffer | ArrayBuffer): Buffer | null {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  const view = data as unknown as Uint8Array;
  if (ArrayBuffer.isView(view)) return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  return null;
}

/** Heuristic: a frame starting with 0x7b ('{') or a bare word is text. */
function looksLikeUtf8Json(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const first = buf[0]!;
  if (first === 0x7b || first === 0x70 || first === 0x30 || first === 0x6e) return true; // { p 0 n
  // printable ASCII start and no NUL bytes in the first 64 bytes -> text
  if (first < 0x09 || first > 0x7e) return false;
  const head = buf.subarray(0, Math.min(64, buf.length));
  return !head.includes(0);
}

export function decodeText(text: string): WireMessage {
  if (text === '0') return { kind: 'pong' };
  if (text === 'p' || text === 'null') return { kind: 'ping' };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unknown', raw: text };
  }
  if (json === null) return { kind: 'ping' };
  if (typeof json !== 'object') return { kind: 'unknown', raw: text };

  const obj = json as Record<string, unknown>;

  // Lobby keep-alive: {"t":"n","d":<members>,"r":<rounds>}
  if (obj.t === 'n' && typeof obj.d === 'number') {
    return { kind: 'lobby-pong', members: obj.d, rounds: Number(obj.r ?? 0) };
  }

  // Ping with lag report: {"t":"p","l":<deciseconds>}
  if (obj.t === 'p' && obj.d === undefined && obj.v === undefined) {
    return { kind: 'ping', lagDeciseconds: typeof obj.l === 'number' ? obj.l : undefined };
  }

  const version = typeof obj.v === 'number' ? obj.v : undefined;

  // Batch envelope: {"t":"batch","d":[ ...versioned messages... ]}
  if (obj.t === 'batch' && Array.isArray(obj.d)) {
    return {
      kind: 'batch',
      messages: obj.d.map(d => decodeText(typeof d === 'string' ? d : JSON.stringify(d))),
    };
  }

  if (typeof obj.t === 'string') {
    return { kind: 'message', type: obj.t, data: obj.d, version };
  }

  // Versioned wrapper injected by ClientIn.Versioned:
  // {"v":N, <original message fields...>}
  if (version !== undefined && typeof (obj as any).t !== 'string') {
    const { v: _v, ...rest } = obj;
    const inner = decodeText(JSON.stringify(rest));
    if (inner.kind === 'message') inner.version = version;
    return inner;
  }

  return { kind: 'unknown', raw: text };
}

// ---------------------------------------------------------------------------
// Encoding (client -> server)
// ---------------------------------------------------------------------------

/** 1 lag decisecond == 100ms. `Math.round(0.1 * averageLagMillis)`. */
export function encodePing(lagDeciseconds?: number): string {
  return lagDeciseconds === undefined ? 'p' : JSON.stringify({ t: 'p', l: lagDeciseconds });
}

export function encode(type: string, data?: unknown): string {
  return JSON.stringify(data === undefined ? { t: type } : { t: type, d: data });
}

// ---------------------------------------------------------------------------
// Message catalogs
// ---------------------------------------------------------------------------

/** Server -> client (`ipc/ClientIn.scala`), by socket endpoint. */
export const SERVER_MESSAGES: Record<string, string> = {
  '0': 'bare pong reply to a ping',
  n: 'lobby pong (members, rounds) — also answered as pong',
  batch: 'array of versioned messages in `d`',
  resync: 'client must reload state',
  serverRestart: 'server restarting',
  ack: 'ack for an ackable client message, echoed in `d`',
  bye: 'disconnect (usually the connection is just closed)',
  announce: 'site announcement',
  crowd: 'spectator/crowd state (members, users)',
  fen: 'current position of a watched game',
  finish: 'game finished (id, win)',
  mlat: 'move latency measurement',
  redirect: 'lobby pairing found, redirect to game url',
  feature: 'server feature flags / site config',
  following_onlines: 'friends online list',
  following_enters: 'friend came online',
  following_leaves: 'friend went offline',
  following_playing: 'friend started playing',
  following_stopped_playing: 'friend stopped playing',
  msgType: 'direct message origin',
  tournamentReminder: 'tournament starting reminder',
  tourStanding: 'tournament standing update',
  full: 'full round snapshot (when resyncing)',
  reload: 'round reload hint',
  gone: 'player gone / back',
  goneIn: 'player will be gone in N seconds',
  move: 'a move was played on a watched round',
  drop: 'a piece was dropped (crazyhouse)',
  clockInc: 'clock increment',
  cclock: 'correspondence clock',
  endData: 'round end data',
  rematchOffer: 'rematch offered by a color',
  rematchTaken: 'rematch accepted, next game id',
  drawOffer: 'draw offered by a color',
  berserk: 'a player went berserk',
  checkCount: 'check counts',
  simulPlayerMove: 'move in a simul you host',
  simulEnd: 'simul ended',
  tvSelect: 'tv channel selection',
  evalHit: 'eval cache hit',
  evalHitMulti: 'eval cache multi hit',
  sk1: 'storm signed key',
  racerState: 'racer state',
  voiceChat: 'voice chat participants (user ids array)',
};

/** Client -> server (`ipc/ClientOut.scala`), by socket endpoint. */
export const CLIENT_MESSAGES: Record<string, string> = {
  p: 'ping (also bare "p"); optional `l` = lag in deciseconds',
  startWatching: '`d` = space-separated game ids (max 16)',
  startWatchingTvChannels: 'watch tv channels',
  moveLat: 'move latency mode toggle',
  notified: 'notifications seen',
  following_onlines: 'subscribe/unsubscribe to friends online (`d` bool)',
  evalGet: 'fetch cached eval for a fen',
  evalPut: 'store eval for a fen',
  evalGetMulti: 'fetch cached evals for many fens',
  msgType: 'notify typing (`d` = user id)',
  msgSend: 'send a direct message',
  msgRead: 'mark direct messages read',
  idle: 'idle state of the lobby (`d` bool)',
  join: 'lobby actions (join game/tv)',
  cancel: 'cancel lobby seek',
  joinSeek: 'join a seek',
  cancelSeek: 'cancel a seek',
  poolIn: 'enter a pool',
  poolOut: 'leave a pool',
  hookIn: 'enter a lobby hook',
  hookOut: 'leave a lobby hook',
  move: '`d` = {u: uci, b: blur, a: ackId, l: lag, s: moveTime(base36)}',
  drop: '`d` = {role, pos, b, a, l, s}',
  hold: '`d` = {mean, sd} premove annotation',
  berserk: '`d` = {a: ackId}',
  rep: 'player self report `d` = {n: text}',
  flag: 'claim flag `d` = color',
  bye2: 'resign/bye',
  moretime: 'request more time',
  resign: 'resign', 'resign-force': 'force resign',
  'draw-yes': 'accept draw', 'draw-no': 'decline draw', 'draw-claim': 'claim draw', 'draw-force': 'force draw',
  'takeback-yes': 'accept takeback', 'takeback-no': 'decline takeback',
  'rematch-yes': 'accept rematch', 'rematch-no': 'decline rematch',
  'blindfold-yes': 'enable blindfold', 'blindfold-no': 'disable blindfold',
  abort: 'abort game', outoftime: 'out of time',
  talk: 'chat message `d` = text',
  timeout: 'moderation timeout `d` = {userId, reason, text}',
  ping: 'challenge ping',
  sk1: 'storm key `d` = "key!pad"',
  racerScore: 'racer score `d` = int',
  racerJoin: 'join racer', racerStart: 'start racer',
  anaMove: 'study analysis move', anaDrop: 'study analysis drop',
  ignore: 'no-op',
};
