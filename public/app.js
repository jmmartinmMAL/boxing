'use strict';

// ─── Constants (mirrored/overridden from server config) ───────────────────────
let ARENA_W          = 1280;
let ARENA_H          = 720;
let ISLAND_CX        = 640;
let ISLAND_CY        = 360;
let ISLAND_R         = 250;
let PLAYER_R         = 20;
let MAX_HP           = 100;
let MAX_STAMINA      = 100;
let POWER_DURATION_MS = 5000;
let ROUND_MS         = 90000;

const PLAYER_COLORS = ['#e74c3c', '#2980b9', '#27ae60', '#f39c12', '#9b59b6', '#16a085'];
const PLAYER_LIGHT  = ['#ff8a80', '#90caf9', '#a5d6a7', '#ffe082', '#ce93d8', '#80cbc4'];
const PLAYER_LABEL  = ['1', '2', '3', '4', '5', '6'];

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, type, duration, vol, freqEnd) {
  try {
    const ac  = getAudio();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime);
    if (freqEnd !== undefined) osc.frequency.linearRampToValueAtTime(freqEnd, ac.currentTime + duration);
    gain.gain.setValueAtTime(vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    osc.start(); osc.stop(ac.currentTime + duration);
  } catch (_) {}
}
function playNoise(duration, vol, highpass) {
  try {
    const ac  = getAudio();
    const buf = ac.createBuffer(1, ac.sampleRate * duration, ac.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src  = ac.createBufferSource();
    const filt = ac.createBiquadFilter();
    const gain = ac.createGain();
    src.buffer = buf;
    filt.type = 'highpass'; filt.frequency.value = highpass || 800;
    src.connect(filt); filt.connect(gain); gain.connect(ac.destination);
    gain.gain.setValueAtTime(vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    src.start(); src.stop(ac.currentTime + duration);
  } catch (_) {}
}

const SFX = {
  punch()   { playNoise(0.08, 0.7, 400); playTone(120, 'sine', 0.08, 0.4, 60); },
  hit()     { playNoise(0.12, 0.9, 200); playTone(80, 'sawtooth', 0.12, 0.5, 40); },
  splash()  { playNoise(0.35, 0.6, 80); playTone(300, 'sine', 0.35, 0.3, 60); },
  chicken() { playTone(800, 'square', 0.06, 0.15, 1200); setTimeout(() => playTone(1000, 'square', 0.06, 0.12, 600), 80); },
  item()    { playTone(660, 'sine', 0.1, 0.4); playTone(880, 'sine', 0.1, 0.3); },
  win()     {
    [0, 120, 240].forEach(d => setTimeout(() => playTone(523 + d * 2, 'sine', 0.25, 0.4), d));
    setTimeout(() => playTone(1047, 'sine', 0.5, 0.5), 400);
  },
  lose()    { playTone(300, 'sawtooth', 0.4, 0.3, 150); },
};

// track previous state for sound triggers
let prevPunchTimes = {};
let prevHitTimes   = {};
let prevKillCount  = 0;
let prevPhase      = null;
let prevItemCount  = 0;

function triggerSounds(state) {
  if (!state) return;
  const { players, killEvents, phase, items } = state;

  // Punch / hit sounds
  if (players) {
    for (const p of players) {
      if (p.punchTime && p.punchTime !== prevPunchTimes[p.id]) {
        SFX.punch(); prevPunchTimes[p.id] = p.punchTime;
      }
      if (p.hitTime && p.hitTime !== prevHitTimes[p.id]) {
        SFX.hit(); prevHitTimes[p.id] = p.hitTime;
      }
    }
  }

  // Splash (new kill event)
  const kCount = killEvents ? killEvents.length : 0;
  if (kCount > prevKillCount) { SFX.splash(); SFX.chicken(); }
  prevKillCount = kCount;

  // Item pickup (item count dropped)
  const iCount = items ? items.length : 0;
  if (iCount < prevItemCount) SFX.item();
  prevItemCount = iCount;

  // Round end
  if (phase === 'ended' && prevPhase === 'playing') {
    setTimeout(() => {
      const result = state.roundResult;
      if (result && result.winnerId === myId) SFX.win(); else SFX.lose();
    }, 300);
  }
  prevPhase = phase;
}

// ─── State ────────────────────────────────────────────────────────────────────
let myId          = null;
let myPlayerIndex = -1;
let gameState     = null;
let timeNow       = Date.now();

let inputDirX   = 0;
let inputDirY   = 0;
let inputAction = false;

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game');
const ctx    = canvas.getContext('2d');
canvas.width  = ARENA_W;
canvas.height = ARENA_H;

// ─── UI ───────────────────────────────────────────────────────────────────────
const lobby          = document.getElementById('lobby');
const gameUI         = document.getElementById('game-ui');
const nameInput      = document.getElementById('name-input');
const joinBtn        = document.getElementById('join-btn');
const lobbyError     = document.getElementById('lobby-error');
const waitingOverlay = document.getElementById('waiting-overlay');
const waitingText    = document.getElementById('waiting-text');
const resultOverlay  = document.getElementById('result-overlay');
const resultIcon     = document.getElementById('result-icon');
const resultText     = document.getElementById('result-text');
const resultScores   = document.getElementById('result-scores');
const restartBtn     = document.getElementById('restart-btn');

joinBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
restartBtn.addEventListener('click', requestRestart);

// ─── Join ─────────────────────────────────────────────────────────────────────
async function joinGame() {
  const name = nameInput.value.trim() || 'Jugador';
  joinBtn.disabled = true; lobbyError.textContent = '';
  try {
    const res = await fetch('/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      lobbyError.textContent = err.error || 'Error al unirse';
      joinBtn.disabled = false; return;
    }
    const data = await res.json();
    myId = data.playerId; myPlayerIndex = data.playerIndex;
    getAudio(); // unlock AudioContext on user gesture
    if (data.config) {
      ({ ARENA_W, ARENA_H, ISLAND_CX, ISLAND_CY, ISLAND_R, PLAYER_R, MAX_HP, MAX_STAMINA, POWER_DURATION_MS, ROUND_MS } = data.config);
      canvas.width = ARENA_W; canvas.height = ARENA_H;
    }
    lobby.style.display = 'none'; gameUI.style.display = 'flex';
    connectSSE(); startInputLoop(); requestAnimationFrame(render);
    window.addEventListener('beforeunload', () => {
      navigator.sendBeacon('/api/leave', JSON.stringify({ playerId: myId }));
    });
  } catch (_) {
    lobbyError.textContent = 'No se pudo conectar al servidor';
    joinBtn.disabled = false;
  }
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`/api/events?playerId=${myId}`);
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.type === 'connected') return;
    if (data.goToLobby) {
      myId = null; myPlayerIndex = -1; gameState = null;
      gameUI.style.display = 'none'; lobby.style.display = 'flex';
      joinBtn.disabled = false;
      return;
    }
    triggerSounds(data);
    gameState = data; updateOverlays();
  };
  es.onerror = () => setTimeout(connectSSE, 2000);
}

