# Couchify relay

Minimal per-room fan-out WebSocket server (~90 lines). Free-tier friendly (Fly.io, Render).

## Run locally

```
npm install
npm start   # ws://localhost:8080
```

## Protocol

- Client → server:
  - `{op:"join", room, peerId, policy?, leader?}` — join a room
  - `{op:"msg", room, from, payload}` — broadcast to all room members except sender
- Server → client:
  - `{op:"peers", peers:[...]}` after join
  - forwarded `{op:"msg", room, from, payload}`

No persistence, no auth beyond room code — matches the extension's model.

## Deploy (one-time)

Fly.io:
```
fly launch --no-deploy
fly deploy
```
Set the deployed URL as `Relay URL` in Couchify options (or leave default if it's the hardcoded public endpoint).