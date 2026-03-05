// ═══════════════════════════════════════════════════════════════
// CAT EMPIRE - TELEGRAM MINI APP BACKEND
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/cat-empire';

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// sendBeacon отправляет JSON с Content-Type: text/plain
// Этот middleware парсит его как JSON
app.use((req, res, next) => {
  if (req.method === 'POST' &&
      req.headers['content-type'] &&
      req.headers['content-type'].includes('text/plain') &&
      !req.body) {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { req.body = JSON.parse(raw); } catch(e) { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK — обязательно для Railway
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.status(200).json({
    status: 'ok',
    db: dbStatus,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'Cat Empire Server running 🐱' });
});
// DEBUG — помогает диагностировать проблемы с initData
app.post('/api/debug', async (req, res) => {
  const { initData } = req.body || {};
  const hasToken = !!TELEGRAM_BOT_TOKEN;
  const initLen = (initData || '').length;

  let verifyResult = 'skipped';
  let userId = null;
  let verifyError = null;

  if (initData) {
    try {
      const ok = await verifyTelegramData(initData);
      verifyResult = ok ? 'ok' : 'failed';
      if (ok) {
        const tgData = parseTelegramData(initData);
        userId = tgData.userId;
      }
    } catch(e) {
      verifyError = e.message;
    }
  }

  res.json({
    server: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    hasToken,
    initDataLength: initLen,
    verifyResult,
    userId,
    verifyError,
    tip: !hasToken ? 'Set TELEGRAM_BOT_TOKEN in Railway variables' :
         verifyResult === 'failed' ? 'Token mismatch - check TELEGRAM_BOT_TOKEN value' :
         'All good!',
  });
});



// ═══════════════════════════════════════════════════════════════
// DATABASE SCHEMA
// ═══════════════════════════════════════════════════════════════
const gameStateSchema = new mongoose.Schema({
  userId:    { type: Number, required: true, unique: true, index: true },
  username:  { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName:  { type: String, default: '' },
  isPremium: { type: Boolean, default: false },

  // Валюта и прогресс
  coins:        { type: Number, default: 150 },
  gems:         { type: Number, default: 50 },
  level:        { type: Number, default: 1 },
  xp:           { type: Number, default: 0 },
  totalEarned:  { type: Number, default: 0 },
  presLvl:      { type: Number, default: 0 },
  presMult:     { type: Number, default: 1 },
  ppaws:        { type: Number, default: 0 },
  rep:          { type: Number, default: 0 },
  tokens:       { type: Number, default: 0 },
  streak:       { type: Number, default: 0 },
  ciToday:      { type: Boolean, default: false },
  pE:           { type: Number, default: 0 },
  pL:           { type: Number, default: 0 },
  bpPrem:       { type: Boolean, default: false },
  bpProg:       { type: Number, default: 0 },

  // Здания — используем Mixed для гибкости
  buildings: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Коты
  cats: { type: mongoose.Schema.Types.Mixed, default: [] },

  // Кастомизация
  customizations: {
    avatar: { type: String, default: '😸' },
    skin:   { type: String, default: 'default' },
    badge:  { type: String, default: '' },
  },

  // Квесты и достижения
  completedQuests: { type: [String], default: [] },
  missions:        { type: mongoose.Schema.Types.Mixed, default: [] },
  achievements:    { type: mongoose.Schema.Types.Mixed, default: [] },

  // Мета
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
  lastOnline: { type: Date, default: Date.now },
});

const GameState = mongoose.model('GameState', gameStateSchema);

// ═══════════════════════════════════════════════════════════════
// TELEGRAM VERIFICATION
// ═══════════════════════════════════════════════════════════════
async function verifyTelegramData(initData) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'dev') {
    console.warn('WARN: Telegram verification SKIPPED (no token set)');
    return true;
  }
  if (!initData || typeof initData !== 'string' || initData.length < 10) {
    console.warn('WARN: initData empty, length=' + (initData||'').length);
    return false;
  }
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      console.warn('WARN: no hash in initData, keys: ' + [...params.keys()].join(','));
      return false;
    }
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + '=' + v)
      .join('\n');

    const crypto = require('crypto');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN).digest();
    const checkHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    const ok = checkHash === hash;
    if (!ok) {
      console.warn('WARN: hash mismatch - wrong TELEGRAM_BOT_TOKEN?');
      console.warn('  got:      ' + hash.slice(0,20) + '...');
      console.warn('  computed: ' + checkHash.slice(0,20) + '...');
    } else {
      console.log('OK: verify passed, keys: ' + [...params.keys()].join(','));
    }
    return ok;
  } catch (e) {
    console.error('verify exception:', e.message);
    return false;
  }
}

function parseTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user') || '{}');
    return { userId: user.id, username: user.username || '', ...user };
  } catch (e) {
    // Fallback для тестирования без Telegram
    return { userId: 0, username: 'test_user' };
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function defaultBuildings() {
  return {
    fish:  { lvl: 1, mgr: false },
    cafe:  { lvl: 1, mgr: false },
    neon:  { lvl: 0, mgr: false },
    gym:   { lvl: 0, mgr: false },
    mem:   { lvl: 0, mgr: false },
    arena: { lvl: 0, mgr: false },
    verse: { lvl: 0, mgr: false },
    bank:  { lvl: 0, mgr: false },
  };
}

// Антихит: монеты не могут резко вырасти (>24ч дохода = подозрительно)
function sanitizeCoins(newCoins, oldCoins) {
  const MAX_DELTA = 1e12; // разумный лимит
  if (typeof newCoins !== 'number' || isNaN(newCoins)) return oldCoins;
  if (newCoins < 0) return 0;
  if (newCoins - oldCoins > MAX_DELTA) {
    console.warn(`⚠️  Suspicious coin jump: ${oldCoins} → ${newCoins}`);
    return oldCoins + MAX_DELTA;
  }
  return newCoins;
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// SYNC — сохранить прогресс
app.post('/api/sync', async (req, res) => {
  try {
    const { initData, gameState, buildings, cats, customizations, completedQuests, missions, achievements } = req.body;

    if (!initData) return res.status(400).json({ error: 'initData required' });

    const isValid = await verifyTelegramData(initData);
    if (!isValid) return res.status(401).json({ error: 'Invalid telegram data' });

    const tgData = parseTelegramData(initData);
    const userId = tgData.userId;
    if (!userId) return res.status(400).json({ error: 'userId missing' });

    // Берём старое состояние для санитизации
    const existing = await GameState.findOne({ userId });
    const oldCoins = existing ? existing.coins : 150;

    const updateData = {
      username:  tgData.username   || existing?.username   || '',
      firstName: tgData.first_name || existing?.firstName  || '',
      lastName:  tgData.last_name  || existing?.lastName   || '',
      isPremium: tgData.is_premium || false,

      coins:       sanitizeCoins(gameState?.coins, oldCoins),
      gems:        typeof gameState?.gems === 'number'        ? Math.max(0, gameState.gems)        : (existing?.gems        ?? 50),
      level:       typeof gameState?.level === 'number'       ? Math.max(1, gameState.level)       : (existing?.level       ?? 1),
      xp:          typeof gameState?.xp === 'number'          ? Math.max(0, gameState.xp)          : (existing?.xp          ?? 0),
      totalEarned: typeof gameState?.totalEarned === 'number' ? gameState.totalEarned              : (existing?.totalEarned ?? 0),
      presLvl:     typeof gameState?.presLvl === 'number'     ? gameState.presLvl                 : (existing?.presLvl     ?? 0),
      presMult:    typeof gameState?.presMult === 'number'    ? gameState.presMult                : (existing?.presMult    ?? 1),
      ppaws:       typeof gameState?.ppaws === 'number'       ? gameState.ppaws                   : (existing?.ppaws       ?? 0),
      rep:         typeof gameState?.rep === 'number'         ? gameState.rep                     : (existing?.rep         ?? 0),
      tokens:      typeof gameState?.tokens === 'number'      ? gameState.tokens                  : (existing?.tokens      ?? 0),
      streak:      typeof gameState?.streak === 'number'      ? gameState.streak                  : (existing?.streak      ?? 0),
      ciToday:     typeof gameState?.ciToday === 'boolean'    ? gameState.ciToday                 : (existing?.ciToday     ?? false),
      pE:          typeof gameState?.pE === 'number'          ? gameState.pE                      : (existing?.pE          ?? 0),
      pL:          typeof gameState?.pL === 'number'          ? gameState.pL                      : (existing?.pL          ?? 0),
      bpPrem:      typeof gameState?.bpPrem === 'boolean'     ? gameState.bpPrem                  : (existing?.bpPrem      ?? false),
      bpProg:      typeof gameState?.bpProg === 'number'      ? gameState.bpProg                  : (existing?.bpProg      ?? 0),

      buildings:       buildings       || existing?.buildings       || defaultBuildings(),
      cats:            cats            || existing?.cats            || [],
      customizations:  customizations  || existing?.customizations  || {},
      completedQuests: completedQuests || existing?.completedQuests || [],
      missions:        missions        || existing?.missions        || [],
      achievements:    achievements    || existing?.achievements    || [],

      lastOnline: new Date(),
      updatedAt:  new Date(),
    };

    const state = await GameState.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`✓ Synced user ${tgData.username || userId} — coins: ${updateData.coins}`);
    res.json({ success: true, userId });

  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// LOAD — загрузить прогресс
app.post('/api/load', async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) return res.status(400).json({ error: 'initData required' });

    const isValid = await verifyTelegramData(initData);
    if (!isValid) return res.status(401).json({ error: 'Invalid telegram data' });

    const tgData = parseTelegramData(initData);
    const userId = tgData.userId;
    if (!userId) return res.status(400).json({ error: 'userId missing' });

    let state = await GameState.findOne({ userId });

    if (!state) {
      // Новый игрок
      state = await GameState.create({
        userId,
        username:  tgData.username   || '',
        firstName: tgData.first_name || '',
        lastName:  tgData.last_name  || '',
        isPremium: tgData.is_premium || false,
        buildings: defaultBuildings(),
      });
      console.log(`→ New player: ${tgData.username || userId}`);
    } else {
      // Обновляем lastOnline
      await GameState.updateOne({ userId }, { $set: { lastOnline: new Date() } });
    }

    res.json({
      success: true,
      gameState: {
        userId:      state.userId,
        username:    state.username,
        coins:       state.coins,
        gems:        state.gems,
        level:       state.level,
        xp:          state.xp,
        totalEarned: state.totalEarned,
        presLvl:     state.presLvl,
        presMult:    state.presMult,
        ppaws:       state.ppaws,
        rep:         state.rep,
        tokens:      state.tokens,
        streak:      state.streak,
        ciToday:     state.ciToday,
        pE:          state.pE,
        pL:          state.pL,
        bpPrem:      state.bpPrem,
        bpProg:      state.bpProg,
        lastOnline:  state.lastOnline,
      },
      buildings:       state.buildings       || defaultBuildings(),
      cats:            state.cats            || [],
      customizations:  state.customizations  || {},
      completedQuests: state.completedQuests || [],
      missions:        state.missions        || [],
      achievements:    state.achievements    || [],
    });

  } catch (err) {
    console.error('Load error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// LEADERBOARD
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const leaders = await GameState.find({}, 'userId username level coins totalEarned')
      .sort({ totalEarned: -1, level: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: leaders.map((p, i) => ({
        rank:        i + 1,
        userId:      p.userId,
        username:    p.username || 'Unknown',
        level:       p.level,
        coins:       p.coins,
        totalEarned: p.totalEarned,
      })),
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// STATS
app.post('/api/stats', async (req, res) => {
  try {
    const { initData } = req.body;
    const isValid = await verifyTelegramData(initData);
    if (!isValid) return res.status(401).json({ error: 'Invalid telegram data' });

    const tgData = parseTelegramData(initData);
    const state = await GameState.findOne({ userId: tgData.userId }).lean();
    if (!state) return res.status(404).json({ error: 'Player not found' });

    const buildings = state.buildings || {};
    res.json({
      success: true,
      stats: {
        level:           state.level,
        coins:           state.coins,
        gems:            state.gems,
        totalEarned:     state.totalEarned,
        buildingsCount:  Object.values(buildings).filter(b => b && b.lvl > 0).length,
        completedQuests: (state.completedQuests || []).length,
        lastOnline:      state.lastOnline,
        createdAt:       state.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════
function checkAdmin(req, res) {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/admin/players', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const players = await GameState.find()
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const total = await GameState.countDocuments();
    res.json({ success: true, total, page, count: players.length, data: players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/player/:userId', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const player = await GameState.findOne({ userId: parseInt(req.params.userId) }).lean();
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json({ success: true, data: player });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/reset/:userId', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const userId = parseInt(req.params.userId);
    await GameState.findOneAndDelete({ userId });
    res.json({ success: true, message: `Player ${userId} reset` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DATABASE + SERVER START
// ═══════════════════════════════════════════════════════════════
async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✓ MongoDB connected');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Telegram token: ${TELEGRAM_BOT_TOKEN ? '✓ set' : '✗ missing (dev mode)'}`);
      console.log(`✓ Admin key:      ${process.env.ADMIN_KEY ? '✓ set' : '✗ missing'}`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});

// Логируем uncaught errors вместо краша
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
