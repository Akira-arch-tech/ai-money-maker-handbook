import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const MAX_PLAYERS = 2;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(join(__dirname, "public")));
app.use(
  "/vendor/three",
  express.static(join(__dirname, "node_modules/three/build"))
);
app.use(
  "/vendor/addons",
  express.static(join(__dirname, "node_modules/three/examples/jsm"))
);

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function defaultRoom(code) {
  return {
    code,
    players: new Map(),
    objects: [],
    orbs: spawnOrbs(),
    scores: {},
    startedAt: Date.now(),
  };
}

function spawnOrbs() {
  const orbs = [];
  for (let i = 0; i < 8; i++) {
    orbs.push({
      id: `orb-${i}-${makeId()}`,
      x: (Math.random() - 0.5) * 14,
      y: 0.6 + Math.random() * 1.2,
      z: (Math.random() - 0.5) * 14,
    });
  }
  return orbs;
}

function roomSnapshot(room) {
  return {
    type: "state",
    code: room.code,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      ready: p.ready,
      glasses: p.glasses,
    })),
    objects: room.objects,
    orbs: room.orbs,
    scores: room.scores,
    startedAt: room.startedAt,
  };
}

function broadcast(room, payload, exceptId = null) {
  const raw = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(raw);
  }
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "DEMO")
        .trim()
        .toUpperCase()
        .slice(0, 8) || "DEMO";
      if (!rooms.has(code)) rooms.set(code, defaultRoom(code));
      const room = rooms.get(code);

      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { type: "error", message: "房间已满（最多 2 位眼镜用户）" });
        return;
      }

      playerId = makeId();
      roomCode = code;
      const slot = room.players.size;
      const colors = ["#3d8bfd", "#f0a202"];
      const names = ["眼镜用户 A", "眼镜用户 B"];
      const starts = [
        { x: -3, z: 3 },
        { x: 3, z: -3 },
      ];

      const player = {
        id: playerId,
        name: names[slot] || `眼镜用户 ${slot + 1}`,
        color: colors[slot] || "#9b59b6",
        x: starts[slot]?.x ?? 0,
        y: 1.2,
        z: starts[slot]?.z ?? 0,
        yaw: slot === 0 ? Math.PI / 4 : (-3 * Math.PI) / 4,
        ready: false,
        glasses: msg.glasses || "N1",
        ws,
      };
      room.players.set(playerId, player);
      room.scores[playerId] = room.scores[playerId] ?? 0;

      send(ws, {
        type: "welcome",
        you: {
          id: player.id,
          name: player.name,
          color: player.color,
          glasses: player.glasses,
        },
        ...roomSnapshot(room),
      });
      broadcast(room, roomSnapshot(room));
      return;
    }

    if (!playerId || !roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const me = room.players.get(playerId);
    if (!me) return;

    if (msg.type === "move") {
      me.x = Number(msg.x) || 0;
      me.y = Number(msg.y) || 1.2;
      me.z = Number(msg.z) || 0;
      me.yaw = Number(msg.yaw) || 0;
      broadcast(
        room,
        {
          type: "player_move",
          id: me.id,
          x: me.x,
          y: me.y,
          z: me.z,
          yaw: me.yaw,
        },
        me.id
      );
      return;
    }

    if (msg.type === "voice") {
      const command = String(msg.command || "");
      const result = handleVoice(room, me, command);
      broadcast(room, {
        type: "voice_event",
        from: me.id,
        name: me.name,
        command,
        result,
        state: roomSnapshot(room),
      });
      return;
    }

    if (msg.type === "collect") {
      const orbId = msg.orbId;
      const idx = room.orbs.findIndex((o) => o.id === orbId);
      if (idx === -1) return;
      const orb = room.orbs[idx];
      const dx = me.x - orb.x;
      const dz = me.z - orb.z;
      if (dx * dx + dz * dz > 2.5) return;
      room.orbs.splice(idx, 1);
      room.scores[me.id] = (room.scores[me.id] || 0) + 1;
      if (room.orbs.length === 0) room.orbs = spawnOrbs();
      broadcast(room, {
        type: "collected",
        by: me.id,
        name: me.name,
        orbId,
        scores: room.scores,
        orbs: room.orbs,
      });
      return;
    }

    if (msg.type === "chat") {
      broadcast(room, {
        type: "chat",
        from: me.id,
        name: me.name,
        text: String(msg.text || "").slice(0, 80),
      });
    }
  });

  ws.on("close", () => {
    if (!playerId || !roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    delete room.scores[playerId];
    if (room.players.size === 0) {
      rooms.delete(roomCode);
    } else {
      broadcast(room, roomSnapshot(room));
    }
  });
});

function handleVoice(room, me, command) {
  const map = {
    spawn_cube: { kind: "cube", label: "方块货样" },
    spawn_sphere: { kind: "sphere", label: "球体道具" },
    spawn_cone: { kind: "cone", label: "路锥标记" },
    spawn_tripo: { kind: "tripo", label: "Tripo 数字样" },
  };
  const def = map[command];
  if (!def) return { ok: false, reason: "未知指令" };

  if (room.objects.filter((o) => o.ownerId === me.id).length >= 6) {
    return { ok: false, reason: "你放置的物体已达上限（6）" };
  }

  const forward = 2.2;
  const obj = {
    id: makeId(),
    kind: def.kind,
    label: def.label,
    ownerId: me.id,
    ownerName: me.name,
    color: me.color,
    x: me.x + Math.sin(me.yaw) * forward,
    y: def.kind === "sphere" ? 0.7 : 0.55,
    z: me.z + Math.cos(me.yaw) * forward,
    createdAt: Date.now(),
  };
  room.objects.push(obj);
  if (room.objects.length > 24) room.objects.shift();
  return { ok: true, object: obj };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Qwen Sync Arena → http://localhost:${PORT}`);
  console.log(`打开两个浏览器窗口，输入同一房间号即可双人实时互动`);
});