function updateOverlays() {
  if (!gameState) return;
  const { phase, playerCount, roundResult } = gameState;
  if (phase === 'waiting') {
    waitingOverlay.style.display = 'flex'; resultOverlay.style.display = 'none';
    waitingText.textContent = `Esperando jugadores… ${playerCount}/6`;
    document.getElementById('start-now-btn').style.display = playerCount >= 2 ? 'block' : 'none';
  } else if (phase === 'playing') {
    waitingOverlay.style.display = 'none'; resultOverlay.style.display = 'none';
  } else if (phase === 'ended' && roundResult) {
    waitingOverlay.style.display = 'none'; resultOverlay.style.display = 'flex';
    const { winnerId, scores } = roundResult;
    if (winnerId === myId) {
      resultIcon.textContent = '🏆'; resultText.textContent = '¡GANASTE!';
    } else if (!winnerId) {
      resultIcon.textContent = '🤝'; resultText.textContent = 'Empate';
    } else {
      const winner = scores.find(s => s.id === winnerId);
      resultIcon.textContent = '💀'; resultText.textContent = `¡${winner ? winner.name : '?'} gana!`;
    }
    // Scoreboard table
    let html = '<table style="border-collapse:collapse;width:100%;margin-top:8px">';
    scores.forEach((s, i) => {
      const col = PLAYER_COLORS[s.playerIndex] || '#fff';
      const isMe = s.id === myId;
      html += `<tr style="opacity:${i===0?1:0.85}">
        <td style="padding:4px 8px;color:${col};font-weight:700">${i===0?'🥇':i===1?'🥈':i===2?'🥉':''} ${s.name}${isMe?' ★':''}</td>
        <td style="padding:4px 12px;color:#ffd54f;font-weight:900;font-size:1.2rem;text-align:right">${s.score}</td>
      </tr>`;
    });
    html += '</table>';
    resultScores.innerHTML = html;
  }
}

