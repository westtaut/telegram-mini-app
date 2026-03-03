// ═══════════════════════════════════════════════════════════════
// CAT EMPIRE - TELEGRAM MINI APP BACKEND
// ═══════════════════════════════════════════════════════════════
// npm install express cors body-parser axios dotenv mongoose

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
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
app.use(bodyParser.json({limit:'50mb'}));
app.use(bodyParser.urlencoded({limit:'50mb',extended:true}));

// ═══════════════════════════════════════════════════════════════
// DATABASE SCHEMA
// ═══════════════════════════════════════════════════════════════
const gameStateSchema = new mongoose.Schema({
  userId: {type:Number, required:true, unique:true},
  username: String,
  firstName: String,
  lastName: String,
  isPremium: Boolean,
  
  // Game progress
  coins: {type:Number, default:150},
  gems: {type:Number, default:50},
  level: {type:Number, default:1},
  xp: {type:Number, default:0},
  totalEarned: {type:Number, default:0},
  
  // Buildings progress
  buildings: {
    fish: {lvl:Number, mgr:Boolean},
    cafe: {lvl:Number, mgr:Boolean},
    neon: {lvl:Number, mgr:Boolean},
    gym: {lvl:Number, mgr:Boolean},
    mem: {lvl:Number, mgr:Boolean},
    arena: {lvl:Number, mgr:Boolean},
    verse: {lvl:Number, mgr:Boolean},
    bank: {lvl:Number, mgr:Boolean},
  },
  
  // Customization
  customizations: {
    avatar: {type:String, default:'😸'},
    skin: {type:String, default:'default'},
    badge: String,
  },
  
  // Event progress
  completedQuests: [String],
  eventProgress: {
    currentEventId: String,
    questsProgress: mongoose.Schema.Types.Mixed,
  },
  
  // Meta
  createdAt: {type:Date, default:Date.now},
  updatedAt: {type:Date, default:Date.now},
  lastOnline: {type:Date, default:Date.now},
});

const GameState = mongoose.model('GameState', gameStateSchema);

// ═══════════════════════════════════════════════════════════════
// TELEGRAM VERIFICATION
// ═══════════════════════════════════════════════════════════════
async function verifyTelegramData(initData){
  try{
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    
    const dataCheckString = Array.from(params.entries())
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>`${k}=${v}`)
      .join('\n');
    
    const crypto = require('crypto');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return checkHash === hash;
  }catch(e){
    console.error('Telegram verification error:', e);
    return false;
  }
}

