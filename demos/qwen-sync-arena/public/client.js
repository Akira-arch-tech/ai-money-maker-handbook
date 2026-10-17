import * as THREE from "three";

const lobby = document.getElementById("lobby");
const gameEl = document.getElementById("game");
const canvas = document.getElementById("c");
const joinBtn = document.getElementById("joinBtn");
const roomInput = document.getElementById("roomCode");
const glassesSel = document.getElementById("glasses");
const youPill = document.getElementById("youPill");
const roomPill = document.getElementById("roomPill");
const scorePill = document.getElementById("scorePill");
const subtitle = document.getElementById("subtitle");
const logEl = document.getElementById("log");

/** @type {WebSocket | null} */
let ws = null;
/** @type {any} */
let me = null;
/** @type {Map<string, any>} */
const players = new Map();
/** @type {Map<string, THREE.Object3D>} */
const playerMeshes = new Map();
/** @type {Map<string, THREE.Object3D>} */
const objectMeshes = new Map();
/** @type {Map<string, THREE.Object3D>} */
const orbMeshes = new Map();
let scores = {};
let roomCode = "DEMO";

const keys = new Set();
let yaw = 0;
let pitch = 0.12;
let dragging = false;
let lastX = 0;
let lastY = 0;
let lastSent = 0;
let lastCollect = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
scene.fog = new THREE.Fog(0x0b1020, 18, 42);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 80);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const hemi = new THREE.HemisphereLight(0xb8c7ff, 0x1a2030, 1.1);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(6, 12, 4);
scene.add(dir);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(18, 64),
  new THREE.MeshStandardMaterial({ color: 0x152038, roughness: 0.85, metalness: 0.05 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const grid = new THREE.GridHelper(36, 36, 0x2a3a5c, 0x1a2740);
grid.position.y = 0.01;
scene.add(grid);

const ring = new THREE.Mesh(
  new THREE.RingGeometry(9.6, 10, 64),
  new THREE.MeshBasicMaterial({ color: 0x3d8bfd, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.02;
scene.add(ring);

function resize() {
  const w = gameEl.clientWidth || window.innerWidth;
  const h = gameEl.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", resize);

function log(line) {
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `<div>[${t}] ${line}</div>` + logEl.innerHTML;
}

function setSubtitle(text) {
  subtitle.textContent = text;
}

function updateScoreUI() {
  const ids = [...players.keys()];
  const a = ids[0] ? scores[ids[0]] || 0 : 0;
  const b = ids[1] ? scores[ids[1]] || 0 : 0;
  if (ids.length < 2) {
    scorePill.textContent = `比分 ${scores[me?.id] || 0}`;
  } else {
    scorePill.textContent = `比分 ${a} : ${b}`;
  }
}

function makeAvatar(color, label) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.7, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45 })
  );
  body.position.y = 0.9;
  g.add(body);

  const glasses = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.3 });
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.08), mat);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.08), mat);
  left.position.set(-0.14, 1.35, 0.28);
  right.position.set(0.14, 1.35, 0.28);
  glasses.add(left, right);
  g.add(glasses);

  const canvas2 = document.createElement("canvas");
  canvas2.width = 256;
  canvas2.height = 64;
  const ctx = canvas2.getContext("2d");
  ctx.fillStyle = "rgba(10,16,32,0.75)";
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#e8eefc";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, 128, 40);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas2), transparent: true })
  );
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.y = 2.1;
  g.add(sprite);
  return g;
}

function makeProp(kind, color) {
  let mesh;
  if (kind === "cube") {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
    );
  } else if (kind === "sphere") {
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 24, 16),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 })
    );
  } else if (kind === "cone") {
    mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.1, 16),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
    );
  } else {
    // Tripo-style stylized product stand-in
    const g = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.65, 0.18, 20),
      new THREE.MeshStandardMaterial({ color: 0x24304d, metalness: 0.3, roughness: 0.5 })
    );
    const body = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.35 })
    );
    body.position.y = 0.65;
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.03, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xf0a202 })
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.65;
    g.add(base, body, halo);
    mesh = g;
  }
  return mesh;
}

function makeOrb() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0x3ecf8e,
      emissive: 0x1a8f55,
      emissiveIntensity: 0.8,
      roughness: 0.2,
    })
  );
  return mesh;
}

function syncPlayers(list) {
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    players.set(p.id, p);
    let mesh = playerMeshes.get(p.id);
    if (!mesh) {
      mesh = makeAvatar(p.color, p.name.replace("眼镜用户 ", ""));
      playerMeshes.set(p.id, mesh);
      scene.add(mesh);
    }
    if (!me || p.id !== me.id) {
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = p.yaw;
      mesh.visible = true;
    } else {
      mesh.visible = false;
    }
  }
  for (const [id, mesh] of playerMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      playerMeshes.delete(id);
      players.delete(id);
    }
  }
  updateScoreUI();
  if (players.size < 2) {
    setSubtitle("等待另一位眼镜用户加入同一房间…（再开一个浏览器窗口）");
  } else if (!subtitle.dataset.locked) {
    setSubtitle("双人在线 · 用语音生成物体，走近发光球抢分");
  }
}

function syncObjects(list) {
  const seen = new Set();
  for (const o of list) {
    seen.add(o.id);
    let mesh = objectMeshes.get(o.id);
    if (!mesh) {
      mesh = makeProp(o.kind, o.color);
      objectMeshes.set(o.id, mesh);
      scene.add(mesh);
    }
    mesh.position.set(o.x, o.y, o.z);
  }
  for (const [id, mesh] of objectMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      objectMeshes.delete(id);
    }
  }
}

