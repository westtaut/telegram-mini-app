/**
 * GACHA CATS - Multiplayer Backend
 * Node.js + Express + Socket.io
 *
 * Deploy: Railway / Render / VPS
 * npm install express socket.io cors
 * node server.js
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORS — разрешаем все источники (GitHub Pages, Telegram WebApp)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
  },
  // Важно для Railway: разрешаем polling как fallback
  transports: ['polling', 'websocket'],
  allowEIO3: true, // совместимость со старыми клиентами
});

const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════
   IN-MEMORY STORE (replace with Redis/DB for prod)
══════════════════════════════════════ */
const players = new Map();       // uid -> playerData
const leaderboard = [];          // sorted array
const pvpQueue = [];             // waiting for match
const activeMatches = new Map(); // matchId -> matchData

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */
function getLeaderboard() {
  const arr = Array.from(players.values())
    .filter(p => !p.uid.startsWith('bot_') && !p.uid.startsWith('local_'))  // only real players
    .sort((a, b) => b.pvpScore - a.pvpScore)
    .slice(0, 100)
    .map((p, i) => ({
      rank: i + 1,
      uid: p.uid,
      name: p.name,
      emoji: p.topCatEmoji || '😺',
      pvpScore: p.pvpScore || 0,
      pvpWins: p.pvpWins || 0,
      pvpLosses: p.pvpLosses || 0,
      topRarity: p.topRarity || 'Common',
      level: p.maxLevel || 1,
      lastSeen: p.lastSeen || 0,
    }));
  return arr;
}

function broadcastLeaderboard() {
  io.emit('leaderboard_update', getLeaderboard());
}

function simulateBattle(fighter1, fighter2) {
  // Deterministic battle simulation
  let hp1 = fighter1.power * 3 + 50;
  let hp2 = fighter2.power * 3 + 50;
  const log = [];
  let round = 0;

  while (hp1 > 0 && hp2 > 0 && round < 30) {
    round++;
    const crit1 = Math.random() < 0.12;
    const crit2 = Math.random() < 0.12;
    const dmg1 = Math.floor(fighter1.power * (0.6 + Math.random() * 0.8) * (crit1 ? 1.8 : 1));
    const dmg2 = Math.floor(fighter2.power * (0.6 + Math.random() * 0.8) * (crit2 ? 1.8 : 1));
    hp2 -= dmg1;
    hp1 -= dmg2;
    if (round <= 5) {
      log.push({
        round,
        atk1: dmg1, crit1,
        atk2: dmg2, crit2,
        hp1: Math.max(0, hp1),
        hp2: Math.max(0, hp2),
      });
    }
  }

  return {
    winner: hp1 > 0 ? fighter1.uid : fighter2.uid,
    log,
    hp1Final: Math.max(0, hp1),
    hp2Final: Math.max(0, hp2),
    rounds: round,
  };
}

