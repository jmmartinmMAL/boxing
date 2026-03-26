'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3003;

// ─── Constants ────────────────────────────────────────────────────────────────
const ARENA_W           = 1280;
const ARENA_H           = 720;
const ISLAND_CX         = 640;
const ISLAND_CY         = 360;
const ISLAND_R          = 300;    // island radius (top-down circle)
const PLAYER_R          = 20;
const PLAYER_SPEED      = 240;
const MAX_HP            = 100;
const MAX_STAMINA       = 100;
const STAMINA_REGEN     = 25;     // per second
const PUNCH_REGEN_DELAY = 700;    // ms delay after punch before regen
const PUNCH_COOLDOWN_MS = 420;    // min ms between punches
const PUNCH_COST        = 20;
const PUNCH_RANGE       = 70;     // euclidean px (~1.5 player widths apart)
const PUNCH_DAMAGE      = 12;
const PUNCH_KNOCKBACK   = 380;    // initial velocity px/s
const VEL_DECAY_K       = 5;      // exp decay: total_disp ≈ v0/k
const POWER_MULT        = 2.5;
const POWER_DURATION_MS = 5000;
const ITEM_SPAWN_MS     = 8000;
const MAX_ITEMS         = 3;
const ROUND_MS          = 90000;  // 1.5 minutes
const RESPAWN_MS        = 2000;
const KILL_TTL          = 3500;   // ms kill event lives for chicken animation
const HIT_CREDIT_MS     = 3000;   // ms to credit last hitter on fall-off
const TICK_MS           = Math.round(1000 / 30);
const MAX_PLAYERS       = 6;
const MIN_START         = 2;
const NUM_SEA_CHICKENS  = 12;

// ─── Sea chickens ─────────────────────────────────────────────────────────────
function makeSeaChickens() {
  return Array.from({ length: NUM_SEA_CHICKENS }, (_, i) => ({
    id:        i,
    x:         ISLAND_CX + Math.cos(i * Math.PI * 2 / NUM_SEA_CHICKENS) * (ISLAND_R + 70 + (i % 3) * 50),
    y:         ISLAND_CY + Math.sin(i * Math.PI * 2 / NUM_SEA_CHICKENS) * (ISLAND_R + 70 + (i % 3) * 50),
    angle:     Math.random() * Math.PI * 2,
    speed:     55 + (i % 4) * 18,
    turnTimer: 800 + Math.random() * 2000,
    bobOffset: (i * Math.PI * 2) / NUM_SEA_CHICKENS,
  }));
}

// ─── Items ────────────────────────────────────────────────────────────────────
let itemIdCounter = 0;
function makeItem(forcedType) {
  const type  = forcedType || (Math.random() > 0.5 ? 'stamina' : 'power');
  const angle = Math.random() * Math.PI * 2;
  const r     = ISLAND_R * (0.15 + Math.random() * 0.5);
  return { id: itemIdCounter++, type, x: ISLAND_CX + Math.cos(angle) * r, y: ISLAND_CY + Math.sin(angle) * r };
}

// ─── Game state ───────────────────────────────────────────────────────────────
let gs = makeGameState();

function makeGameState() {
  return {
    phase:        'waiting',
    players:      new Map(),
    clients:      new Map(),
    items:        [],
    seaChickens:  makeSeaChickens(),
    killEvents:   [],           // [{x, y, time, killerId, victimId}]
    roundResult:  null,
    itemTimer:    ITEM_SPAWN_MS * 0.5,
    roundEndsAt:  0,
    pendingEndAt: 0,   // timestamp when to actually call endRound (after chicken delay)
    pendingWinner: null,
    goToLobby:    false,
  };
}

// ─── Game loop ────────────────────────────────────────────────────────────────
let lastTime = Date.now();

function startGameLoop() {
  lastTime = Date.now();
  setInterval(tick, TICK_MS);
}

