/**
 * Anonymous lichess game creation (HTTP) + socket host selection.
 *
 * Anonymous identity model (from lila `app/controllers/Setup.scala` and
 * lila-ws `Mongo.player`):
 *   - an anonymous player is identified by the 4-char playerId embedded in the
 *     game's fullId (<8-char gameId><4-char playerId>)
 *   - lila-ws `Mongo.player(fullId, user=None)` matches `userId == None`, so
 *     possession of the fullId is enough to open `/play/<fullId>/v6`
 *   - the `anon` cookie returned on creation stores the same playerId (for the
 *     browser), but the socket does not require it
 */

export const SOCKET_HOSTS = [
  'socket0.lichess.org',
  'socket1.lichess.org',
  'socket2.lichess.org',
  'socket3.lichess.org',
  'socket4.lichess.org',
  'socket5.lichess.org',
];

export function randomSri(): string {
  return Math.random().toString(36).slice(2, 14);
}

export function pickSocketHost(): string {
  return SOCKET_HOSTS[Math.floor(Math.random() * SOCKET_HOSTS.length)]!;
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://lichess.org',
  Referer: 'https://lichess.org/',
};

export interface NewGame {
  gameId: string;
  playerId: string;
  fullId: string;
  color: 'white' | 'black' | 'random';
  variant: { key: string; name: string };
  version: number;
  raw: any;
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(form);
  return fetch(url, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export interface AiOptions {
  level?: number;
  color?: 'white' | 'black' | 'random';
  time?: number;
  increment?: number;
  timeMode?: 0 | 1 | 2;
  variant?: number;
  days?: number;
}

/** `POST /setup/ai` — anonymous game vs the server Stockfish. Returns a fullId. */
export async function createAiGame(opts: AiOptions = {}): Promise<NewGame> {
  const res = await postForm('https://lichess.org/setup/ai', {
    variant: String(opts.variant ?? 1),
    timeMode: String(opts.timeMode ?? 1),
    time: String(opts.time ?? 5),
    increment: String(opts.increment ?? 0),
    days: String(opts.days ?? 2),
    level: String(opts.level ?? 3),
    color: opts.color ?? 'white',
    fen: '',
  });
  if (!res.ok) throw new Error(`createAiGame ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return {
    gameId: data.game.id,
    playerId: data.player.id,
    fullId: data.game.id + data.player.id,
    color: data.player.color,
    variant: data.game.variant,
    version: data.player.version ?? 0,
    raw: data,
  };
}

/** Extract an 8-char challenge id from a URL, path, or bare id. */
export function parseChallengeId(input: string): string {
  const m = /challenge\/([A-Za-z0-9]{8})/.exec(input) ?? /([A-Za-z0-9]{8})/.exec(input);
  if (!m) throw new Error(`no challenge id in "${input}"`);
  return m[1]!;
}

/**
 * Accept a friend/open challenge anonymously. `POST /challenge/<id>/accept`
 * (the website route) is `Open`, so no account is needed; with
 * `Accept: application/json` it returns the round player JSON, from which we
 * read the resulting fullId and colour. (The `/api/...` route needs a token.)
 */
export async function acceptChallenge(
  challengeId: string,
  color?: 'white' | 'black',
): Promise<NewGame> {
  const url = `https://lichess.org/challenge/${challengeId}/accept${color ? `?color=${color}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, Referer: `https://lichess.org/${challengeId}` },
  });
  if (!res.ok) throw new Error(`acceptChallenge ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  if (!data?.game?.id || !data?.player?.id)
    throw new Error(`unexpected accept response: ${JSON.stringify(data).slice(0, 200)}`);
  return {
    gameId: data.game.id,
    playerId: data.player.id,
    fullId: data.game.id + data.player.id,
    color: data.player.color,
    variant: data.game.variant,
    version: data.player.version ?? 0,
    raw: data,
  };
}

export interface HookOptions {
  time?: number;
  increment?: number;
  days?: number;
  timeMode?: 0 | 1 | 2;
  variant?: number;
  color?: 'white' | 'black' | 'random';
}

/**
 * `POST /setup/hook/<sri>` — creates a casual lobby hook tied to `sri`.
 * An opposing player must accept it; when paired, the lobby socket for `sri`
 * receives `{"t":"redirect","d":{"id":<fullId>,...}}`.
 */
export async function createHook(sri: string, opts: HookOptions = {}): Promise<{ hookId: string }> {
  const res = await postForm(`https://lichess.org/setup/hook/${encodeURIComponent(sri)}`, {
    variant: String(opts.variant ?? 1),
    timeMode: String(opts.timeMode ?? 1),
    time: String(opts.time ?? 3),
    increment: String(opts.increment ?? 0),
    days: String(opts.days ?? 1),
    mode: '0', // anonymous games cannot be rated
    ratingRange: '',
    color: opts.color ?? 'random',
  });
  if (!res.ok) throw new Error(`createHook ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  if (!data.ok) throw new Error(`createHook refused: ${JSON.stringify(data)}`);
  return { hookId: data.hook.id };
}
