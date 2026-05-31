require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const https = require('https');
const querystring = require('querystring');
const mongoose = require('mongoose');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const UserSchema = new mongoose.Schema({
  steamid: { type: String, unique: true },
  name: String,
  avatar: String,
  elo: { type: Number, default: 0 },
  role: { type: String, default: 'any' },
  region: { type: String, default: 'any' },
  language: { type: String, default: 'ru' },
  trustScore: { type: Number, default: 50 },
  hasMic: { type: Boolean, default: false },
  isLookingForTeam: { type: Boolean, default: false },
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization;
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
const RETURN_URL = process.env.STEAM_RETURN_URL;
const REALM = process.env.STEAM_REALM;

app.get('/auth/steam', (req, res) => {
  const params = querystring.stringify({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': RETURN_URL,
    'o