function tick() {
  const now = Date.now();
  const dt  = Math.min((now - lastTime) / 1000, 0.1);
  lastTime  = now;

  for (const [id, p] of gs.players) {
    if (now - p.lastSeen > 15000) {
      gs.players.delete(id);
      const cl = gs.clients.get(id);
      if (cl) { try { cl.end(); } catch (_) {} }
      gs.clients.delete(id);
    }
  }

  if (gs.phase === 'waiting') {
    if (gs.players.size >= MAX_PLAYERS) startRound(now);
  } else if (gs.phase === 'playing') {
    updatePlayers(dt, now);
    updateItems(dt);
    updateSeaChickens(dt, now);
    gs.killEvents = gs.killEvents.filter(e => now - e.time < KILL_TTL);
    // Last man standing: wait 2s for chicken animation, then end round
    const alivePlayers = [...gs.players.values()].filter(p => p.alive);
    if (gs.players.size >= 2 && alivePlayers.length <= 1 && gs.pendingEndAt === 0) {
      gs.pendingEndAt  = now + 2000;
      gs.pendingWinner = alivePlayers[0] || null;
    }
    if (gs.pendingEndAt > 0 && now >= gs.pendingEndAt) {
      endRound(gs.pendingWinner);
      gs.pendingEndAt  = 0;
      gs.pendingWinner = null;
    }
  }

  broadcast(now);
}

// ─── Round lifecycle ──────────────────────────────────────────────────────────
function startRound(now) {
  gs.phase        = 'playing';
  gs.roundEndsAt  = 0;
  gs.pendingEndAt = 0;
  gs.pendingWinner = null;
  gs.items        = [];
  gs.killEvents   = [];
  gs.itemTimer    = ITEM_SPAWN_MS * 0.5;
  gs.roundResult  = null;

  const players = [...gs.players.values()];
  players.forEach((p, i) => {
    const sp        = getSpawnPos(i, players.length);
    p.x             = sp.x; p.y = sp.y;
    p.velX          = 0;    p.velY = 0;
    p.angle         = Math.atan2(ISLAND_CY - sp.y, ISLAND_CX - sp.x);
    p.alive         = true;
    p.respawnAt     = 0;
    p.respawnedAt   = 0;
    p.hp            = MAX_HP;
    p.stamina       = MAX_STAMINA;
    p.lastPunchTime = 0;
    p.powerUntil    = 0;
    // score (round wins) is intentionally NOT reset here
    p.lastHitBy     = null;
    p.lastHitTime   = 0;
    p.dirX = 0; p.dirY = 0;
    p.action = false; p.prevAction = false;
    p.punchTime = 0; p.hitTime = 0;
    p.scoreEventDelta = 0; p.scoreEventTime = 0;
  });
}

function getSpawnPos(index, total) {
  const n     = Math.max(total, 1);
  const angle = (index / n) * Math.PI * 2 - Math.PI / 2;
  const r     = ISLAND_R * 0.45;
  return { x: ISLAND_CX + Math.cos(angle) * r, y: ISLAND_CY + Math.sin(angle) * r };
}

function endRound(winner) {
  gs.phase = 'ended';
  if (winner) winner.score += 1;
  const players = [...gs.players.values()].sort((a, b) => b.score - a.score);
  gs.roundResult = {
    winnerId: winner ? winner.id : null,
    scores:   players.map(p => ({ id: p.id, name: p.name, score: p.score, playerIndex: p.playerIndex })),
  };
}