async function startNow() { try { await fetch('/api/start', { method: 'POST' }); } catch (_) {} }
async function requestRestart() { try { await fetch('/api/restart', { method: 'POST' }); } catch (_) {} }
async function endGame() {
  if (!confirm('¿Terminar la partida y volver al lobby?')) return;
  try { await fetch('/api/endgame', { method: 'POST' }); } catch (_) {}
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') { inputAction = true; e.preventDefault(); }
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space') inputAction = false;
});

let kbDirX = 0, kbDirY = 0;
function processKeyboard() {
  let dx = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0);
  let dy = (keys['KeyS'] || keys['ArrowDown']  ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp']    ? 1 : 0);
  if (dx !== 0 && dy !== 0) { const inv = 1 / Math.SQRT2; dx *= inv; dy *= inv; }
  kbDirX = dx; kbDirY = dy;
}

// ─── Input loop ────────────────────────────────────────────────────────────────
let jDirX = 0, jDirY = 0;

function startInputLoop() { setInterval(sendInput, 50); }

async function sendInput() {
  if (!myId) return;
  processKeyboard();
  const dx = jDirX !== 0 || jDirY !== 0 ? jDirX : kbDirX;
  const dy = jDirX !== 0 || jDirY !== 0 ? jDirY : kbDirY;
  inputDirX = dx; inputDirY = dy;
  try {
    await fetch('/api/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: myId, dirX: inputDirX, dirY: inputDirY, action: inputAction }),
    });
  } catch (_) {}
}

// ─── Touch ────────────────────────────────────────────────────────────────────
(function setupTouch() {
  const jZone = document.getElementById('joystick-zone');
  const jThumb = document.getElementById('joystick-thumb');
  const aBtn   = document.getElementById('action-btn');
  const MAX_R  = 50;
  let jActive = false, jSX = 0, jSY = 0;

  jZone.addEventListener('touchstart', e => {
    e.preventDefault(); jActive = true;
    jSX = e.changedTouches[0].clientX; jSY = e.changedTouches[0].clientY;
  }, { passive: false });
  jZone.addEventListener('touchmove', e => {
    e.preventDefault(); if (!jActive) return;
    const dx = e.changedTouches[0].clientX - jSX;
    const dy = e.changedTouches[0].clientY - jSY;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d > 12) { jDirX = dx / d; jDirY = dy / d; } else { jDirX = 0; jDirY = 0; }
    const clamp = Math.min(d, MAX_R);
    const tx = d > 0 ? (dx / d) * clamp : 0;
    const ty = d > 0 ? (dy / d) * clamp : 0;
    jThumb.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
  }, { passive: false });
  const jEnd = e => {
    e.preventDefault(); jActive = false; jDirX = 0; jDirY = 0;
    jThumb.style.transform = 'translate(-50%, -50%)';
  };
  jZone.addEventListener('touchend', jEnd, { passive: false });
  jZone.addEventListener('touchcancel', jEnd, { passive: false });

  aBtn.addEventListener('touchstart', e => { e.preventDefault(); inputAction = true; aBtn.classList.add('pressed'); }, { passive: false });
  const aEnd = e => { e.preventDefault(); inputAction = false; aBtn.classList.remove('pressed'); };
  aBtn.addEventListener('touchend', aEnd, { passive: false });
  aBtn.addEventListener('touchcancel', aEnd, { passive: false });
})();

// ─── Render loop ──────────────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);
  timeNow = Date.now();
  ctx.clearRect(0, 0, ARENA_W, ARENA_H);
  drawWater();
  drawIsland();
  if (gameState) {
    drawKillEvents();
    drawItems();
    drawDeadPlayers();
    drawSeaChickens();
    drawAlivePlayers();
    drawHUD();
  } else {
    ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText('Conectando…', ARENA_W / 2, ARENA_H / 2);
  }
}

