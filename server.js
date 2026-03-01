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
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
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
   REST API
══════════════════════════════════════ */

// Save player state (called on app load & periodically)
app.post('/api/player/sync', (req, res) => {
  const { uid, name, data } = req.body;
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
    lastSeen: Date.now(),
  });

  broadcastLeaderboard();
  res.json({ ok: true, rank: getLeaderboard().findIndex(p => p.uid === uid) + 1 });
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
    // If only 1 player waiting >5s, match with bot
    const lonely = pvpQueue.find(q => Date.now() - q.joinedAt > 5000);
    if (lonely) {
      matchWithBot(lonely);
    }
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

function matchWithBot(player) {
  const idx = pvpQueue.indexOf(player);
  if (idx !== -1) pvpQueue.splice(idx, 1);

  const BOTS = [
    { name: 'КотоБот 🤖', emoji: '🤖', power: Math.floor(player.fighter.power * (0.7 + Math.random() * 0.6)) },
    { name: 'МегаМурка 😈', emoji: '😈', power: Math.floor(player.fighter.power * (0.8 + Math.random() * 0.5)) },
    { name: 'ЗлойТигр 🐯', emoji: '🐯', power: Math.floor(player.fighter.power * (0.9 + Math.random() * 0.4)) },
  ];
  const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
  const botUid = 'bot_' + Date.now();

  const result = simulateBattle(
    { ...player.fighter, uid: player.uid },
    { power: bot.power, uid: botUid }
  );

  const matchId = 'bot_' + Date.now().toString(36);

  io.to(player.socketId).emit('pvp_battle_result', {
    matchId,
    isBot: true,
    result,
    you: { uid: player.uid, fighter: player.fighter, name: player.name || 'Вы' },
    opponent: { uid: botUid, fighter: bot, name: bot.name },
  });

  const won = result.winner === player.uid;
  const p = players.get(player.uid);
  if (p) {
    if (won) { p.pvpScore += 8; p.pvpWins = (p.pvpWins || 0) + 1; }
    else { p.pvpScore = Math.max(0, (p.pvpScore || 0) - 3); p.pvpLosses = (p.pvpLosses || 0) + 1; }
    players.set(player.uid, p);
  }

  setTimeout(broadcastLeaderboard, 500);
}

// Auto-match lonely players every 8 seconds
setInterval(() => {
  const lonely = pvpQueue.filter(q => Date.now() - q.joinedAt > 8000);
  lonely.forEach(matchWithBot);
}, 8000);

// Broadcast leaderboard every 30s
setInterval(broadcastLeaderboard, 30000);

server.listen(PORT, () => {
  console.log(`🐱 Gacha Cats server running on port ${PORT}`);
});
