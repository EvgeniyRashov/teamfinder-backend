require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const https        = require('https');
const querystring  = require('querystring');
const mongoose     = require('mongoose');

const app = express();
app.set('trust proxy', 1);

// ===== НАДЁЖНЫЕ НАСТРОЙКИ CORS =====
const allowedOrigins = [
  'https://teamfinder-pwa.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5000'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization, X-Requested-With, Accept'
}));

app.options('*', cors());
app.use(cookieParser());
app.use(express.json());

app.get('/', (req, res) => res.send('TEAMFINDER Backend is running!'));

// ===== ПОДКЛЮЧЕНИЕ К MONGODB =====
if (!process.env.MONGODB_URI) {
  console.error("FATAL ERROR: MONGODB_URI is not defined.");
  process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

// ===== СХЕМЫ БАЗЫ ДАННЫХ =====
const UserSchema = new mongoose.Schema({
  steamid:         { type: String, unique: true, required: true },
  name:            String,
  avatar:          String,
  nick:            { type: String, default: '' },
  bio:             { type: String, default: '' },
  elo:             { type: Number, default: 0 },
  faceit:          { type: Number, default: 0 },
  mmrank:          { type: String, default: '' },
  role:            { type: String, default: 'any' },
  mode:            { type: String, default: 'Premier' },
  region:          { type: String, default: 'any' },
  language:        { type: String, default: 'ru' },
  trustScore:      { type: Number, default: 50 }, 
  isAdmin:         { type: Boolean, default: false }, // АДМИН
  isBanned:        { type: Boolean, default: false }, // БАН
  commends: {
    teamPlayer: { type: Number, default: 0 },
    friendly:   { type: Number, default: 0 },
    leader:     { type: Number, default: 0 }
  },
  receivedLikes: [{
    from: String, commendType: String, date: { type: Date, default: Date.now }
  }],
  hasMic:          { type: Boolean, default: false },
  isLookingForTeam:{ type: Boolean, default: false },
  isOnline:        { type: Boolean, default: false },
  lastSeen:        { type: Date, default: Date.now },
  friends: [{
    steamid: String, name: String, avatar: String, matches: { type: Number, default: 0 },
    role: String, elo: Number, faceit: Number, mmrank: String, lastPlayedAt: Date
  }],
}, { timestamps: true });
const User = mongoose.model('User', UserSchema);

const NotifSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type: String, icon: String, ic: String, title: String, body: String,
  time: { type: Date, default: Date.now }, unread: { type: Boolean, default: true },
  actions: [String], payload: mongoose.Schema.Types.Mixed 
});
const Notification = mongoose.model('Notification', NotifSchema);

const LobbySchema = new mongoose.Schema({
  ownerId: { type: String, required: true },
  members: [{ type: String }], 
  gameMode: { type: String, default: 'Premier' },
  status: { type: String, default: 'waiting' }, 
  autoFill: { type: Boolean, default: false },
  messages: [{
    senderId: String,
    text: String,
    time: { type: Date, default: Date.now }
  }]
}, { timestamps: true });
const Lobby = mongoose.model('Lobby', LobbySchema);

const MessageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  receiverId: { type: String, required: true }, 
  text: { type: String, required: true },
  isRead: { type: Boolean, default: false }
}, { timestamps: true });
const Message = mongoose.model('Message', MessageSchema);

const ReportSchema = new mongoose.Schema({
  targetSteamId: { type: String, required: true },
  authorSteamId: { type: String, required: true },
  reason: { type: String, required: true },
  details: { type: String, default: '' },
  status: { type: String, default: 'Рассматривается' }, 
  createdAt: { type: Date, default: Date.now }
});
const Report = mongoose.model('Report', ReportSchema);

