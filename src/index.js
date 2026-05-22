require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const SteamAuth = require('node-steam-openid');

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());

const steam = new SteamAuth({
  realm: process.env.STEAM_REALM,
  returnUrl: process.env.STEAM_RETURN_URL,
  apiKey: process.env.STEAM_API_KEY
});

// редирект на Steam
app.get('/auth/steam', async (req, res) => {
  try {
    const redirectUrl = await steam.getRedirectUrl();
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('Steam redirect error', err);
    return res.status(500).json({ error: 'Steam redirect failed' });
  }
});

// callback от Steam
app.get('/auth/steam/authenticate', async (req, res) => {
  try {
    const user = await steam.authenticate(req);
    const payload = {
      steamid: user.steamid,
      name: user.username,
      avatar: user.avatar?.medium || null
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('tf_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return res.redirect(process.env.CLIENT_ORIGIN + '/#home');
  } catch (err) {
    console.error('Steam auth error', err);
    return res.status(500).json({ error: 'Steam authenticate failed' });
  }
});

// выход
app.post('/auth/logout', (req, res) => {
  res.clearCookie('tf_token', { httpOnly: true, secure: true, sameSite: 'lax' });
  return res.json({ ok: true });
});

// текущий пользователь
app.get('/api/me', (req, res) => {
  const token = req.cookies.tf_token;
  if (!token) return res.json({ user: null });
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ user: data });
  } catch {
    return res.json({ user: null });
  }
});

// профиль игрока по steamid
app.get('/api/profile/:steamid', async (req, res) => {
  const { steamid } = req.params;
  const key = process.env.STEAM_API_KEY;

  try {
    // Базовый профиль Steam
    const [summaryRes, statsRes, hoursRes] = await Promise.allSettled([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`),
      fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${steamid}&appid=730`),
      fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&appids_filter[0]=730&include_appinfo=false`)
    ]);

    // Парсим профиль
    let profile = {};
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const data = await summaryRes.value.json();
      const p = data.response?.players?.[0] || {};
      profile = {
        steamid: p.steamid,
        name: p.personaname,
        avatar: p.avatarfull,
        profileUrl: p.profileurl,
        status: p.personastate === 1 ? 'online' : p.personastate === 3 ? 'away' : 'offline',
        country: p.loccountrycode || null,
        createdAt: p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null
      };
    }

    // Парсим статистику CS2
    let stats = {};
    if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
      const data = await statsRes.value.json();
      const raw = data.playerstats?.stats || [];
      const get = (name) => raw.find(s => s.name === name)?.value || 0;
      const kills = get('total_kills');
      const deaths = get('total_deaths');
      const wins = get('total_wins');
      const roundsPlayed = get('total_rounds_played');
      const headshotKills = get('total_kills_headshot');
      stats = {
        kills,
        deaths,
        kd: deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2),
        wins,
        roundsPlayed,
        winRate: roundsPlayed > 0 ? ((wins / roundsPlayed) * 100).toFixed(1) : '0',
        hsRate: kills > 0 ? ((headshotKills / kills) * 100).toFixed(1) : '0',
        mvps: get('total_mvps'),
        accuracy: (() => {
          const shots = get('total_shots_fired');
          const hits = get('total_shots_hit');
          return shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0';
        })()
      };
    }

    // Часы в CS2
    let hoursCs2 = null;
    if (hoursRes.status === 'fulfilled' && hoursRes.value.ok) {
      const data = await hoursRes.value.json();
      const game = data.response?.games?.[0];
      if (game) hoursCs2 = Math.round(game.playtime_forever / 60);
    }

    return res.json({ profile, stats, hoursCs2 });
  } catch (err) {
    console.error('Profile fetch error', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log('TEAMFINDER backend listening on', port);
});