// ─── Water ────────────────────────────────────────────────────────────────────
function drawWater() {
  const grad = ctx.createRadialGradient(ISLAND_CX, ISLAND_CY, ISLAND_R * 0.5, ISLAND_CX, ISLAND_CY, ARENA_W);
  grad.addColorStop(0, '#0d47a1'); grad.addColorStop(0.5, '#1565c0'); grad.addColorStop(1, '#0a2060');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  // Expanding rings
  const t = timeNow / 1000;
  ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const r = ISLAND_R + 30 + ((t * 28 + i * 70) % 340);
    ctx.beginPath(); ctx.arc(ISLAND_CX, ISLAND_CY, r, 0, Math.PI * 2); ctx.stroke();
  }

  // Wave pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
  for (let y = 0; y < ARENA_H; y += 28) {
    ctx.beginPath();
    for (let x = 0; x <= ARENA_W; x += 7) {
      const wy = y + Math.sin((x / 85) + timeNow / 950 + y * 0.008) * 4.5;
      x === 0 ? ctx.moveTo(x, wy) : ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }
}

// ─── Island ───────────────────────────────────────────────────────────────────
function drawIsland() {
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.arc(ISLAND_CX + 7, ISLAND_CY + 10, ISLAND_R, 0, Math.PI * 2); ctx.fill();

  // Main body gradient
  const grad = ctx.createRadialGradient(
    ISLAND_CX - ISLAND_R * 0.25, ISLAND_CY - ISLAND_R * 0.2, 0,
    ISLAND_CX, ISLAND_CY, ISLAND_R);
  grad.addColorStop(0,    '#81c784');
  grad.addColorStop(0.55, '#43a047');
  grad.addColorStop(0.82, '#2e7d32');
  grad.addColorStop(1,    '#1b5e20');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(ISLAND_CX, ISLAND_CY, ISLAND_R, 0, Math.PI * 2); ctx.fill();

  // Danger edge (subtle red ring)
  ctx.strokeStyle = 'rgba(255,80,0,0.22)'; ctx.lineWidth = 22;
  ctx.beginPath(); ctx.arc(ISLAND_CX, ISLAND_CY, ISLAND_R - 11, 0, Math.PI * 2); ctx.stroke();

  // Grass texture dots (deterministic)
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  for (let i = 0; i < 24; i++) {
    const a = i * 1.618; // golden angle
    const r = 25 + (i * 41) % (ISLAND_R - 40);
    ctx.beginPath(); ctx.arc(ISLAND_CX + Math.cos(a) * r, ISLAND_CY + Math.sin(a) * r, 7 + (i * 11) % 18, 0, Math.PI * 2); ctx.fill();
  }

  // Perimeter rocks
  ctx.fillStyle = '#4e342e';
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    ctx.beginPath(); ctx.arc(ISLAND_CX + Math.cos(a) * (ISLAND_R - 7), ISLAND_CY + Math.sin(a) * (ISLAND_R - 7), 5 + (i % 3) * 2, 0, Math.PI * 2); ctx.fill();
  }

  // Edge outline
  ctx.strokeStyle = '#1b5e20'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(ISLAND_CX, ISLAND_CY, ISLAND_R, 0, Math.PI * 2); ctx.stroke();
}

