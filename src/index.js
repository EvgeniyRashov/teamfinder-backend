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
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Healthcheck (нужно для Railway)
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
  type: String, // 'invites', 'friends', 'system'
  icon: String,
  ic: String,
  title: String,
  body: String,
  time: { type: Date, default: Date.now },
  unread: { type: Boolean, default: true },
  actions: [String],
  payload: mongoose.Schema.Types.Mixed // to store sender steamid, avatar, stats
});
const Notification = mongoose.model('Notification', NotifSchema);


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
app.get('/api/notifications', 