function parseTelegramData(initData){
  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user')||'{}');
  return {userId:user.id, username:user.username, ...user};
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// SYNC - Save player progress
app.post('/api/sync', async(req,res)=>{
  try{
    const {initData, gameState, buildings, customizations, completedQuests} = req.body;
    
    // Verify Telegram data
    const isValid = await verifyTelegramData(initData);
    if(!isValid){
      return res.status(401).json({error:'Invalid telegram data'});
    }
    
    const tgData = parseTelegramData(initData);
    const userId = tgData.userId;
    
    // Update or create game state
    const state = await GameState.findOneAndUpdate(
      {userId},
      {
        username: tgData.username,
        firstName: tgData.first_name,
        lastName: tgData.last_name,
        isPremium: tgData.is_premium,
        coins: gameState.coins,
        gems: gameState.gems,
        level: gameState.level,
        xp: gameState.xp,
        buildings,
        customizations,
        completedQuests,
        lastOnline: new Date(),
        updatedAt: new Date(),
      },
      {upsert:true, new:true}
    );
    
    console.log(`✓ Synced ${tgData.username} (ID: ${userId})`);
    res.json({success:true, userId, data:state});
    
  }catch(err){
    console.error('Sync error:', err);
    res.status(500).json({error:err.message});
  }
});

// LOAD - Get player progress
app.post('/api/load', async(req,res)=>{
  try{
    const {initData} = req.body;
    
    const isValid = await verifyTelegramData(initData);
    if(!isValid){
      return res.status(401).json({error:'Invalid telegram data'});
    }
    
    const tgData = parseTelegramData(initData);
    const userId = tgData.userId;
    
    let state = await GameState.findOne({userId});
    
    if(!state){
      // Create new player
      state = new GameState({
        userId,
        username: tgData.username,
        firstName: tgData.first_name,
        lastName: tgData.last_name,
        isPremium: tgData.is_premium,
        buildings: {
          fish:{lvl:1,mgr:false},
          cafe:{lvl:1,mgr:false},
          neon:{lvl:0,mgr:false},
          gym:{lvl:0,mgr:false},
          mem:{lvl:0,mgr:false},
          arena:{lvl:0,mgr:false},
          verse:{lvl:0,mgr:false},
          bank:{lvl:0,mgr:false},
        }
      });
      await state.save();
      console.log(`→ Created new player: ${tgData.username} (ID: ${userId})`);
    }
    
    const gameState = {
      userId: state.userId,
      username: state.username,
      coins: state.coins,
      gems: state.gems,
      level: state.level,
      xp: state.xp,
      customizations: state.customizations,
    };
    
    res.json({
      success:true,
      gameState,
      buildings:state.buildings,
      customizations:state.customizations,
      completedQuests:state.completedQuests,
    });
    
  }catch(err){
    console.error('Load error:', err);
    res.status(500).json({error:err.message});
  }
});

// GET LEADERBOARD
app.get('/api/leaderboard', async(req,res)=>{
  try{
    const limit = parseInt(req.query.limit) || 50;
    
    const leaders = await GameState.find()
      .sort({level:-1, totalEarned:-1})
      .limit(limit)
      .select('userId username level coins gems totalEarned');
    
    const formatted = leaders.map((p,i)=>({
      rank: i+1,
      userId: p.userId,
      username: p.username,
      level: p.level,
      coins: p.coins,
      totalEarned: p.totalEarned,
    }));
    
    res.json({success:true, data:formatted});
    
  }catch(err){
    console.error('Leaderboard error:', err);
    res.status(500).json({error:err.message});
  }
});

// GET PLAYER STATS
app.post('/api/stats', async(req,res)=>{
  try{
    const {initData} = req.body;
    const isValid = await verifyTelegramData(initData);
    if(!isValid) return res.status(401).json({error:'Invalid telegram data'});
    
    const tgData = parseTelegramData(initData);
    const state = await GameState.findOne({userId:tgData.userId});
    
    if(!state) return res.status(404).json({error:'Player not found'});
    
    const stats = {
      level: state.level,
      coins: state.coins,
      gems: state.gems,
      totalEarned: state.totalEarned,
      buildingsCount: Object.values(state.buildings).filter(b=>b.lvl>0).length,
      completedQuests: state.completedQuests.length,
      lastOnline: state.lastOnline,
      createdAt: state.createdAt,
    };
    
    res.json({success:true, stats});
    
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// CLAIM EVENT REWARD
app.post('/api/claim-reward', async(req,res)=>{
  try{
    const {initData, rewardId} = req.body;
    const isValid = await verifyTelegramData(initData);
    if(!isValid) return res.status(401).json({error:'Invalid telegram data'});
    
    const tgData = parseTelegramData(initData);
    const state = await GameState.findOne({userId:tgData.userId});
    
    if(!state) return res.status(404).json({error:'Player not found'});
    
    // Add reward logic here
    state.gems += 50; // Example reward
    state.updatedAt = new Date();
    await state.save();
    
    res.json({success:true, message:'Reward claimed'});
    
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Get all players
app.get('/admin/players', async(req,res)=>{
  try{
    const adminKey = req.headers['x-admin-key'];
    if(adminKey !== process.env.ADMIN_KEY){
      return res.status(401).json({error:'Unauthorized'});
    }
    
    const players = await GameState.find().limit(100);
    res.json({success:true, count:players.length, data:players});
    
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// Get player by ID
app.get('/admin/player/:userId', async(req,res)=>{
  try{
    const adminKey = req.headers['x-admin-key'];
    if(adminKey !== process.env.ADMIN_KEY){
      return res.status(401).json({error:'Unauthorized'});
    }
    
    const player = await GameState.findOne({userId:parseInt(req.params.userId)});
    if(!player) return res.status(404).json({error:'Player not found'});
    
    res.json({success:true, data:player});
    
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// Reset player progress
app.post('/admin/reset/:userId', async(req,res)=>{
  try{
    const adminKey = req.headers['x-admin-key'];
    if(adminKey !== process.env.ADMIN_KEY){
      return res.status(401).json({error:'Unauthorized'});
    }
    
    const userId = parseInt(req.params.userId);
    const result = await GameState.findOneAndDelete({userId});
    
    res.json({success:true, message:`Player ${userId} reset`});
    
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION & SERVER START
// ═══════════════════════════════════════════════════════════════
mongoose.connect(MONGO_URI, {
  useNewUrlParser:true,
  useUnifiedTopology:true
})
.then(()=>{
  console.log('✓ MongoDB connected');
  app.listen(PORT, ()=>{
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Telegram token: ${TELEGRAM_BOT_TOKEN?'✓':'✗'}`);
  });
})
.catch(err=>{
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async()=>{
  console.log('Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});
