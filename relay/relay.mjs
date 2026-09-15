// Couchify relay: minimal per-room fan-out WebSocket server.
// Deploy once to any free tier (Fly.io, Render) if no public relay suits.
// Protocol (JSON over WebSocket, one message per frame):
//   client → server: {op:"join", room, peerId, policy?, leader?}
//                    {op:"msg", room, from, payload}
//   server → client: {op:"peers", peers:[...]} on join
//                    {op:"msg", room, from, payload} (forwarded, all room members except sender)
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
/** room → Map<peerId, WebSocket> */
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws, req) => {
  console.log(`[relay] client connected from ${req.socket.remoteAddress}`);
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.op === "join" && typeof msg.room === "string" && typeof msg.peerId === "string") {
      if (!rooms.has(msg.room)) rooms.set(msg.room, new Map());
      rooms.get(msg.room).set(msg.peerId, ws);
      ws.room = msg.room;
      ws.peerId = msg.peerId;
      console.log(`[relay] peer ${msg.peerId} joined room ${msg.room}`);
      ws.send(JSON.stringify({ op: "peers", peers: [...rooms.get(msg.room).keys()] }));
      return;
    }
    if (msg.op === "msg" && typeof msg.room === "string" && typeof msg.payload === "string") {
      const members = rooms.get(msg.room);
      if (!members) return;
      for (const [pid, sock] of members) {
        if (pid !== msg.from && sock.readyState === 1) sock.send(JSON.stringify(msg));
      }
    }
  });
  ws.on("close", () => {
    console.log(`[relay] peer ${ws.peerId || 'unknown'} disconnected`);
    const members = rooms.get(ws.room);
    if (members) {
      members.delete(ws.peerId);
      if (!members.size) rooms.delete(ws.room);
    }
  });
});

console.log(`couchify relay listening on :${PORT}`);