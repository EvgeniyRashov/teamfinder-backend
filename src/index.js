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

// Steam OpenID
const steam = new SteamAuth({
  realm: process.env.STEAM_REALM,          // базовый URL бэка
  returnUrl: process.env.STEAM_RETURN_URL, // callback URL
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
    const user = await steam.authenticate(req); // steamid, username, avatar и т.п.[web:142]

    const payload = {
      steamid: user.steamid,
      name: user.username,
      avatar: user.avatar?.medium || null
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: '7d'
    });

    res.cookie('tf_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // возвращаем на фронт
    return res.redirect(process.env.CLIENT_ORIGIN + '/#home');
  } catch (err) {
    console.error('Steam auth error', err);
    return res.status(500).json({ error: 'Steam authenticate failed' });
  }
});

// текущий пользователь
app.get('/api/me', (req, res) => {
  const token = req.cookies.tf_token;
  if (!token) return res.status(401).json({ user: null });

  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ user: data });
  } catch {
    return res.status(401).json({ user: null });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log('TEAMFINDER backend listening on', port);
});
