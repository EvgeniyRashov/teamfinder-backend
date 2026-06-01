require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cookieParser = require('cookie-parser');
const jwt        = require('jsonwebtoken');
const https      = require('https');
const querystring = require('querystring');
const mongoose   = require('mongoose');

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = ['https://teamfinder-pwa.vercel.app', 'http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5000'];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); 
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());
app.use(express.json());

// Healthcheck
app.get('/', (req, res) => res.send('TEAMFINDER Backend is running!'));

if (!process.env.MONGODB_URI) {
  console.error("FATAL ERROR: MONGODB_URI is not defined.");
  process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

// ============================================================
// SCHEMA
// ============================================================
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
  hasMic:          { type: Boolean, default: false },
  isLookingForTeam:{ type: Boolean, default: false },
  isOnline:        { type: Boolean, default: false },
  lastSeen:        { type: Date, default: Date.now },
  friends: [{
    steamid: String,
    name: String,
    avatar: String,
    matches: { type: Number, default: 0 },
    role: String,
    elo: Number,
    faceit: Number,
    mmrank: String,
    lastPlayedAt: Date
  }],
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// ============================================================
// NOTIFICATIONS SCHEMA
// ============================================================
const NotifSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type: String, // 'invites', 'friends', 'system', 'message'
  icon: String,
  ic: String,
  title: String,
  body: String,
  time: { type: Date, default: Date.now },
  unread: { type: Boolean, default: true },
  actions: [String],
  payload: mongoose.Schema.Types.Mixed 
});
const Notification = mongoose.model('Notification', NotifSchema);

// ============================================================
// LOBBY SCHEMA
// ============================================================
const LobbySchema = new mongoose.Schema({
  ownerId: { type: String, required: true },
  members: [{ type: String }], // array of steamids
  gameMode: { type: String, default: 'Premier' },
  status: { type: String, default: 'waiting' }, // waiting, in_game
}, { timestamps: true });
const Lobby = mongoose.model('Lobby', LobbySchema);

// ============================================================
// MESSAGE SCHEMA (Private, strictly authorized)
// ============================================================
const MessageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  receiverId: { type: String, required: true },
  text: { type: String, required: true },
  isRead: { type: Boolean, default: false }
}, { timestamps: true });
const Message = mongoose.model('Message', MessageSchema);

