# lichess-ws-reverse

Reverse-engineering **lichess.org's internal WebSocket protocol** and a small TypeScript client that can capture traffic and play anonymous games.

> Not affiliated with lichess. Educational/interoperability research on an open-source service.

## Features

- **Capture** live WebSocket frames from lichess.org with Playwright.
- **Decode/encode** the wire format, with a catalog of client↔server message types.
- **Standalone Node client** (no browser) for the internal sockets.
- **Anonymous play**: create games against the server Stockfish or lobby hooks, and accept friend-challenge links.
- **Engine driver**: play the bot's side with any UCI engine.

## Protocol findings

The internal socket is **text/JSON**, not binary. Endpoints live on `socket0..5.lichess.org`:

| Endpoint | Purpose |
| --- | --- |
| `/socket/v5` | site socket |
| `/lobby/socket/v5` | lobby (hooks, seeks) |
| `/watch/<gameId>/<color>/v6` | spectate a game |
| `/play/<fullId>/v6` | play a game |

- Handshake: `?from=website&sri=<id>[&v=<socketVersion>]`. Omit the `Origin` header (an `Origin` that isn't lichess's yields 403); the `sri` param is required (400 otherwise).
- Frames: one JSON object per text frame, `{"t": <type>, "d": <data>, "v": <version>?}`; batched events arrive as `{"t":"batch","d":[...]}`.
- Keep-alive: client sends `p` (or `{"t":"p","l":<deciseconds>}`), server replies `0`.
- Versioned events carry `v`; a client that already has `v <= current` ignores them, and gaps force a resync.
- Anonymous identity: a game is keyed by its `fullId` (`<8-char gameId><4-char playerId>`), returned by game creation.

Anonymous game creation uses plain HTTP:

| Request | Result |
| --- | --- |
| `POST /setup/ai` | game vs server Stockfish |
| `POST /setup/hook/<sri>` | casual lobby hook (real-time only for anon) |
| `POST /challenge/<id>/accept` | accept a "play with a friend" link |

## Requirements

- Node.js 20+ (`tsx`, global `fetch`)
- Chromium for Playwright (only for `capture`) — `npx playwright install chromium`
- A UCI engine (e.g. Stockfish) only if you use `--engine`

## Install

```bash
npm install
```

## Usage

```bash
# Capture lichess WebSocket frames for 30s (headless Chromium)
npm run capture -- https://lichess.org 30

# Summarize a capture: endpoints, frame counts, message types
npm run analyze -- captures/<file>.jsonl

# Standalone client against an internal socket
npm run client -- /socket/v5 15

# Play anonymously vs the computer
npm run play -- ai 1 white 5

# ...with a UCI engine driving the bot's side
npm run play -- ai 8 white 3 --engine /path/to/stockfish --games 4

# Accept a friend-challenge link and play (optionally with an engine)
npm run play -- accept https://lichess.org/XXXXXXXX --engine /path/to/uci
```

`play` modes: `ai` (vs Stockfish), `hook` (lobby game), `accept` (friend link).
Flags: `--engine [path]`, `--games <n>`, `--script a,b,c`, `--quiet`, `--as white|black`.

## Layout

```
src/
  wire.ts      wire format: decode/encode + message catalogs
  client.ts    standalone Node WebSocket client
  capture.ts   Playwright frame capture -> JSONL
  analyze.ts   capture analyzer
  lichess.ts   anonymous game creation + challenge accept
  play.ts      playable client (ai / hook / accept)
  uci.ts       minimal UCI engine wrapper
```

## Disclaimer

Built for research and interoperability against an open-source service (lichess runs
`lila` and `lila-ws`). Respect lichess's Terms of Service and rate limits. Do **not**
use engine assistance against human opponents — use the official
[Bot API](https://lichess.org/api#tag/Bot) for bots.

## License

[MIT](LICENSE)