// ─── Player update ────────────────────────────────────────────────────────────
function updatePlayers(dt, now) {
  for (const p of gs.players.values()) {
    if (!p.alive) continue;

    // Stamina regen
    if (now - p.lastPunchTime > PUNCH_REGEN_DELAY)
      p.stamina = Math.min(MAX_STAMINA, p.stamina + STAMINA_REGEN * dt);

    // Power expiry
    if (p.powerUntil > 0 && now >= p.powerUntil) p.powerUntil = 0;

    // Knockback decay
    p.velX *= Math.exp(-VEL_DECAY_K * dt);
    p.velY *= Math.exp(-VEL_DECAY_K * dt);
    if (Math.abs(p.velX) < 2) p.velX = 0;
    if (Math.abs(p.velY) < 2) p.velY = 0;

    // Move
    p.x += (p.dirX * PLAYER_SPEED + p.velX) * dt;
    p.y += (p.dirY * PLAYER_SPEED + p.velY) * dt;

    // Update facing angle from input
    if (Math.abs(p.dirX) > 0.05 || Math.abs(p.dirY) > 0.05)
      p.angle = Math.atan2(p.dirY, p.dirX);

    // Island edge check
    const dx = p.x - ISLAND_CX, dy = p.y - ISLAND_CY;
    if (dx * dx + dy * dy > (ISLAND_R - PLAYER_R) * (ISLAND_R - PLAYER_R))
      killPlayer(p, now);

    // Item pickup
    if (p.alive) {
      for (let i = gs.items.length - 1; i >= 0; i--) {
        const item = gs.items[i];
        const ix = item.x - p.x, iy = item.y - p.y;
        if (ix * ix + iy * iy < (PLAYER_R + 18) * (PLAYER_R + 18)) {
          applyItem(p, item, now);
          gs.items.splice(i, 1);
        }
      }
    }
  }
  resolvePlayerCollisions();
}

function resolvePlayerCollisions() {
  const alive = [...gs.players.values()].filter(p => p.alive);
  const minDist = PLAYER_R * 2 + 1;
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 >= minDist * minDist) continue;
        const d = Math.sqrt(d2);
        const push = (minDist - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }
}

function killPlayer(p, now) {
  let killer = null;
  if (p.lastHitBy && now - p.lastHitTime < HIT_CREDIT_MS)
    killer = gs.players.get(p.lastHitBy);

  // Push visually outside island
  const dx = p.x - ISLAND_CX, dy = p.y - ISLAND_CY;
  const d  = Math.sqrt(dx * dx + dy * dy) || 1;
  p.x = ISLAND_CX + (dx / d) * (ISLAND_R + 50);
  p.y = ISLAND_CY + (dy / d) * (ISLAND_R + 50);

  gs.killEvents.push({ x: p.x, y: p.y, time: now, killerId: killer ? killer.id : null, victimId: p.id });

  p.alive     = false;
  p.respawnAt = 0;  // no respawn in king of the hill
  p.hp        = MAX_HP;
  p.velX = 0; p.velY = 0;
}

function respawnPlayer(p, now) {
  // Spawn at a random position away from others
  let best = getSpawnPos(Math.floor(Math.random() * MAX_PLAYERS), MAX_PLAYERS);
  let bestDist = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = ISLAND_R * (0.2 + Math.random() * 0.45);
    const cx    = ISLAND_CX + Math.cos(angle) * r;
    const cy    = ISLAND_CY + Math.sin(angle) * r;
    let minDist = Infinity;
    for (const q of gs.players.values()) {
      if (!q.alive || q.id === p.id) continue;
      const dd = (cx - q.x) ** 2 + (cy - q.y) ** 2;
      if (dd < minDist) minDist = dd;
    }
    if (minDist > bestDist) { bestDist = minDist; best = { x: cx, y: cy }; }
  }
  p.x = best.x; p.y = best.y;
  p.velX = 0; p.velY = 0;
  p.alive      = true;
  p.respawnAt  = 0;
  p.respawnedAt = now;
  p.hp         = MAX_HP;
  p.stamina    = MAX_STAMINA;
  p.lastHitBy  = null;
  p.powerUntil = 0;
  p.angle      = Math.atan2(ISLAND_CY - p.y, ISLAND_CX - p.x);
}

function applyItem(p, item, now) {
  if (item.type === 'stamina') p.stamina = MAX_STAMINA;
  else p.powerUntil = now + POWER_DURATION_MS;
}

