'use strict';
// End-to-end smoke test: starts the server, registers 2 users, logs in,
// checks online presence, runs a full call (invite -> accept -> signal -> end).
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livecall-test-'));

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body, token) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}
const once = (s, ev) => new Promise((r) => s.once(ev, r));
const ack = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dataDir },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (_) {}
      await sleep(100);
    }

    const a = await post('/api/register', { mobile: '9876543210', name: 'Asha', password: 'secret1' });
    const b = await post('/api/register', { mobile: '+91 98765 00000', name: 'Bikram', password: 'secret2' });
    check('register A', a.status === 200 && a.body.token);
    check('register B (+91 formatting)', b.status === 200 && b.body.user.mobile === '9876500000');
    const dup = await post('/api/register', { mobile: '09876543210', name: 'Dup', password: 'secret3' });
    check('duplicate mobile rejected', dup.status === 409);
    const bad = await post('/api/login', { mobile: '9876543210', password: 'wrong' });
    check('wrong password rejected', bad.status === 401);
    const ok = await post('/api/login', { mobile: '9876543210', password: 'secret1' });
    check('login works', ok.status === 200 && ok.body.token);
    const noTok = await fetch(BASE + '/api/me');
    check('/api/me needs auth', noTok.status === 401);
    let rejected = false;
    try { await connect('bad-token'); } catch (_) { rejected = true; }
    check('socket rejects bad token', rejected);

    const sa = await connect(ok.body.token);
    const presenceForA = once(sa, 'presence');
    const sb = await connect(b.body.token);
    await presenceForA;
    await sleep(150);
    const list = await new Promise((r) => { sa.once('presence', r); sb.disconnect(); sb.connect(); });
    check('presence lists both users by name', list.some((u) => u.name === 'Asha') && list.some((u) => u.name === 'Bikram'));
    const bId = b.body.user.id;
    await sleep(150);

    const incoming = once(sb, 'call:incoming');
    const r1 = await ack(sa, 'call:invite', { to: bId });
    const inc = await incoming;
    check('invite ok + incoming has caller name', r1.ok && inc.from.name === 'Asha');

    const accepted = once(sa, 'call:accepted');
    const r2 = await ack(sb, 'call:accept', { callId: inc.callId });
    await accepted;
    check('accept ok', r2.ok);

    const sigAtB = once(sb, 'signal');
    sa.emit('signal', { callId: inc.callId, data: { description: { type: 'offer', sdp: 'x' } } });
    const got = await sigAtB;
    check('signal relayed caller -> callee', got.data.description.type === 'offer');

    const busyTry = await ack(sa, 'call:invite', { to: bId });
    check('busy user cannot be called', !busyTry.ok);

    const endedAtA = once(sa, 'call:ended');
    sb.emit('call:end', { callId: inc.callId });
    const ended = await endedAtA;
    check('call end notifies other side', ended.reason === 'ended');

    const inc2p = once(sb, 'call:incoming');
    await ack(sa, 'call:invite', { to: bId });
    const inc2 = await inc2p;
    const rej = once(sa, 'call:ended');
    sb.emit('call:reject', { callId: inc2.callId });
    check('reject notifies caller', (await rej).reason === 'rejected');

    sa.disconnect(); sb.disconnect();
  } catch (e) {
    console.error('TEST ERROR', e);
    failures++;
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