/* ══════════════════════════════════════
   HEALTH CHECK — Railway проверяет этот URL
   Также не даёт серверу "засыпать"
══════════════════════════════════════ */
app.get('/', (req, res) => {
  res.json({ status: 'ok', game: 'Gacha Cats', players: players.size, uptime: Math.floor(process.uptime()) });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

/* ══════════════════════════════════════
   REST API
══════════════════════════════════════ */

// Save player state (called on app load & periodically)
// Also stores full game state for cross-device sync
app.post('/api/player/sync', (req, res) => {
  const { uid, name, data, fullState } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const existing = players.get(uid) || {};
  players.set(uid, {
    ...existing,
    uid,
    name: name || existing.name || 'Игрок',
    pvpScore: data?.pvpScore ?? existing.pvpScore ?? 0,
    pvpWins: data?.pvpWins ?? existing.pvpWins ?? 0,
    pvpLosses: data?.pvpLosses ?? existing.pvpLosses ?? 0,
    topCatEmoji: data?.topCatEmoji ?? existing.topCatEmoji ?? '😺',
    topRarity: data?.topRarity ?? existing.topRarity ?? 'Common',
    maxLevel: data?.maxLevel ?? existing.maxLevel ?? 1,
    maxPower: data?.maxPower ?? existing.maxPower ?? 10,
    lastSeen: data?.lastSeen || Date.now(),
    // Store full game state for cross-device sync (only if provided and newer)
    fullState: fullState || existing.fullState || null,
    fullStateAt: fullState ? Date.now() : (existing.fullStateAt || 0),
  });

  broadcastLeaderboard();
  res.json({ ok: true, rank: getLeaderboard().findIndex(p => p.uid === uid) + 1 });
});

// Full state save — called when user wants to sync cross-device
app.post('/api/player/save', (req, res) => {
  const { uid, name, state } = req.body;
  if (!uid || !state) return res.status(400).json({ error: 'uid and state required' });

  const existing = players.get(uid) || {};
  players.set(uid, {
    ...existing,
    uid,
    name: name || existing.name || 'Игрок',
    fullState: state,
    fullStateAt: Date.now(),
    lastSeen: Date.now(),
  });

  res.json({ ok: true, savedAt: Date.now() });
});

// Full state load — called on app boot to restore cross-device progress
app.get('/api/player/:uid/load', (req, res) => {
  const player = players.get(req.params.uid);
  if (!player || !player.fullState) {
    return res.json({ ok: false, state: null, savedAt: null });
  }
  res.json({ ok: true, state: player.fullState, savedAt: player.fullStateAt });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// Get player rank
app.get('/api/player/:uid/rank', (req, res) => {
  const lb = getLeaderboard();
  const idx = lb.findIndex(p => p.uid === req.params.uid);
  const player = players.get(req.params.uid);
  res.json({
    rank: idx + 1 || lb.length + 1,
    total: players.size,
    player: player || null,
  });
});

/* ══════════════════════════════════════
   SOCKET.IO - REALTIME PvP
══════════════════════════════════════ */
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('player_join', ({ uid, name }) => {
    socket.uid = uid;
    socket.playerName = name;
    socket.join(`player:${uid}`);
    socket.emit('leaderboard_update', getLeaderboard());
  });

  // Join PvP matchmaking queue
  socket.on('pvp_queue_join', ({ uid, fighter }) => {
    // Remove if already in queue
    const existIdx = pvpQueue.findIndex(q => q.uid === uid);
    if (existIdx !== -1) pvpQueue.splice(existIdx, 1);

    pvpQueue.push({ socketId: socket.id, uid, fighter, joinedAt: Date.now() });
    socket.emit('pvp_queue_status', { status: 'searching', queueSize: pvpQueue.length });

    // Try to match
    tryMatch();
  });

  // Leave queue
  socket.on('pvp_queue_leave', ({ uid }) => {
    const idx = pvpQueue.findIndex(q => q.uid === uid);
    if (idx !== -1) pvpQueue.splice(idx, 1);
    socket.emit('pvp_queue_status', { status: 'idle' });
  });

  // Battle result acknowledged
  socket.on('battle_ack', ({ matchId }) => {
    // Clean up match after both ack
    const match = activeMatches.get(matchId);
    if (match) {
      match.acks = (match.acks || 0) + 1;
      if (match.acks >= 2) activeMatches.delete(matchId);
    }
  });

  socket.on('disconnect', () => {
    const idx = pvpQueue.findIndex(q => q.socketId === socket.id);
    if (idx !== -1) pvpQueue.splice(idx, 1);
  });
});

function tryMatch() {
  if (pvpQueue.length < 2) {
    // No bots — just keep waiting for a real player
    // Emit waiting status update every 10s so client knows queue is still alive
    pvpQueue.forEach(q => {
      const waiting = Math.floor((Date.now() - q.joinedAt) / 1000);
      io.to(q.socketId).emit('pvp_queue_status', {
        status: 'searching',
        queueSize: pvpQueue.length,
        waitSeconds: waiting,
      });
    });
    return;
  }

  // Sort by power for fair matching
  pvpQueue.sort((a, b) => (a.fighter.power || 0) - (b.fighter.power || 0));

  const p1 = pvpQueue.shift();
  const p2 = pvpQueue.shift();

  const result = simulateBattle(
    { ...p1.fighter, uid: p1.uid },
    { ...p2.fighter, uid: p2.uid }
  );

  const matchId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  activeMatches.set(matchId, { p1, p2, result, acks: 0 });

  const basePayload = { matchId, result };

  // Send to both players
  io.to(p1.socketId).emit('pvp_battle_result', {
    ...basePayload,
    you: { uid: p1.uid, fighter: p1.fighter, name: p1.name || 'Игрок 1' },
    opponent: { uid: p2.uid, fighter: p2.fighter, name: p2.name || 'Игрок 2' },
  });
  io.to(p2.socketId).emit('pvp_battle_result', {
    ...basePayload,
    you: { uid: p2.uid, fighter: p2.fighter, name: p2.name || 'Игрок 2' },
    opponent: { uid: p1.uid, fighter: p1.fighter, name: p1.name || 'Игрок 1' },
  });

  // Update scores
  const updateScore = (uid, won) => {
    const p = players.get(uid);
    if (p) {
      if (won) { p.pvpScore += 15 + Math.floor(Math.random() * 10); p.pvpWins = (p.pvpWins || 0) + 1; }
      else { p.pvpScore = Math.max(0, (p.pvpScore || 0) - 5); p.pvpLosses = (p.pvpLosses || 0) + 1; }
      players.set(uid, p);
    }
  };

  updateScore(result.winner, true);
  updateScore(result.winner === p1.uid ? p2.uid : p1.uid, false);

  setTimeout(broadcastLeaderboard, 500);

  // Try again if more players waiting
  if (pvpQueue.length >= 2) setTimeout(tryMatch, 100);
}

// Broadcast queue size updates every 5s so waiting players see live count
setInterval(() => {
  if (pvpQueue.length > 0) {
    pvpQueue.forEach(q => {
      const waiting = Math.floor((Date.now() - q.joinedAt) / 1000);
      io.to(q.socketId).emit('pvp_queue_status', {
        status: 'searching',
        queueSize: pvpQueue.length,
        waitSeconds: waiting,
      });
    });
  }
}, 5000);

// Also try to match any newcomers on interval
setInterval(() => {
  if (pvpQueue.length >= 2) tryMatch();
}, 2000);

// Broadcast leaderboard every 30s
setInterval(broadcastLeaderboard, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐱 Gacha Cats server running on port ${PORT}`);
});