// ─── Punch ────────────────────────────────────────────────────────────────────
function handlePunch(p, now) {
  if (!p.alive)                                   return;
  if (p.stamina < PUNCH_COST)                     return;
  if (now - p.lastPunchTime < PUNCH_COOLDOWN_MS)  return;

  p.stamina      -= PUNCH_COST;
  p.lastPunchTime = now;
  p.punchTime     = now;

  for (const opp of gs.players.values()) {
    if (opp.id === p.id || !opp.alive) continue;
    const dx   = opp.x - p.x, dy = opp.y - p.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > PUNCH_RANGE * PUNCH_RANGE) continue;
    // Must be facing the opponent (within ±90° of facing direction)
    const faceDot = Math.cos(p.angle) * dx + Math.sin(p.angle) * dy;
    if (faceDot <= 0) continue;

    const isPower = p.powerUntil > 0 && now < p.powerUntil;
    const dmg     = isPower ? Math.round(PUNCH_DAMAGE * POWER_MULT) : PUNCH_DAMAGE;
    const kb      = isPower ? PUNCH_KNOCKBACK * POWER_MULT : PUNCH_KNOCKBACK;
    const dist    = Math.sqrt(dist2) || 1;

    opp.velX += (dx / dist) * kb;
    opp.velY += (dy / dist) * kb;
    opp.hp    = Math.max(0, opp.hp - dmg);
    opp.hitTime     = now;
    opp.lastHitBy   = p.id;
    opp.lastHitTime = now;

    if (opp.hp <= 0) killPlayer(opp, now);
    break; // one target per punch
  }
}

// ─── Items ────────────────────────────────────────────────────────────────────
function updateItems(dt) {
  gs.itemTimer -= dt * 1000;
  if (gs.itemTimer <= 0 && gs.items.length < MAX_ITEMS) {
    const types    = gs.items.map(i => i.type);
    const hasSt    = types.includes('stamina');
    const hasPw    = types.includes('power');
    const type     = hasSt && !hasPw ? 'power' : !hasSt && hasPw ? 'stamina' : null;
    gs.items.push(makeItem(type));
    gs.itemTimer = ITEM_SPAWN_MS;
  }
}

// ─── Sea chickens ─────────────────────────────────────────────────────────────

// Returns true if segment (x1,y1)→(x2,y2) passes through circle (cx,cy,r)
function segmentIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const fx = x1 - cx, fy = y1 - cy;
  const a  = dx * dx + dy * dy;
  const b  = 2 * (fx * dx + fy * dy);
  const c  = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  return (t1 > 0.01 && t1 < 0.99) || (t2 > 0.01 && t2 < 0.99);
}

