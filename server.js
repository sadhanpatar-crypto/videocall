'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Secret                                                              */
/* ------------------------------------------------------------------ */
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt_secret');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s) return s;
  } catch (_) {}
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch (_) {}
  return s;
}
const JWT_SECRET = getSecret();

/* ------------------------------------------------------------------ */
/* Tiny JSON user store                                                */
/* ------------------------------------------------------------------ */
let db = { users: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (parsed && Array.isArray(parsed.users)) db = parsed;
} catch (_) {}

const usersById = new Map();
const usersByMobile = new Map();
for (const u of db.users) {
  usersById.set(u.id, u);
  usersByMobile.set(u.mobile, u);
}

let saveTimer = null;
function saveDbNow() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { saveDbNow(); } catch (e) { console.error('DB save failed:', e.message); }
  }, 150);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function normMobile(input) {
  let m = String(input || '').replace(/[\s\-()]/g, '');
  if (m.startsWith('+')) m = m.slice(1);
  if (!/^\d{10,15}$/.test(m)) return null;
  if (m.length === 12 && m.startsWith('91')) m = m.slice(2); // +91 India
  else if (m.length === 11 && m.startsWith('0')) m = m.slice(1);
  return m;
}

function cleanName(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function publicUser(u) {
  return { id: u.id, name: u.name, mobile: u.mobile };
}

function signToken(u) {
  return jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) {
    h = { count: 0, reset: now + windowMs };
    hits.set(key, h);
  }
  h.count += 1;
  return h.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 60000).unref();

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/* ------------------------------------------------------------------ */
/* Express                                                             */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const u = usersById.get(p.uid);
    if (!u) throw new Error('no user');
    req.user = u;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Session expired. Please login again.' });
  }
}

app.get('/healthz', (req, res) => res.json({ ok: true, online: online.size }));

app.post('/api/register', async (req, res) => {
  try {
    if (limited('reg:' + req.ip, 10, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    const mobile = normMobile(req.body.mobile);
    const name = cleanName(req.body.name);
    const password = String(req.body.password || '');
    if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number (10-15 digits).' });
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Name must be 2-30 characters.' });
    if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Password must be 6-72 characters.' });
    if (usersByMobile.has(mobile)) return res.status(409).json({ error: 'This mobile number is already registered. Please login.' });

    const passHash = await bcrypt.hash(password, 10);
    if (usersByMobile.has(mobile)) return res.status(409).json({ error: 'This mobile number is already registered. Please login.' });
    const user = { id: crypto.randomUUID(), mobile, name, passHash, createdAt: Date.now() };
    db.users.push(user);
    usersById.set(user.id, user);
    usersByMobile.set(mobile, user);
    saveDb();
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const mobile = normMobile(req.body.mobile);
    const password = String(req.body.password || '');
    const key = 'login:' + req.ip + ':' + (mobile || 'x');
    if (limited(key, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const user = mobile ? usersByMobile.get(mobile) : null;
    const ok = await bcrypt.compare(password, user ? user.passHash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect mobile number or password.' });
    hits.delete(key);
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/ice', auth, (req, res) => {
  const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean) }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ iceServers });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

/* ------------------------------------------------------------------ */
/* Socket.IO: presence + call signaling                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 8000 });

const online = new Map(); // userId -> Set(socketId)
const calls = new Map(); // callId -> call
const busy = new Map(); // userId -> callId

function presenceList() {
  const list = [];
  for (const uid of online.keys()) {
    const u = usersById.get(uid);
    if (u) list.push({ id: uid, name: u.name, busy: busy.has(uid) });
  }
  return list;
}
function broadcastPresence() {
  io.emit('presence', presenceList());
}
function emitToUser(uid, event, payload) {
  const set = online.get(uid);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

function endCall(call, reason) {
  if (!call || call.done) return;
  call.done = true;
  clearTimeout(call.timer);
  calls.delete(call.id);
  if (busy.get(call.callerId) === call.id) busy.delete(call.callerId);
  if (busy.get(call.calleeId) === call.id) busy.delete(call.calleeId);
  const payload = { callId: call.id, reason };
  emitToUser(call.callerId, 'call:ended', payload);
  emitToUser(call.calleeId, 'call:ended', payload);
  broadcastPresence();
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const p = jwt.verify(token, JWT_SECRET);
    const u = usersById.get(p.uid);
    if (!u) throw new Error('no user');
    socket.user = u;
    next();
  } catch (_) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const me = socket.user;
  const uid = me.id;

  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  broadcastPresence();

  socket.on('call:invite', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const to = data && data.to;
    const callee = usersById.get(to);
    if (!callee || to === uid) return ack({ ok: false, error: 'invalid' });
    if (!online.has(to)) return ack({ ok: false, error: 'offline' });
    if (busy.has(uid)) return ack({ ok: false, error: 'you_busy' });
    if (busy.has(to)) return ack({ ok: false, error: 'busy' });

    const call = {
      id: crypto.randomUUID(),
      callerId: uid,
      calleeId: to,
      callerSock: socket.id,
      calleeSock: null,
      state: 'ringing',
      done: false,
      timer: null
    };
    call.timer = setTimeout(() => endCall(call, 'missed'), 45000);
    calls.set(call.id, call);
    busy.set(uid, call.id);
    busy.set(to, call.id);

    emitToUser(to, 'call:incoming', { callId: call.id, from: { id: uid, name: me.name } });
    ack({ ok: true, callId: call.id });
    broadcastPresence();
  });

  socket.on('call:accept', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const call = data && calls.get(data.callId);
    if (!call || call.calleeId !== uid || call.state !== 'ringing') return ack({ ok: false });
    call.state = 'active';
    call.calleeSock = socket.id;
    clearTimeout(call.timer);
    const set = online.get(uid);
    if (set) {
      for (const sid of set) {
        if (sid !== socket.id) io.to(sid).emit('call:ended', { callId: call.id, reason: 'answered_elsewhere' });
      }
    }
    io.to(call.callerSock).emit('call:accepted', { callId: call.id });
    ack({ ok: true });
  });

  socket.on('call:reject', (data) => {
    const call = data && calls.get(data.callId);
    if (!call || call.calleeId !== uid || call.state !== 'ringing') return;
    endCall(call, 'rejected');
  });

  socket.on('call:end', (data) => {
    const call = data && calls.get(data.callId);
    if (!call || (call.callerId !== uid && call.calleeId !== uid)) return;
    endCall(call, call.state === 'ringing' && call.callerId === uid ? 'cancelled' : 'ended');
  });

  socket.on('signal', (data) => {
    const call = data && calls.get(data.callId);
    if (!call || call.state !== 'active') return;
    let target = null;
    if (socket.id === call.callerSock) target = call.calleeSock;
    else if (socket.id === call.calleeSock) target = call.callerSock;
    if (!target) return;
    io.to(target).emit('signal', { callId: call.id, data: data.data });
  });

  socket.on('disconnect', () => {
    const set = online.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) online.delete(uid);
    }
    for (const call of [...calls.values()]) {
      if (call.callerSock === socket.id || call.calleeSock === socket.id) {
        endCall(call, 'disconnected');
      } else if (call.state === 'ringing' && call.calleeId === uid && !online.has(uid)) {
        endCall(call, 'missed');
      }
    }
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`LiveCall running on http://localhost:${PORT}`);
});

function shutdown() {
  try { saveDbNow(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