function syncOrbs(list) {
  const seen = new Set();
  for (const o of list) {
    seen.add(o.id);
    let mesh = orbMeshes.get(o.id);
    if (!mesh) {
      mesh = makeOrb();
      orbMeshes.set(o.id, mesh);
      scene.add(mesh);
    }
    mesh.position.set(o.x, o.y, o.z);
  }
  for (const [id, mesh] of orbMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      orbMeshes.delete(id);
    }
  }
}

function applyState(state) {
  if (state.scores) scores = state.scores;
  if (state.players) syncPlayers(state.players);
  if (state.objects) syncObjects(state.objects);
  if (state.orbs) syncOrbs(state.orbs);
  updateScoreUI();
}

function connect() {
  roomCode = (roomInput.value || "DEMO").trim().toUpperCase() || "DEMO";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "join",
        code: roomCode,
        glasses: glassesSel.value,
      })
    );
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") {
      alert(msg.message);
      return;
    }
    if (msg.type === "welcome") {
      me = msg.you;
      yaw = players.get(me.id)?.yaw ?? yaw;
      lobby.classList.add("hidden");
      gameEl.classList.remove("hidden");
      resize();
      youPill.textContent = `${me.name} · ${me.glasses}`;
      youPill.style.borderColor = me.color;
      roomPill.textContent = `房间 ${msg.code}`;
      applyState(msg);
      const self = msg.players.find((p) => p.id === me.id);
      if (self) {
        yaw = self.yaw;
        localPos.x = self.x;
        localPos.z = self.z;
      }
      log(`已进入房间 ${msg.code}`);
      return;
    }
    if (msg.type === "state") {
      applyState(msg);
      return;
    }
    if (msg.type === "player_move") {
      const p = players.get(msg.id);
      if (p) {
        p.x = msg.x;
        p.y = msg.y;
        p.z = msg.z;
        p.yaw = msg.yaw;
      }
      const mesh = playerMeshes.get(msg.id);
      if (mesh && (!me || msg.id !== me.id)) {
        mesh.position.set(msg.x, 0, msg.z);
        mesh.rotation.y = msg.yaw;
      }
      return;
    }
    if (msg.type === "voice_event") {
      applyState(msg.state);
      const ok = msg.result?.ok;
      const line = ok
        ? `${msg.name} 语音「${labelCmd(msg.command)}」→ 生成 ${msg.result.object.label}`
        : `${msg.name} 语音失败：${msg.result?.reason || ""}`;
      log(line);
      subtitle.dataset.locked = "1";
      setSubtitle(line);
      setTimeout(() => {
        delete subtitle.dataset.locked;
      }, 2200);
      return;
    }
    if (msg.type === "collected") {
      scores = msg.scores;
      syncOrbs(msg.orbs);
      updateScoreUI();
      log(`${msg.name} 拾取能量球 +1`);
      if (msg.by === me?.id) {
        setSubtitle("能量球 +1 · 继续靠近发光球");
      }
      return;
    }
  };

  ws.onclose = () => {
    setSubtitle("连接断开，刷新页面重进房间");
  };
}

function labelCmd(cmd) {
  return (
    {
      spawn_cube: "生成方块货样",
      spawn_sphere: "生成球体道具",
      spawn_cone: "生成路锥标记",
      spawn_tripo: "Tripo 数字样",
    }[cmd] || cmd
  );
}

joinBtn.addEventListener("click", connect);

document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "voice", command: btn.getAttribute("data-cmd") }));
  });
});

window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", () => {
  dragging = false;
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  yaw -= dx * 0.005;
  pitch = Math.max(-0.6, Math.min(0.75, pitch - dy * 0.004));
});

const localPos = { x: -3, y: 1.2, z: 3 };

function tick(now) {
  requestAnimationFrame(tick);
  if (!me) {
    renderer.render(scene, camera);
    return;
  }

  const speed = 4.2;
  let mx = 0;
  let mz = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) mz += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) mz -= 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;

  if (mx || mz) {
    const len = Math.hypot(mx, mz) || 1;
    mx /= len;
    mz /= len;
    const dt = 1 / 60;
    localPos.x += (Math.sin(yaw) * mz + Math.cos(yaw) * mx) * speed * dt;
    localPos.z += (Math.cos(yaw) * mz - Math.sin(yaw) * mx) * speed * dt;
    const lim = 9.2;
    localPos.x = Math.max(-lim, Math.min(lim, localPos.x));
    localPos.z = Math.max(-lim, Math.min(lim, localPos.z));
  }

  const camDist = 4.2;
  camera.position.set(
    localPos.x - Math.sin(yaw) * camDist,
    localPos.y + 1.4 + pitch * 2,
    localPos.z - Math.cos(yaw) * camDist
  );
  camera.lookAt(localPos.x, localPos.y + 0.6, localPos.z);

  if (ws && ws.readyState === 1 && now - lastSent > 50) {
    lastSent = now;
    ws.send(
      JSON.stringify({
        type: "move",
        x: localPos.x,
        y: localPos.y,
        z: localPos.z,
        yaw,
      })
    );
  }

  if (ws && ws.readyState === 1 && now - lastCollect > 200) {
    for (const [id, mesh] of orbMeshes) {
      const dx = mesh.position.x - localPos.x;
      const dz = mesh.position.z - localPos.z;
      if (dx * dx + dz * dz < 1.1) {
        lastCollect = now;
        ws.send(JSON.stringify({ type: "collect", orbId: id }));
        break;
      }
    }
  }

  for (const mesh of orbMeshes.values()) {
    mesh.position.y = 0.7 + Math.sin(now * 0.004 + mesh.position.x) * 0.15;
    mesh.rotation.y += 0.02;
  }
  for (const mesh of objectMeshes.values()) {
    if (mesh.children?.length) mesh.rotation.y += 0.008;
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(tick);