// ─── Kill events (splash) ─────────────────────────────────────────────────────
function drawKillEvents() {
  if (!gameState.killEvents) return;
  for (const evt of gameState.killEvents) {
    const elapsed = timeNow - evt.time;
    if (elapsed < 0 || elapsed > 3200) continue;
    const frac = elapsed / 3200;

    ctx.save();
    ctx.translate(evt.x, evt.y);

    // Splash particles
    ctx.globalAlpha = Math.max(0, (1 - frac) * 0.75);
    for (let s = 0; s < 8; s++) {
      const sa = (s / 8) * Math.PI * 2 + elapsed / 110;
      const sr = 12 + frac * 45;
      ctx.fillStyle = '#90caf9';
      const psize = Math.max(0, 5 - frac * 3);
      ctx.beginPath(); ctx.arc(Math.cos(sa) * sr, Math.sin(sa) * sr, psize, 0, Math.PI * 2); ctx.fill();
    }

    // Chomp emoji floating up
    if (elapsed < 1400) {
      ctx.globalAlpha = 1 - elapsed / 1400;
      ctx.font = `bold ${Math.round(22 - frac * 8)}px Arial`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
      ctx.fillText('🍗', 0, -18 - frac * 30);
      ctx.shadowBlur = 0;
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ─── Items ────────────────────────────────────────────────────────────────────
function drawItems() {
  if (!gameState.items) return;
  for (const item of gameState.items) {
    const pulse = 0.88 + Math.sin(timeNow / 260) * 0.12;
    ctx.save();
    ctx.translate(item.x, item.y);
    if (item.type === 'stamina') {
      ctx.shadowColor = '#00e676'; ctx.shadowBlur = 14 * pulse;
      ctx.fillStyle   = '#69f0ae'; ctx.strokeStyle = '#00e676'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 14 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = `${Math.round(13 * pulse)}px Arial`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText('⚡', 0, 5);
    } else {
      ctx.shadowColor = '#ff9800'; ctx.shadowBlur = 14 * pulse;
      ctx.fillStyle   = '#ffcc02'; ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 14 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = `${Math.round(13 * pulse)}px Arial`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText('💪', 0, 5);
    }
    ctx.restore();
  }
}

// ─── Dead players in water ────────────────────────────────────────────────────
function drawDeadPlayers() {
  if (!gameState.players) return;
  const st = gameState.serverTime || timeNow;
  for (const p of gameState.players) {
    if (p.alive) continue;
    const col      = PLAYER_COLORS[p.playerIndex];
    const diedAt   = p.respawnAt - 2000; // approximate when they died
    const elapsed  = timeNow - diedAt;
    const frac     = Math.min(1, Math.max(0, elapsed / 2000));

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(frac * Math.PI * 1.5);
    ctx.globalAlpha = Math.max(0, 1 - frac * 0.9);
    const sc = 1 - frac * 0.4;
    ctx.scale(sc, sc);

    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, PLAYER_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // Bubbles
    for (let b = 0; b < 4; b++) {
      const ba = b * Math.PI / 2 + timeNow / 180;
      ctx.fillStyle = 'rgba(180,220,255,0.55)';
      ctx.beginPath(); ctx.arc(Math.cos(ba) * 14, Math.sin(ba) * 14, 3, 0, Math.PI * 2); ctx.fill();
    }

    // Respawn countdown
    const remaining = p.respawnAt - st;
    if (remaining > 0) {
      ctx.globalAlpha = 0.9;
      ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center';
      ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText(`${Math.ceil(remaining / 1000)}s`, 0, 5);
      ctx.shadowBlur = 0;
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ─── Sea chickens ─────────────────────────────────────────────────────────────
function drawSeaChickens() {
  if (!gameState.seaChickens) return;
  // Check if any kill event is active (for rushing chickens visual cue)
  const hasKill = gameState.killEvents && gameState.killEvents.some(e => timeNow - e.time < 2500);
  for (const c of gameState.seaChickens) {
    const bob   = Math.sin(timeNow / 420 + c.bobOffset) * 0.1;
    const angry = hasKill;
    drawSeaChicken(c.x, c.y, c.angle, angry, bob);
  }
}

function drawSeaChicken(cx, cy, angle, angry, bob) {
  const scale = 1 + bob;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle + Math.PI / 2);
  ctx.scale(scale, scale);

  // Water ripple
  ctx.fillStyle = 'rgba(0,30,100,0.18)';
  ctx.beginPath(); ctx.ellipse(0, 2, 15, 9, 0, 0, Math.PI * 2); ctx.fill();

  // Body
  ctx.fillStyle   = angry ? '#fff176' : '#fdd835';
  ctx.strokeStyle = angry ? '#e65100' : '#f57f17';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // Beak (points up = forward)
  ctx.fillStyle = angry ? '#ff5722' : '#ff8f00';
  ctx.beginPath(); ctx.moveTo(-4, -10); ctx.lineTo(4, -10); ctx.lineTo(0, angry ? -18 : -16); ctx.closePath(); ctx.fill();

  // Eye (bigger when angry)
  ctx.fillStyle = angry ? '#f44336' : '#111';
  ctx.beginPath(); ctx.arc(0, -4, angry ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(1, -5, 1, 0, Math.PI * 2); ctx.fill();

  // Comb
  ctx.fillStyle = '#d32f2f';
  ctx.beginPath(); ctx.arc(0, -14, angry ? 5 : 4, 0, Math.PI * 2); ctx.fill();

  // Wings
  const wAng = Math.sin(timeNow / (angry ? 80 : 220)) * 0.6;
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(side * 8, 3); ctx.rotate(wAng * side);
    ctx.fillStyle = '#ffca28';
    ctx.beginPath(); ctx.ellipse(0, 7, 5, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

// ─── Alive players ────────────────────────────────────────────────────────────
function drawAlivePlayers() {
  if (!gameState.players) return;
  for (const p of gameState.players) {
    if (!p.alive) continue;
    drawPlayer(p);
  }
}

function drawPlayer(p) {
  const isMe       = p.id === myId;
  const col        = PLAYER_COLORS[p.playerIndex];
  const light      = PLAYER_LIGHT[p.playerIndex];
  const isPower    = p.powerUntil > 0 && timeNow < p.powerUntil;
  const isPunching = p.punchTime > 0 && timeNow - p.punchTime < 260;
  const isHit      = p.hitTime   > 0 && timeNow - p.hitTime   < 320;

  const shakeX = isHit ? Math.sin(timeNow / 26) * 5 : 0;
  const shakeY = isHit ? Math.cos(timeNow / 26) * 3 : 0;

  ctx.save();
  ctx.translate(p.x + shakeX, p.y + shakeY);

  // Rotate everything to facing direction
  ctx.rotate(p.angle);

  const TW = PLAYER_R;        // torso half-width (along facing)
  const TH = PLAYER_R * 0.65; // torso half-height (perpendicular)
  const HEAD_R  = PLAYER_R * 0.42;
  const HEAD_FX = TW * 0.7;  // head center offset forward from body center

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(3, 3, TW + 2, TH + 2, 0, 0, Math.PI * 2); ctx.fill();

  // HP arc around torso (world-aligned: unrotate for arc)
  const hpFrac = p.hp / MAX_HP;
  ctx.save();
  ctx.rotate(-p.angle);
  ctx.strokeStyle = hpFrac > 0.6 ? '#4caf50' : hpFrac > 0.3 ? '#ff9800' : '#f44336';
  ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(0, 0, TW + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpFrac); ctx.stroke();
  ctx.restore();

  // Torso (ellipse)
  if (isHit) { ctx.shadowColor = '#ff1744'; ctx.shadowBlur = 20; }
  else if (isPower) { ctx.shadowColor = '#ff9800'; ctx.shadowBlur = 16 + Math.sin(timeNow / 80) * 5; }
  else if (isMe) { ctx.shadowColor = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 14; }
  ctx.fillStyle   = col;
  ctx.strokeStyle = isMe ? '#fff' : 'rgba(0,0,0,0.45)';
  ctx.lineWidth   = isMe ? 3 : 2;
  ctx.beginPath(); ctx.ellipse(0, 0, TW, TH, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;

  // Hit overlay on torso
  if (isHit) { ctx.fillStyle = 'rgba(255,23,68,0.42)'; ctx.beginPath(); ctx.ellipse(0, 0, TW, TH, 0, 0, Math.PI * 2); ctx.fill(); }

  // Shorts stripe (lower half of torso)
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(0, 0, TW, TH, 0, 0.2, Math.PI - 0.2); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();

  // Head
  ctx.fillStyle   = light;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.arc(HEAD_FX, 0, HEAD_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // Number on torso
  ctx.save();
  ctx.rotate(-p.angle); // keep number upright
  ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(PLAYER_LABEL[p.playerIndex], 0, 4);
  ctx.restore();

  // ── Gloves ──────────────────────────────────────────────────────────────────
  const gloveR   = isPower ? 12 : 9;
  const gloveCol = isPower ? '#ff9800' : light;
  const gloveStk = isPower ? '#e65100' : col;
  // Rest: gloves at sides (gx≈0). Punch: swing forward along facing axis.
  const gloveRestX  = -TW * 0.1;           // slightly behind center
  const glovePunchX =  TW * 0.9;           // clearly extended forward
  const gloveRestY  =  TH + 8;             // perpendicular offset
  const glovePunchY =  TH + 2;             // slightly inward when punching

  if (isPower) { ctx.shadowColor = '#ff9800'; ctx.shadowBlur = 12; }
  ctx.fillStyle = gloveCol; ctx.strokeStyle = gloveStk; ctx.lineWidth = 2;

  for (const side of [-1, 1]) {
    const gx = isPunching ? glovePunchX : gloveRestX;
    const gy = side * (isPunching ? glovePunchY : gloveRestY);
    ctx.beginPath(); ctx.arc(gx, gy, gloveR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = isPower ? '#bf360c' : 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.2;
    for (let k = -1; k <= 1; k++) {
      const ang = k * 0.28;
      ctx.beginPath();
      ctx.moveTo(gx + Math.cos(ang) * 3, gy + Math.sin(ang) * 3);
      ctx.lineTo(gx + Math.cos(ang) * (gloveR - 2), gy + Math.sin(ang) * (gloveR - 2));
      ctx.stroke();
    }
    ctx.strokeStyle = gloveStk;
  }
  ctx.shadowBlur = 0;

  // Power timer ring
  if (isPower) {
    const frac = Math.max(0, (p.powerUntil - timeNow) / POWER_DURATION_MS);
    ctx.save();
    ctx.rotate(-p.angle);
    ctx.strokeStyle = 'rgba(255,152,0,0.75)'; ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(0, 0, TW + 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  ctx.restore();

  // ── Name + score floating above ────────────────────────────────────────────
  ctx.save();
  ctx.font = `bold 12px Arial`; ctx.textAlign = 'center';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillStyle = isMe ? '#ffd54f' : '#ddd';
  ctx.fillText(p.name, p.x + shakeX, p.y + shakeY - PLAYER_R - 18);
  ctx.font = 'bold 11px Arial'; ctx.fillStyle = col;
  ctx.fillText(`★ ${p.score}`, p.x + shakeX, p.y + shakeY - PLAYER_R - 6);
  ctx.shadowBlur = 0;
  ctx.restore();

  // ── Stamina bar ────────────────────────────────────────────────────────────
  const barW = 52, barH = 5;
  const bx   = p.x + shakeX - barW / 2;
  const by   = p.y + shakeY + PLAYER_R + 10;
  const stPct = p.stamina / MAX_STAMINA;
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
  ctx.fillStyle = '#111'; ctx.fillRect(bx, by, barW, barH);
  ctx.fillStyle = stPct > 0.5 ? '#4caf50' : stPct > 0.25 ? '#ff9800' : '#f44336';
  ctx.fillRect(bx, by, barW * stPct, barH);

}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function drawHUD() {
  if (!gameState) return;
  const { players, phase, playerCount } = gameState;

  // ── Scoreboard (top right) ─────────────────────────────────────────────────
  if (players && players.length > 0) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const sbX = ARENA_W - 174, sbY = 8;
    const sbW = 166, sbH = 22 + sorted.length * 25 + 6;

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    roundRect(ctx, sbX, sbY, sbW, sbH, 8); ctx.fill();

    ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.fillText('VICTORIAS', sbX + sbW / 2, sbY + 14);

    sorted.forEach((p, rank) => {
      const py   = sbY + 22 + rank * 25;
      const isMe = p.id === myId;
      const col  = PLAYER_COLORS[p.playerIndex];

      if (isMe) { ctx.fillStyle = 'rgba(255,255,255,0.09)'; ctx.fillRect(sbX + 4, py - 1, sbW - 8, 23); }

      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sbX + 16, py + 10, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center';
      ctx.fillText(rank + 1, sbX + 16, py + 14);

      ctx.font = `${isMe ? 'bold' : ''} 12px Arial`; ctx.textAlign = 'left';
      ctx.fillStyle = isMe ? '#ffd54f' : '#ddd';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 2;
      const name = p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name;
      ctx.fillText(name + (!p.alive ? ' 💀' : ''), sbX + 30, py + 15);
      ctx.shadowBlur = 0;

      ctx.font = 'bold 14px Arial'; ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd54f';
      ctx.fillText(p.score, sbX + sbW - 8, py + 15);
    });
  }

  // ── Waiting counter ────────────────────────────────────────────────────────
  if (phase === 'waiting') {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, 8, 8, 200, 44, 8); ctx.fill();
    ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffd54f';
    ctx.fillText(`Jugadores: ${playerCount}/6`, 18, 34);
  }

  // ── Controls hint ──────────────────────────────────────────────────────────
  ctx.font = '11px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillText('WASD/Flechas mover  ·  ESPACIO golpear', ARENA_W / 2, ARENA_H - 8);
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}