const CommentSchema = new mongoose.Schema({
  targetSteamId: { type: String, required: true },
  authorSteamId: { type: String, required: true },
  authorName: { type: String },
  authorAvatar: { type: String },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Comment = mongoose.model('Comment', CommentSchema);

const MatchQueueSchema = new mongoose.Schema({
  steamid: { type: String, required: true, unique: true },
  elo: { type: Number, default: 0 },
  faceit: { type: Number, default: 0 },
  mmrank: { type: String, default: '' },
  mode: { type: String, default: 'Premier' },
  enteredAt: { type: Date, default: Date.now },
  lastCheckedAt: { type: Date, default: Date.now },
  targetLobbyId: { type: String, default: null }
});
const MatchQueue = mongoose.model('MatchQueue', MatchQueueSchema);

const authMiddleware = async (req, res, next) => {
  const auth  = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.cookies?.tf_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.steamid) return res.status(401).json({ error: 'Invalid user session ID' });
    
    // Проверка на БАН
    const user = await User.findOne({ steamid: decoded.steamid });
    if (user && user.isBanned) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован на платформе.' });
    }
    
    req.user = decoded;
    next();
  } catch(err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    const user = await User.findOne({ steamid: req.user.steamid });
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Доступ запрещен. Только для администраторов.' });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ===== STEAM АВТОРИЗАЦИЯ =====
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const RETURN_URL   = process.env.STEAM_RETURN_URL;
const REALM        = process.env.STEAM_REALM;

app.get('/auth/steam', (req, res) => {
  const params = querystring.stringify({
    'openid.ns':         'http://specs.openid.net/auth/2.0',
    'openid.mode':       'checkid_setup',
    'openid.return_to':  RETURN_URL,
    'openid.realm':      REALM,
    'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect(`${STEAM_OPENID}?${params}`);
});

app.get('/auth/steam/authenticate', async (req, res) => {
  try {
    const query = { ...req.query, 'openid.mode': 'check_authentication' };
    const body  = querystring.stringify(query);
    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'steamcommunity.com', path: '/openid/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      };
      let data = '';
      const request = https.request(options, r => { r.on('data', c => data += c); r.on('end', () => resolve(data)); });
      request.on('error', reject);
      request.write(body);
      request.end();
    });

    if (!response.includes('is_valid:true')) return res.status(401).json({ error: 'Steam auth not valid' });

    const claimedId = req.query['openid.claimed_id'];
    const steamId   = claimedId.replace('https://steamcommunity.com/openid/id/', '');

    let p = null;
    try {
      const apiRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`);
      const apiData = await apiRes.json();
      p = apiData.response?.players?.[0];
    } catch (e) {}

    // Если это ваш SteamID - выдаем админку автоматически!
    const isOwner = steamId === '76561198269553115';

    await User.findOneAndUpdate(
      { steamid: steamId },
      { 
        steamid: steamId, 
        name: p?.personaname || steamId, 
        avatar: p?.avatarmedium || null, 
        isOnline: true, 
        lastSeen: new Date(),
        ...(isOwner && { isAdmin: true }) // Назначаем владельца админом
      },
      { upsert: true, new: true }
    );

    const token = jwt.sign({ steamid: steamId, name: p?.personaname || steamId, avatar: p?.avatarmedium || null }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.redirect(`${process.env.CLIENT_ORIGIN}?token=${token}`);
  } catch (err) {
    return res.status(500).json({ error: 'Steam authenticate failed' });
  }
});

app.post('/auth/logout', authMiddleware, async (req, res) => {
  await User.findOneAndUpdate({ steamid: req.user.steamid }, { isOnline: false });
  res.json({ ok: true });
});

// ===== АДМИН-ПАНЕЛЬ =====

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const usersCount = await User.countDocuments();
    const bannedCount = await User.countDocuments({ isBanned: true });
    const lobbiesCount = await Lobby.countDocuments();
    const reportsCount = await Report.countDocuments({ status: 'Рассматривается' });
    res.json({ usersCount, bannedCount, lobbiesCount, reportsCount });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/reports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 }).limit(50);
    res.json(reports);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/reports/:id/resolve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Report.findByIdAndUpdate(req.params.id, { status: 'Рассмотрено' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { search } = req.query;
    let query = {};
    if (search) {
      query = { $or: [{ steamid: search }, { name: { $regex: search, $options: 'i' } }] };
    }
    const users = await User.find(query).sort({ createdAt: -1 }).limit(30).select('steamid name avatar trustScore isBanned isAdmin isOnline createdAt');
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/users/:steamid/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const target = await User.findOne({ steamid: req.params.steamid });
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.isAdmin) return res.status(400).json({ error: 'Нельзя забанить администратора' });
    
    target.isBanned = !target.isBanned;
    await target.save();
    res.json({ ok: true, isBanned: target.isBanned });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/users/:steamid/trust', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { trust } = req.body;
    await User.findOneAndUpdate({ steamid: req.params.steamid }, { trustScore: Number(trust) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ===== ПРОФИЛЬ И НАСТРОЙКИ =====
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findOne({ steamid: req.user.steamid });
  res.json({ user });
});

app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    const { nick, bio, role, mode, region, lang, elo, faceit, mmrank, hasMic } = req.body;
    const upd = {};
    if (nick !== undefined) upd.nick = nick;
    if (bio !== undefined) upd.bio = bio;
    if (role !== undefined) upd.role = role;
    if (mode !== undefined) upd.mode = mode;
    if (region !== undefined) upd.region = region;
    if (lang !== undefined) upd.language = lang;
    if (elo !== undefined) upd.elo = Number(elo) || 0;
    if (faceit !== undefined) upd.faceit = Number(faceit) || 0;
    if (mmrank !== undefined) upd.mmrank = mmrank;
    if (hasMic !== undefined) upd.hasMic = Boolean(hasMic);
    await User.findOneAndUpdate({ steamid: req.user.steamid }, upd);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.get('/api/players', async (req, res) => {
  try {
    const { role, region, language, minTrust, minElo, minFaceit, mmrank, hasMic, limit = 50 } = req.query;
    const filter = { steamid: { $nin: ['undefined', 'null'], $exists: true }, isBanned: { $ne: true } };

    if (role && role !== 'any') filter.role = role;
    if (region && region !== 'any') filter.region = region;
    if (language && language !== 'any') filter.language = language;
    if (mmrank && mmrank !== 'all') filter.mmrank = mmrank;
    if (minTrust) filter.trustScore = { $gte: Number(minTrust) };
    if (minElo) filter.elo = { $gte: Number(minElo) };
    if (minFaceit) filter.faceit = { $gte: Number(minFaceit) };
    if (hasMic === 'true') filter.hasMic = true;

    const players = await User.find(filter)
      .sort({ isOnline: -1, trustScore: -1 })
      .limit(Number(limit))
      .select('steamid name avatar nick bio elo faceit mmrank role mode region language trustScore hasMic isOnline isLookingForTeam lastSeen isAdmin');
    res.json(players);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifs = await Notification.find({ userId: req.user.steamid }).sort({ time: -1 });
    res.json(notifs);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  await Notification.updateMany({ userId: req.user.steamid }, { unread: false });
  res.json({ ok: true });
});

// ===== УМНЫЙ МАТЧМЕЙКИНГ В ФОНЕ =====
async function tryMatchmaking() {
  try {
    const stale = new Date(Date.now() - 15 * 1000);
    await MatchQueue.deleteMany({ lastCheckedAt: { $lt: stale } });

    const autoFillEntries = await MatchQueue.find({ targetLobbyId: { $ne: null } });
    for (const entry of autoFillEntries) {
      const lobby = await Lobby.findById(entry.targetLobbyId);
      if (!lobby || lobby.members.length >= 5) {
        await MatchQueue.updateOne({ steamid: entry.steamid }, { targetLobbyId: null });
        continue;
      }
      if (!lobby.members.includes(entry.steamid)) {
        lobby.members.push(entry.steamid);
        if (lobby.members.length === 5) {
          lobby.status = 'matched';
          lobby.autoFill = false;
        }
        await lobby.save();
      }
      await MatchQueue.deleteOne({ steamid: entry.steamid });
    }

    const autoFillLobbies = await Lobby.find({ 
      autoFill: true, 
      status: 'waiting', 
      $expr: { $lt: [{ $size: "$members" }, 5] } 
    });
    
    for (const lobby of autoFillLobbies) {
        const slotsNeeded = 5 - lobby.members.length;
        const candidates = await MatchQueue.find({ 
            targetLobbyId: null, 
            mode: lobby.gameMode,
            steamid: { $nin: lobby.members }
        }).limit(slotsNeeded);
        
        if (candidates.length > 0) {
            candidates.forEach(c => lobby.members.push(c.steamid));
            if (lobby.members.length === 5) {
                lobby.status = 'matched';
                lobby.autoFill = false;
            }
            await lobby.save();
            await MatchQueue.deleteMany({ steamid: { $in: candidates.map(c => c.steamid) } });
        }
    }

    const queue = await MatchQueue.find({ targetLobbyId: null }).sort({ enteredAt: 1 });
    if (queue.length < 2) {
        for (const p1 of queue) {
            const waitSec = (Date.now() - new Date(p1.enteredAt).getTime()) / 1000;
            if (waitSec > 45) {
                await Lobby.create({ 
                    ownerId: p1.steamid, members: [p1.steamid], gameMode: p1.mode, autoFill: true, status: 'waiting'
                });
                await MatchQueue.deleteOne({ steamid: p1.steamid });
            }
        }
        return;
    }

    const matchedIds = new Set();
    for (let i = 0; i < queue.length; i++) {
      if (matchedIds.has(queue[i].steamid)) continue;
      const p1 = queue[i];
      const waitSec = (Date.now() - new Date(p1.enteredAt).getTime()) / 1000;

      if (waitSec > 45) {
          await Lobby.create({ 
              ownerId: p1.steamid, members: [p1.steamid], gameMode: p1.mode, autoFill: true, status: 'waiting'
          });
          await MatchQueue.deleteOne({ steamid: p1.steamid });
          matchedIds.add(p1.steamid);
          continue;
      }

      let eloRange = 300, faceitRange = 1, rankFlexible = false;
      if (waitSec > 10) { eloRange = 600; faceitRange = 2; }
      if (waitSec > 20) { eloRange = 900; faceitRange = 4; rankFlexible = true; }

      let group = [p1];
      for (let j = i + 1; j < queue.length; j++) {
        if (matchedIds.has(queue[j].steamid)) continue;
        const p2 = queue[j];
        if (p1.mode !== p2.mode) continue;
        let match = false;
        if (p1.mode === 'FACEIT' && p1.faceit > 0 && p2.faceit > 0) {
          if (Math.abs(p1.faceit - p2.faceit) <= faceitRange) match = true;
        } else if (p1.mode === 'Competitive' && p1.mmrank && p2.mmrank) {
          if (p1.mmrank === p2.mmrank || rankFlexible) match = true;
        } else {
          if (Math.abs(p1.elo - p2.elo) <= eloRange) match = true;
        }
        if (match) { group.push(p2); if (group.length === 5) break; }
      }

      if (group.length > 1) {
        const members = group.map(p => p.steamid);
        const isFull = members.length === 5;
        await Lobby.create({ 
            ownerId: members[0], members, gameMode: p1.mode, autoFill: !isFull, status: isFull ? 'matched' : 'waiting'
        });
        await MatchQueue.deleteMany({ steamid: { $in: members } });
        members.forEach(id => matchedIds.add(id));
      }
    }
  } catch (err) { console.error('Matchmaking loop error:', err); }
}

// ===== РОУТЫ МАТЧМЕЙКИНГА =====
app.post('/api/matchmaking/start', authMiddleware, async (req, res) => {
  try {
    const existingLobby = await Lobby.findOne({ members: req.user.steamid });
    if (existingLobby && existingLobby.members.length > 1) {
      return res.json({ status: 'found' });
    }

    const me = await User.findOne({ steamid: req.user.steamid });
    const mode = req.body.mode || me?.mode || 'Premier';

    await MatchQueue.findOneAndUpdate(
      { steamid: req.user.steamid },
      {
        steamid: req.user.steamid,
        elo: me?.elo || 0,
        faceit: me?.faceit || 0,
        mmrank: me?.mmrank || '',
        mode,
        enteredAt: new Date(),
        lastCheckedAt: new Date(),
        targetLobbyId: null
      },
      { upsert: true }
    );
    res.json({ status: 'searching' });
  } catch(e) { res.status(500).json({ error: 'Matchmaking err' }); }
});

app.post('/api/matchmaking/autofill', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) return res.status(400).json({ error: 'Нет активного лобби' });
    if (lobby.ownerId !== req.user.steamid) return res.status(403).json({ error: 'Только хост может включить автодобор' });
    if (lobby.members.length >= 5) return res.status(400).json({ error: 'Лобби уже полное' });

    const me = await User.findOne({ steamid: req.user.steamid });
    const mode = lobby.gameMode || me?.mode || 'Premier';
    const slotsNeeded = 5 - lobby.members.length;

    const candidates = await MatchQueue.find({
      targetLobbyId: null,
      mode,
      steamid: { $nin: lobby.members }
    }).limit(slotsNeeded);

    let added = 0;
    for (const c of candidates) {
      const eloOk = !me?.elo || !c.elo || Math.abs((me.elo || 0) - c.elo) <= 900;
      if (eloOk && lobby.members.length < 5) {
        lobby.members.push(c.steamid);
        await MatchQueue.deleteOne({ steamid: c.steamid });
        added++;
      }
    }
    lobby.autoFill = true;
    await lobby.save();

    if (added > 0) {
      return res.json({ ok: true, added, message: `Добавлено ${added} игрок(ов) из очереди!` });
    }
    return res.json({ ok: true, added: 0, message: 'Ожидаем игроков из очереди поиска...' });
  } catch(e) { res.status(500).json({ error: 'Autofill err' }); }
});

app.get('/api/matchmaking/status', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (lobby) return res.json({ status: 'found' });

    const q = await MatchQueue.findOneAndUpdate(
      { steamid: req.user.steamid },
      { lastCheckedAt: new Date() },
      { new: true }
    );
    if (!q) return res.json({ status: 'none' });

    const elapsed = Math.floor((Date.now() - new Date(q.enteredAt).getTime()) / 1000);
    res.json({ status: 'searching', elapsed });
  } catch(e) { res.status(500).json({ error: 'Status err' }); }
});

app.post('/api/matchmaking/cancel', authMiddleware, async (req, res) => {
  await MatchQueue.deleteOne({ steamid: req.user.steamid });
  res.json({ ok: true });
});

// ===== ЛОББИ И ЛОББИ-ЧАТ =====
app.get('/api/lobby/me', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) return res.json({ lobby: null });
    const membersData = await User.find({ steamid: { $in: lobby.members } })
      .select('steamid name avatar role elo faceit mmrank isOnline trustScore hasMic isAdmin');
    res.json({ lobby, membersData });
  } catch(err) { res.status(500).json({ error: 'Failed to fetch lobby' }); }
});

app.post('/api/lobby/chat', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) return res.status(400).json({ error: 'Вы не в лобби' });
    
    lobby.messages.push({ senderId: req.user.steamid, text, time: new Date() });
    
    if(lobby.messages.length > 50) {
      lobby.messages = lobby.messages.slice(-50);
    }
    
    await lobby.save();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

app.post('/api/lobby/add-member', authMiddleware, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!targetId || targetId === req.user.steamid) return res.status(400).json({ error: 'Некорректный targetId' });

    let lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) lobby = await Lobby.create({ ownerId: req.user.steamid, members: [req.user.steamid], gameMode: 'Premier' });
    if (lobby.ownerId !== req.user.steamid) return res.status(403).json({ error: 'Только HOST может добавлять' });
    if (lobby.members.length >= 5) return res.status(400).json({ error: 'Лобби заполнено' });

    const targetLobby = await Lobby.findOne({ members: targetId });
    if (targetLobby && String(targetLobby._id) !== String(lobby._id)) return res.status(400).json({ error: 'Игрок уже в другом лобби' });

    if (!lobby.members.includes(targetId)) { lobby.members.push(targetId); await lobby.save(); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Ошибка добавления' }); }
});

app.post('/api/lobby/invite', authMiddleware, async (req, res) => {
  try {
    const { targetId } = req.body;
    let lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) lobby = await Lobby.create({ ownerId: req.user.steamid, members: [req.user.steamid] });
    const me = await User.findOne({ steamid: req.user.steamid });
    await Notification.create({
      userId: targetId, type: 'invites', icon: '🎯', ic: 'inv',
      title: `${me.name} приглашает в лобби`,
      body: `Игроков: ${lobby.members.length}/5`,
      unread: true, actions: ['Принять инвайт', 'Отклонить'],
      payload: { lobbyId: lobby._id, senderId: req.user.steamid }
    });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to send invite' }); }
});

app.post('/api/lobby/join', authMiddleware, async (req, res) => {
  try {
    const { lobbyId, notifId } = req.body;
    const lobby = await Lobby.findById(lobbyId);
    if (!lobby || lobby.members.length >= 5) return res.status(400).json({ error: 'Лобби заполнено или не найдено' });
    await Lobby.updateMany({}, { $pull: { members: req.user.steamid } });
    if (!lobby.members.includes(req.user.steamid)) { lobby.members.push(req.user.steamid); await lobby.save(); }
    if (notifId) await Notification.findByIdAndUpdate(notifId, { unread: false, actions: [] });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to join lobby' }); }
});

app.post('/api/lobby/leave', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (lobby) {
      lobby.members = lobby.members.filter(id => id !== req.user.steamid);
      if (lobby.members.length === 0) await Lobby.findByIdAndDelete(lobby._id);
      else {
        if (lobby.ownerId === req.user.steamid) lobby.ownerId = lobby.members[0];
        await lobby.save();
      }
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to leave lobby' }); }
});

// ===== ГЛОБАЛЬНЫЙ ЧАТ =====
app.post('/api/global-chat', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пусто' });
    
    const msg = new Message({
      senderId: req.user.steamid,
      receiverId: 'global',
      text: text
    });
    await msg.save();
    
    const count = await Message.countDocuments({ receiverId: 'global' });
    if(count > 100) {
       const oldest = await Message.find({ receiverId: 'global' }).sort({ createdAt: 1 }).limit(count - 100);
       const ids = oldest.map(m => m._id);
       await Message.deleteMany({ _id: { $in: ids } });
    }
    
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/global-chat', async (req, res) => {
  try {
    const messages = await Message.find({ receiverId: 'global' }).sort({ createdAt: 1 }).limit(100);
    
    const steamIds = [...new Set(messages.map(m => m.senderId))];
    const users = await User.find({ steamid: { $in: steamIds } }).select('steamid name avatar isAdmin');
    
    const result = messages.map(m => {
      const u = users.find(user => user.steamid === m.senderId);
      return {
        _id: m._id,
        senderId: m.senderId,
        text: m.text,
        time: m.createdAt,
        name: u ? u.name : 'Игрок',
        avatar: u ? u.avatar : null,
        isAdmin: u ? u.isAdmin : false
      };
    });
    
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ===== ЛИЧНЫЕ СООБЩЕНИЯ (ЛС) =====

app.get('/api/dm/dialogs', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.steamid;
    const messages = await Message.find({
      $or: [{ senderId: myId }, { receiverId: myId }],
      receiverId: { $ne: 'global' }
    }).sort({ createdAt: -1 });

    const dialogsMap = new Map();

    messages.forEach(msg => {
      const otherId = msg.senderId === myId ? msg.receiverId : msg.senderId;
      if (!dialogsMap.has(otherId)) {
        dialogsMap.set(otherId, {
          lastMessage: msg.text,
          time: msg.createdAt,
          unread: (msg.receiverId === myId && !msg.isRead) ? 1 : 0,
          otherId: otherId
        });
      } else {
        if (msg.receiverId === myId && !msg.isRead) {
          dialogsMap.get(otherId).unread += 1;
        }
      }
    });

    const dialogs = Array.from(dialogsMap.values());
    const userIds = dialogs.map(d => d.otherId);
    
    const users = await User.find({ steamid: { $in: userIds } }).select('steamid name avatar isOnline isAdmin');

    const result = dialogs.map(d => {
      const u = users.find(user => user.steamid === d.otherId);
      return {
        ...d,
        name: u ? u.name : 'Неизвестный',
        avatar: u ? u.avatar : null,
        isOnline: u ? u.isOnline : false,
        isAdmin: u ? u.isAdmin : false
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки диалогов' });
  }
});

app.get('/api/dm/:targetId', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.steamid;
    const targetId = req.params.targetId;

    const messages = await Message.find({
      $or: [
        { senderId: myId, receiverId: targetId },
        { senderId: targetId, receiverId: myId }
      ]
    }).sort({ createdAt: 1 }).limit(100);

    await Message.updateMany(
      { senderId: targetId, receiverId: myId, isRead: false },
      { $set: { isRead: true } }
    );

    const result = messages.map(m => ({
      id: m._id,
      senderId: m.senderId,
      text: m.text,
      time: m.createdAt,
      isRead: m.isRead
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

app.post('/api/dm/:targetId', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.steamid;
    const targetId = req.params.targetId;
    const { text } = req.body;

    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустое сообщение' });

    const msg = new Message({
      senderId: myId,
      receiverId: targetId,
      text: text.trim()
    });
    await msg.save();

    res.json({ ok: true, msg });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

// ===== ПРОФИЛИ, ДРУЗЬЯ, ОТЗЫВЫ =====

app.get('/api/profile/:steamid/comments', async (req, res) => {
  try {
    const comments = await Comment.find({ targetSteamId: req.params.steamid }).sort({ createdAt: -1 });
    res.json(comments);
  } catch(err) { res.status(500).json({ error: 'Failed to fetch comments' }); }
});

app.post('/api/profile/:steamid/comments', authMiddleware, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Empty comment' });
    const c = new Comment({ 
      targetSteamId: req.params.steamid, 
      authorSteamId: req.user.steamid, 
      authorName: req.user.name, 
      authorAvatar: req.user.avatar, 
      text 
    });
    await c.save();
    res.status(201).json(c);
  } catch(err) { res.status(500).json({ error: 'Failed to add comment' }); }
});

app.get('/api/profile/:steamid', async (req, res) => {
  const { steamid } = req.params;
  const key = process.env.STEAM_API_KEY;
  try {
    const [summaryRes, statsRes, hoursRes] = await Promise.allSettled([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`),
      fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${steamid}&appid=730`),
      fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&appids_filter[0]=730&include_appinfo=false`)
    ]);

    let profile = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json();
      const p = data.response?.players?.[0];
      if (p) profile = { steamid: p.steamid, name: p.personaname, avatar: p.avatarfull, profileUrl: p.profileurl, status: p.personastate === 1 ? 'online' : 'offline', country: p.loccountrycode || null, createdAt: p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null };
    }

    let stats = null;
    if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
      const data = await statsRes.value.json();
      if (data.playerstats && data.playerstats.stats) {
        const raw = data.playerstats.stats;
        const getStat = (name) => raw.find(s => s.name === name)?.value || 0;
        const kills = getStat('total_kills'), deaths = getStat('total_deaths'), wins = getStat('total_wins'), roundsPlayed = getStat('total_rounds_played'), headshotKills = getStat('total_kills_headshot'), shots = getStat('total_shots_fired'), hits = getStat('total_shots_hit');
        stats = { kills, deaths, kd: deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2), wins, roundsPlayed, winRate: roundsPlayed > 0 ? ((wins / roundsPlayed) * 100).toFixed(1) : '0', hsRate: kills > 0 ? ((headshotKills / kills) * 100).toFixed(1) : '0', mvps: getStat('total_mvps'), accuracy: shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0' };
      }
    }

    let hoursCs2 = null;
    if (hoursRes.status === 'fulfilled' && hoursRes.value.ok) {
      const data = await hoursRes.value.json();
      const game = data.response?.games?.[0];
      if (game) hoursCs2 = Math.round(game.playtime_forever / 60);
    }

    const dbUser = await User.findOne({ steamid }).select('elo faceit mmrank role mode region nick bio trustScore friends commends isOnline hasMic isAdmin isBanned');
    const reports = await Report.find({ targetSteamId: steamid }).sort({ createdAt: -1 }).limit(10);
    
    return res.json({ profile, stats, hoursCs2, gameData: dbUser || null, friends: dbUser?.friends || [], reports });
  } catch(err) {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.get('/api/friends', authMiddleware, async (req, res) => {
  const user = await User.findOne({ steamid: req.user.steamid }).select('friends');
  if (!user?.friends) return res.json([]);
  const updated = await User.find({ steamid: { $in: user.friends.map(f => f.steamid) } }).select('steamid name avatar nick isOnline isAdmin');
  res.json(updated);
});

app.post('/api/friends/add', authMiddleware, async (req, res) => {
  try {
    const { targetSteamId } = req.body;
    if (!targetSteamId || targetSteamId === req.user.steamid) return res.status(400).json({ error: 'Некорректный ID пользователя' });
    
    const target = await User.findOne({ steamid: targetSteamId });
    if (!target) return res.status(404).json({ error: 'Игрок не найден' });
    if (target.friends && target.friends.some(f => f.steamid === req.user.steamid)) return res.status(400).json({ error: 'Вы уже в друзьях' });

    const existing = await Notification.findOne({ userId: targetSteamId, type: 'friends', 'payload.senderId': req.user.steamid, unread: true });
    if (existing) return res.status(400).json({ error: 'Запрос уже отправлен' });

    const me = await User.findOne({ steamid: req.user.steamid });
    await Notification.create({
      userId: targetSteamId, type: 'friends', icon: '👋', ic: 'fr',
      title: `Запрос в друзья от ${me.name}`,
      body: `${me.mmrank || 'Без ранга'} · ${me.role || 'Any'} · ${me.elo || 0} ELO`,
      unread: true, actions: ['Принять', 'Отклонить'],
      payload: { senderId: me.steamid, senderName: me.name, senderAvatar: me.avatar, senderRole: me.role, senderElo: me.elo }
    });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to add friend' }); }
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  try {
    const { notifId } = req.body;
    const notif = await Notification.findOne({ _id: notifId, userId: req.user.steamid });
    if (!notif) return res.status(404).json({ error: 'Уведомление не найдено' });

    const sender = await User.findOne({ steamid: notif.payload.senderId });
    const me = await User.findOne({ steamid: req.user.steamid });

    const friendForMe = { steamid: sender.steamid, name: sender.name, avatar: sender.avatar, role: sender.role, elo: sender.elo, faceit: sender.faceit, mmrank: sender.mmrank };
    const friendForSender = { steamid: me.steamid, name: me.name, avatar: me.avatar, role: me.role, elo: me.elo, faceit: me.faceit, mmrank: me.mmrank };

    if (!me.friends) me.friends = [];
    if (!me.friends.some(f => f.steamid === sender.steamid)) me.friends.push(friendForMe);

    if (!sender.friends) sender.friends = [];
    if (!sender.friends.some(f => f.steamid === me.steamid)) sender.friends.push(friendForSender);

    await me.save();
    await sender.save();

    notif.unread = false;
    notif.actions = [];
    notif.body = `Вы приняли запрос от ${sender.name}`;
    await notif.save();
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to accept friend' }); }
});

app.post('/api/commends/add', authMiddleware, async (req, res) => {
  try {
    const { targetSteamId, type } = req.body;
    const authorSteamId = req.user.steamid;
    if (!targetSteamId || targetSteamId === 'undefined') return res.status(400).json({ error: 'Некорректный ID' });
    if (targetSteamId === authorSteamId) return res.status(400).json({ error: 'Нельзя лайкать себя' });
    if (!['teamPlayer', 'friendly', 'leader'].includes(type)) return res.status(400).json({ error: 'Неверный тип' });

    const targetUser = await User.findOne({ steamid: targetSteamId });
    if (!targetUser) return res.status(404).json({ error: 'Игрок не найден' });
    if (targetUser.receivedLikes?.some(l => l.from === authorSteamId && l.commendType === type)) {
      return res.status(400).json({ error: 'Уже поставили лайк в этой категории' });
    }

    const newTrust = Math.min(100, (targetUser.trustScore || 50) + 1);
    await User.findOneAndUpdate(
      { steamid: targetSteamId },
      { $inc: { [`commends.${type}`]: 1 }, $set: { trustScore: newTrust }, $push: { receivedLikes: { from: authorSteamId, commendType: type } } }
    );
    res.json({ success: true, newTrust });
  } catch(err) { res.status(500).json({ error: 'Internal error' }); }
});

app.post('/api/reports/add', authMiddleware, async (req, res) => {
  try {
    const { targetSteamId, reason, details } = req.body;
    if (!targetSteamId || !reason) return res.status(400).json({ error: 'Не указаны обязательные поля' });
    const report = new Report({ targetSteamId, authorSteamId: req.user.steamid, reason, details });
    await report.save();
    res.status(201).json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Failed to create report' }); }
});

// ===== ФОНОВЫЕ ЗАДАЧИ =====

setInterval(tryMatchmaking, 5000);

async function cleanOldGlobalMessages() {
  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await Message.deleteMany({ 
      receiverId: 'global', 
      createdAt: { $lt: oneWeekAgo } 
    });
    if (result.deletedCount > 0) {
      console.log(`Очистка: удалено ${result.deletedCount} старых сообщений из глобал-чата.`);
    }
  } catch (err) {
    console.error('Ошибка авто-очистки чата:', err);
  }
}

setInterval(cleanOldGlobalMessages, 24 * 60 * 60 * 1000);
cleanOldGlobalMessages();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TEAMFINDER server running on port ${PORT}`));
