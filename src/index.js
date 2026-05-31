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

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

// ============================================================
// SCHEMA — добавлены: nick, bio, faceit, mmrank
// ============================================================
const UserSchema = new mongoose.Schema({
  steamid:         { type: String, unique: true },
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
  createdAt:       { type: Date, default: Date.now },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

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
  } catch {
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

    const apiRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`);
    const apiData = await apiRes.json();
    const p       = apiData.response?.players?.[0];

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
// API: SETTINGS — сохранение elo/faceit/mmrank и др.
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
// API: PLAYERS — для поиска (возвращает faceit/mmrank)
// ============================================================
app.get('/api/players', async (req, res) => {
  try {
    const { role, region, language, minTrust, minElo, hasMic, limit = 50 } = req.query;
    const filter = {};
    if (role     && role     !== 'any') filter.role     = role;
    if (region   && region   !== 'any') filter.region   = region;
    if (language && language !== 'any') filter.language = language;
    if (minTrust) filter.trustScore = { $gte: Number(minTrust) };
    if (minElo)   filter.elo        = { $gte: Number(minElo) };
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
// API: PROFILE — профиль игрока + Steam stats
// ============================================================
app.get('/api/profile/:steamid', async (req, res) => {
  const { steamid } = req.params;
  const key = process.env.STEAM_API_KEY;
  try {
    const [summaryRes, statsRes, hoursRes] = await Promise.allSettled([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`),
      fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${steamid}&appid=730`),
      fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&appids_filter[0]=730&include_appinfo=false`),
    ]);

    let profile = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json();
      const p    = data.response?.players?.[0];
      profile = {
        steamid: p.steamid, name: p.personaname, avatar: p.avatarfull,
        profileUrl: p.profileurl,
        status: p.personastate === 1 ? 'online' : p.personastate === 3 ? 'away' : 'offline',
        country: p.loccountrycode || null,
        createdAt: p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null,
      };
    }

    let stats = null;
    if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
      const data = await statsRes.value.json();
      const raw  = data.playerstats?.stats;
      const get  = name => raw?.find(s => s.name === name)?.value || 0;
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

    let hoursCs2 = null;
    if (hoursRes.status === 'fulfilled' && hoursRes.value.ok) {
      const data = await hoursRes.value.json();
      const game = data.response?.games?.[0];
      if (game) hoursCs2 = Math.round(game.playtime_forever / 60);
    }

    // Добавляем данные из нашей БД (elo, faceit, mmrank)
    const dbUser = await User.findOne({ steamid }).select('elo faceit mmrank role mode region nick bio trustScore');

    return res.json({ profile, stats, hoursCs2, gameData: dbUser || null });
  } catch(err) {
    console.error('Profile fetch error', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`TEAMFINDER backend listening on ${port}`));