function updateSeaChickens(dt, now) {
  const activeKill = gs.killEvents.find(e => now - e.time < RESPAWN_MS + 500);
  const clearance  = ISLAND_R + 28;  // radius chickens must stay outside

  for (const c of gs.seaChickens) {
    if (activeKill) {
      const tx = activeKill.x, ty = activeKill.y;
      const dx = tx - c.x,     dy = ty - c.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < 18) continue;

      const rushSpeed = c.speed * 3.5 * dt;
      let moveX, moveY;

      if (!segmentIntersectsCircle(c.x, c.y, tx, ty, ISLAND_CX, ISLAND_CY, clearance)) {
        // Clear path — go straight
        moveX   = (dx / d) * rushSpeed;
        moveY   = (dy / d) * rushSpeed;
        c.angle = Math.atan2(dy, dx);
      } else {
        // Island is in the way — go around perimeter
        const angleChicken = Math.atan2(c.y - ISLAND_CY, c.x - ISLAND_CX);
        const angleTarget  = Math.atan2(ty  - ISLAND_CY, tx  - ISLAND_CX);
        let   delta        = angleTarget - angleChicken;
        while (delta >  Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;

        // Tangent direction: ±90° from radial, toward the shorter arc
        const tangAngle = angleChicken + (delta > 0 ? Math.PI / 2 : -Math.PI / 2);
        let   tangX     = Math.cos(tangAngle);
        let   tangY     = Math.sin(tangAngle);

        // If chicken drifted inside the clearance radius, also push outward
        const distFromCenter = Math.sqrt((c.x - ISLAND_CX) ** 2 + (c.y - ISLAND_CY) ** 2);
        if (distFromCenter < clearance) {
          const radX = (c.x - ISLAND_CX) / distFromCenter;
          const radY = (c.y - ISLAND_CY) / distFromCenter;
          tangX = tangX * 0.65 + radX * 0.5;
          tangY = tangY * 0.65 + radY * 0.5;
          const len = Math.sqrt(tangX * tangX + tangY * tangY);
          tangX /= len; tangY /= len;
        }

        moveX   = tangX * rushSpeed;
        moveY   = tangY * rushSpeed;
        c.angle = Math.atan2(tangY, tangX);
      }

      const nx = c.x + moveX, ny = c.y + moveY;
      if (nx > 10 && nx < ARENA_W - 10 && ny > 10 && ny < ARENA_H - 10) {
        c.x = nx; c.y = ny;
      }

    } else {
      // Normal wandering
      c.turnTimer -= dt * 1000;
      if (c.turnTimer <= 0) {
        c.angle     = c.angle + (Math.random() - 0.5) * 2.5;
        c.turnTimer = 900 + Math.random() * 1800;
      }
      const nx = c.x + Math.cos(c.angle) * c.speed * dt;
      const ny = c.y + Math.sin(c.angle) * c.speed * dt;
      const dist2 = (nx - ISLAND_CX) ** 2 + (ny - ISLAND_CY) ** 2;
      if (dist2 > (ISLAND_R + 18) ** 2 && nx > 20 && nx < ARENA_W - 20 && ny > 20 && ny < ARENA_H - 20) {
        c.x = nx; c.y = ny;
      } else {
        c.angle     = Math.atan2(ISLAND_CY - c.y, ISLAND_CX - c.x) + (Math.random() - 0.5) * 1.8;
        c.turnTimer = 400;
      }
    }
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(now) {
  const payload = JSON.stringify(buildPayload(now));
  const msg     = 'data: ' + payload + '\n\n';
  for (const [id, res] of gs.clients) {
    try { res.write(msg); } catch (_) { gs.clients.delete(id); }
  }
}

function buildPayload(now) {
  const players = [];
  for (const p of gs.players.values()) {
    players.push({
      id: p.id, name: p.name, playerIndex: p.playerIndex,
      x: Math.round(p.x), y: Math.round(p.y), angle: p.angle,
      hp:      Math.max(0, Math.round(p.hp)),
      stamina: Math.round(p.stamina),
      powerUntil: p.powerUntil,
      alive:       p.alive,
      respawnAt:   p.respawnAt,
      respawnedAt: p.respawnedAt,
      score:       p.score,
      punchTime:         p.punchTime,
      hitTime:           p.hitTime,
      scoreEventDelta:   p.scoreEventDelta,
      scoreEventTime:    p.scoreEventTime,
    });
  }
  const goToLobby = gs.goToLobby;
  if (gs.goToLobby) gs.goToLobby = false;
  return {
    phase:       gs.phase,
    goToLobby,
    players,
    items:       gs.items,
    seaChickens: gs.seaChickens.map(c => ({
      id: c.id, x: Math.round(c.x), y: Math.round(c.y),
      angle: c.angle, bobOffset: c.bobOffset,
    })),
    killEvents:  gs.killEvents,
    roundEndsAt: gs.roundEndsAt,
    roundResult: gs.roundResult,
    serverTime:  now,
    playerCount: gs.players.size,
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url    = new URL(req.url, 'http://localhost');
  const method = req.method;
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/api/join' && method === 'POST') {
    readBody(req, (raw) => {
      const { name } = JSON.parse(raw);
      if (gs.players.size >= MAX_PLAYERS) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sala llena (máx. 6 jugadores)' }));
        return;
      }
      const id          = Math.random().toString(36).slice(2, 10);
      const playerIndex = gs.players.size;
      gs.players.set(id, {
        id, name: (name || 'Jugador').slice(0, 16), playerIndex,
        x: ISLAND_CX, y: ISLAND_CY,
        velX: 0, velY: 0, angle: 0,
        dirX: 0, dirY: 0,
        action: false, prevAction: false,
        hp: MAX_HP, stamina: MAX_STAMINA,
        lastPunchTime: 0, powerUntil: 0,
        score: 0, alive: true,
        respawnAt: 0, respawnedAt: 0,
        lastHitBy: null, lastHitTime: 0,
        punchTime: 0, hitTime: 0,
        scoreEventDelta: 0, scoreEventTime: 0,
        lastSeen: Date.now(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        playerId: id, playerIndex,
        config: { ARENA_W, ARENA_H, ISLAND_CX, ISLAND_CY, ISLAND_R, PLAYER_R, MAX_HP, MAX_STAMINA, POWER_DURATION_MS, ROUND_MS },
      }));
    });
    return;
  }

  if (url.pathname === '/api/input' && method === 'POST') {
    readBody(req, (raw) => {
      const { playerId, dirX, dirY, action } = JSON.parse(raw);
      const p = gs.players.get(playerId);
      if (p) {
        p.lastSeen = Date.now();
        if (gs.phase === 'playing' && p.alive) {
          if (typeof dirX === 'number') p.dirX = Math.max(-1, Math.min(1, dirX));
          if (typeof dirY === 'number') p.dirY = Math.max(-1, Math.min(1, dirY));
          p.action = !!action;
          if (action && !p.prevAction) handlePunch(p, Date.now());
          p.prevAction = !!action;
        }
      }
      res.writeHead(204); res.end();
    });
    return;
  }

  if (url.pathname === '/api/events' && method === 'GET') {
    const playerId = url.searchParams.get('playerId');
    if (!playerId || !gs.players.has(playerId)) { res.writeHead(400); res.end('Not joined'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    gs.clients.set(playerId, res);
    req.on('close', () => gs.clients.delete(playerId));
    return;
  }

  if (url.pathname === '/api/leave' && method === 'POST') {
    readBody(req, (raw) => {
      const { playerId } = JSON.parse(raw);
      gs.players.delete(playerId);
      const cl = gs.clients.get(playerId);
      if (cl) { try { cl.end(); } catch (_) {} gs.clients.delete(playerId); }
    });
    res.writeHead(204); res.end();
    return;
  }

  if (url.pathname === '/api/start' && method === 'POST') {
    if (gs.phase === 'waiting' && gs.players.size >= MIN_START) startRound(Date.now());
    res.writeHead(204); res.end();
    return;
  }

  if (url.pathname === '/api/endgame' && method === 'POST') {
    // Broadcast goToLobby first, then clean up after clients have received it
    gs.goToLobby = true;
    const lobbyMsg = 'data: ' + JSON.stringify({ goToLobby: true }) + '\n\n';
    for (const [id, cl] of gs.clients) {
      try { cl.write(lobbyMsg); } catch (_) {}
    }
    setTimeout(() => {
      gs.phase = 'waiting'; gs.roundResult = null; gs.items = []; gs.killEvents = []; gs.itemTimer = ITEM_SPAWN_MS;
      gs.goToLobby = false;
      gs.players.clear();
      for (const cl of gs.clients.values()) { try { cl.end(); } catch (_) {} }
      gs.clients.clear();
    }, 300);
    res.writeHead(204); res.end();
    return;
  }

  if (url.pathname === '/api/restart' && method === 'POST') {
    if (gs.phase === 'ended') startRound(Date.now()); // keeps scores
    res.writeHead(204); res.end();
    return;
  }

  const rel      = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.join(__dirname, 'public', rel);
  const ext      = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString()));
}

server.listen(PORT, () => {
  console.log(`Boxing Island corriendo en http://localhost:${PORT}`);
  startGameLoop();
});