// ============================================================
// REPORT SCHEMA
// ============================================================
const ReportSchema = new mongoose.Schema({
  targetSteamId: { type: String, required: true },
  authorSteamId: { type: String, required: true },
  reason: { type: String, required: true },
  details: { type: String, default: '' },
  status: { type: String, default: 'Рассматривается' }, 
  createdAt: { type: Date, default: Date.now }
});
const Report = mongoose.model('Report', ReportSchema);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
const authMiddleware = (req, res, next) => {
  const auth  = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.cookies?.tf_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const RETURN_URL   = process.env.STEAM_RETURN_URL;
const REALM        = process.env.STEAM_REALM;

// ============================================================
// STEAM AUTH
// ============================================================
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
    if (!steamId) return res.status(400).json({ error: 'No steamid' });

    let p = null;
    try {
      const apiRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`);
      const apiData = await apiRes.json();
      p = apiData.response?.players?.[0];
    } catch (e) {
      console.error("Steam API fetch failed", e);
    }

    await User.findOneAndUpdate(
      { steamid: steamId },
      { steamid: steamId, name: p?.personaname || steamId, avatar: p?.avatarmedium || null, isOnline: true, lastSeen: new Date() },
      { upsert: true, new: true }
    );

    const token = jwt.sign({ steamid: steamId, name: p?.personaname || steamId, avatar: p?.avatarmedium || null }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.redirect(`${process.env.CLIENT_ORIGIN}?token=${token}`);
  } catch (err) {
    console.error('Steam auth error', err);
    return res.status(500).json({ error: 'Steam authenticate failed' });
  }
});

app.post('/auth/logout', authMiddleware, async (req, res) => {
  await User.findOneAndUpdate({ steamid: req.user.steamid }, { isOnline: false });
  res.json({ ok: true });
});

// ============================================================
// API: ME
// ============================================================
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findOne({ steamid: req.user.steamid });
  res.json({ user });
});

// ============================================================
// API: SETTINGS
// ============================================================
app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    const { nick, bio, role, mode, region, lang, elo, faceit, mmrank, hasMic } = req.body;
    const upd = {};
    if (nick   !== undefined) upd.nick     = nick;
    if (bio    !== undefined) upd.bio      = bio;
    if (role   !== undefined) upd.role     = role;
    if (mode   !== undefined) upd.mode     = mode;
    if (region !== undefined) upd.region   = region;
    if (lang   !== undefined) upd.language = lang;
    if (elo    !== undefined) upd.elo      = Number(elo)    || 0;
    if (faceit !== undefined) upd.faceit   = Number(faceit) || 0;
    if (mmrank !== undefined) upd.mmrank   = mmrank;
    if (hasMic !== undefined) upd.hasMic   = Boolean(hasMic);
    await User.findOneAndUpdate({ steamid: req.user.steamid }, upd);
    res.json({ ok: true });
  } catch(err) {
    console.error('Settings update error', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================================
// API: PLAYERS
// ============================================================
app.get('/api/players', async (req, res) => {
  try {
    const { role, region, language, minTrust, minElo, minFaceit, mmrank, hasMic, limit = 50 } = req.query;
    const filter = {};
    if (role     && role     !== 'any') filter.role     = role;
    if (region   && region   !== 'any') filter.region   = region;
    if (language && language !== 'any') filter.language = language;
    if (mmrank   && mmrank   !== 'all') filter.mmrank   = mmrank;
    if (minTrust) filter.trustScore = { $gte: Number(minTrust) };
    if (minElo)   filter.elo        = { $gte: Number(minElo) };
    if (minFaceit) filter.faceit    = { $gte: Number(minFaceit) };
    if (hasMic === 'true') filter.hasMic = true;

    const players = await User.find(filter)
      .sort({ isOnline: -1, trustScore: -1 })
      .limit(Number(limit))
      .select('steamid name avatar nick bio elo faceit mmrank role mode region language trustScore hasMic isOnline isLookingForTeam lastSeen');

    res.json(players);
  } catch(err) {
    console.error('Players fetch error', err);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// ============================================================
// API: NOTIFICATIONS
// ============================================================
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifs = await Notification.find({ userId: req.user.steamid }).sort({ time: -1 });
    res.json(notifs);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user.steamid }, { unread: false });
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ============================================================
// API: MESSAGES (Strictly Private)
// ============================================================
app.get('/api/messages/:targetId', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { senderId: req.user.steamid, receiverId: req.params.targetId },
        { senderId: req.params.targetId, receiverId: req.user.steamid }
      ]
    }).sort({ createdAt: 1 });
    
    res.json(messages);
  } catch(err) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/messages/send', authMiddleware, async (req, res) => {
  try {
    const { targetId, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });
    if (targetId === req.user.steamid) return res.status(400).json({ error: 'Cannot send to yourself' });

    const msg = await Message.create({
      senderId: req.user.steamid,
      receiverId: targetId,
      text: text.trim()
    });

    const me = await User.findOne({ steamid: req.user.steamid });
    await Notification.create({
      userId: targetId,
      type: 'message',
      icon: '💬',
      ic: 'fr', 
      title: `Новое сообщение от ${me.name}`,
      body: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      unread: true,
      actions: ['Ответить'],
      payload: { senderId: me.steamid }
    });

    res.json({ ok: true, message: msg });
  } catch(err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================
// API: LOBBY
// ============================================================
app.get('/api/lobby/me', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) return res.json({ lobby: null });

    const membersData = await User.find({ steamid: { $in: lobby.members } })
      .select('steamid name avatar role elo mmrank isOnline');
    
    res.json({ lobby, membersData });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch lobby' });
  }
});

app.post('/api/lobby/invite', authMiddleware, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (targetId === req.user.steamid) return res.status(400).json({ error: 'Cannot invite yourself' });

    let lobby = await Lobby.findOne({ members: req.user.steamid });
    if (!lobby) {
      lobby = await Lobby.create({
        ownerId: req.user.steamid,
        members: [req.user.steamid]
      });
    }

    if (lobby.members.length >= 5) return res.status(400).json({ error: 'Lobby is full' });

    const me = await User.findOne({ steamid: req.user.steamid });
    await Notification.create({
      userId: targetId,
      type: 'invites',
      icon: '🎯',
      ic: 'inv',
      title: `${me.name} приглашает в лобби`,
      body: `Игроков: ${lobby.members.length}/5`,
      unread: true,
      actions: ['Принять инвайт', 'Отклонить'],
      payload: { lobbyId: lobby._id, senderId: req.user.steamid }
    });

    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

app.post('/api/lobby/join', authMiddleware, async (req, res) => {
  try {
    const { lobbyId, notifId } = req.body;
    const lobby = await Lobby.findById(lobbyId);
    if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
    if (lobby.members.length >= 5) return res.status(400).json({ error: 'Lobby is full' });

    await Lobby.updateMany({}, { $pull: { members: req.user.steamid } });
    
    if (!lobby.members.includes(req.user.steamid)) {
      lobby.members.push(req.user.steamid);
      await lobby.save();
    }

    if (notifId) {
      await Notification.findByIdAndUpdate(notifId, { unread: false, actions: [] });
    }

    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to join lobby' });
  }
});

app.post('/api/lobby/leave', authMiddleware, async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ members: req.user.steamid });
    if (lobby) {
      lobby.members = lobby.members.filter(id => id !== req.user.steamid);
      if (lobby.members.length === 0) {
        await Lobby.findByIdAndDelete(lobby._id);
      } else {
        if (lobby.ownerId === req.user.steamid) lobby.ownerId = lobby.members[0];
        await lobby.save();
      }
    }
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to leave lobby' });
  }
});

// ============================================================
// API: REPORTS
// ============================================================
app.post('/api/reports/add', authMiddleware, async (req, res) => {
  try {
    const { targetSteamId, reason, details } = req.body;
    if (targetSteamId === req.user.steamid) return res.status(400).json({ error: 'Cannot report yourself' });
    
    const recent = await Report.findOne({ authorSteamId: req.user.steamid, targetSteamId, status: 'Рассматривается' });
    if (recent) return res.status(400).json({ error: 'Вы уже отправили репорт на этого игрока' });

    await Report.create({
      targetSteamId,
      authorSteamId: req.user.steamid,
      reason,
      details
    });

    await User.findOneAndUpdate({ steamid: targetSteamId }, { $inc: { trustScore: -1 } });

    res.json({ ok: true });
  } catch(err) {
    console.error('Report error', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ============================================================
// API: FRIENDS
// ============================================================
app.post('/api/friends/add', authMiddleware, async (req, res) => {
  try {
    const { targetSteamId } = req.body;
    if (targetSteamId === req.user.steamid) return res.status(400).json({ error: 'Cannot add yourself' });
    
    const target = await User.findOne({ steamid: targetSteamId });
    if (!target) return res.status(404).json({ error: 'Target not found' });
    
    if (target.friends && target.friends.some(f => f.steamid === req.user.steamid)) {
      return res.status(400).json({ error: 'Already friends' });
    }

    const existing = await Notification.findOne({ userId: targetSteamId, type: 'friends', 'payload.senderId': req.user.steamid, unread: true });
    if (existing) return res.status(400).json({ error: 'Request already sent' });

    const me = await User.findOne({ steamid: req.user.steamid });
    await Notification.create({
      userId: targetSteamId,
      type: 'friends',
      icon: '👋',
      ic: 'fr',
      title: `Запрос в друзья от ${me.name}`,
      body: `${me.mmrank || 'Без ранга'} · ${me.role || 'Any'} · ${me.elo || 0} ELO`,
      unread: true,
      actions: ['Принять', 'Отклонить'],
      payload: { 
        senderId: me.steamid,
        senderName: me.name,
        senderAvatar: me.avatar,
        senderRole: me.role,
        senderElo: me.elo
      }
    });

    res.json({ ok: true });
  } catch(err) {
    console.error('Add friend error', err);
    res.status(500).json({ error: 'Failed to add friend' });
  }
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  try {
    const { notifId } = req.body;
    const notif = await Notification.findOne({ _id: notifId, userId: req.user.steamid });
    if (!notif) return res.status(404).json({ error: 'Notification not found' });
    if (!notif.payload || !notif.payload.senderId) return res.status(400).json({ error: 'Invalid payload' });

    const sender = await User.findOne({ steamid: notif.payload.senderId });
    const me = await User.findOne({ steamid: req.user.steamid });

    if (!sender || !me) return res.status(404).json({ error: 'User not found' });

    const friendForMe = {
      steamid: sender.steamid,
      name: sender.name,
      avatar: sender.avatar,
      role: sender.role,
      elo: sender.elo,
      faceit: sender.faceit,
      mmrank: sender.mmrank,
    };
    const friendForSender = {
      steamid: me.steamid,
      name: me.name,
      avatar: me.avatar,
      role: me.role,
      elo: me.elo,
      faceit: me.faceit,
      mmrank: me.mmrank,
    };

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
  } catch(err) {
    console.error('Accept friend error', err);
    res.status(500).json({ error: 'Failed to accept friend' });
  }
});

// ============================================================
// API: PROFILE
// ============================================================
app.get('/api/profile/:steamid', async (req, res) => {
  const { steamid } = req.params;
  const key = process.env.STEAM_API_KEY;
  try {
    if (typeof fetch === 'undefined') {
      return res.status(500).json({ error: 'Node version < 18. Native fetch is required.' });
    }

    const [summaryRes, statsRes, hoursRes] = await Promise.allSettled([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`),
      fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${steamid}&appid=730`),
      fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&appids_filter[0]=730&include_appinfo=false`),
    ]);

    let profile = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json();
      const p    = data.response?.players?.[0];
      if (p) {
        profile = {
          steamid: p.steamid, name: p.personaname, avatar: p.avatarfull,
          profileUrl: p.profileurl,
          status: p.personastate === 1 ? 'online' : p.personastate === 3 ? 'away' : 'offline',
          country: p.loccountrycode || null,
          createdAt: p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null,
        };
      }
    }

    let stats = null;
    if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
      const data = await statsRes.value.json();
      const raw  = data.playerstats?.stats;
      if (raw && Array.isArray(raw)) {
        const get  = name => raw.find(s => s.name === name)?.value || 0;
        const kills = get('total_kills'), deaths = get('total_deaths'), wins = get('total_wins');
        const roundsPlayed = get('total_rounds_played'), headshotKills = get('total_kills_headshot');
        const shots = get('total_shots_fired'), hits = get('total_shots_hit');
        stats = {
          kills, deaths,
          kd:       deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2),
          wins, roundsPlayed,
          winRate:  roundsPlayed > 0 ? (wins / roundsPlayed * 100).toFixed(1) : 0,
          hsRate:   kills > 0 ? (headshotKills / kills * 100).toFixed(1) : 0,
          mvps:     get('total_mvps'),
          accuracy: shots > 0 ? (hits / shots * 100).toFixed(1) : 0,
        };
      }
    }

    let hoursCs2 = null;
    if (hoursRes.status === 'fulfilled' && hoursRes.value.ok) {
      const data = await hoursRes.value.json();
      const game = data.response?.games?.[0];
      if (game) hoursCs2 = Math.round(game.playtime_forever / 60);
    }

    const dbUser = await User.findOne({ steamid }).select('elo faceit mmrank role mode region nick bio trustScore friends');
    const reports = await Report.find({ targetSteamId: steamid }).sort({ createdAt: -1 }).limit(10);

    return res.json({ profile, stats, hoursCs2, gameData: dbUser || null, friends: dbUser?.friends || [], reports });
  } catch(err) {
    console.error('Profile fetch error', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`TEAMFINDER backend listening on ${port}`));
