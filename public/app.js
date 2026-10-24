(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /* ---------------- State ---------------- */
  let token = localStorage.getItem('lc_token') || '';
  let me = null;
  let socket = null;
  let onlineUsers = [];
  let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let authMode = 'login';
  let call = null;      // active outgoing/active call
  let incoming = null;  // ringing incoming call

  const initial = (name) => (name || '?').trim().charAt(0) || '?';

  /* ---------------- UI helpers ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  }

  function show(view) {
    $('#authView').hidden = view !== 'auth';
    $('#appView').hidden = view !== 'app';
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function emitAck(event, payload) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); }
      }, 8000);
      socket.emit(event, payload, (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r || { ok: false });
      });
    });
  }

  /* ---------------- Auth ---------------- */
  function setMode(mode) {
    authMode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    $('#nameField').hidden = mode !== 'register';
    $('#authSubmit').textContent = mode === 'register' ? 'Create account' : 'Login';
    $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('#authError').textContent = '';
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#authSubmit');
    const errBox = $('#authError');
    errBox.textContent = '';
    btn.disabled = true;
    try {
      const body = { mobile: $('#mobile').value.trim(), password: $('#password').value };
      if (authMode === 'register') body.name = $('#name').value.trim();
      const data = await api(authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body });
      token = data.token;
      localStorage.setItem('lc_token', token);
      me = data.user;
      $('#password').value = '';
      enterApp();
    } catch (err) {
      errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function logout() {
    if (call) hangup();
    if (socket) { socket.disconnect(); socket = null; }
    token = '';
    me = null;
    onlineUsers = [];
    localStorage.removeItem('lc_token');
    show('auth');
  }
  $('#logoutBtn').addEventListener('click', logout);

  /* ---------------- App ---------------- */
  async function enterApp() {
    $('#meName').textContent = me.name;
    $('#meAvatar').textContent = initial(me.name);
    show('app');
    renderUsers();
    try { iceConfig = await api('/api/ice'); } catch (_) {}
    connectSocket();
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect', () => { $('#meStatus').innerHTML = '<span class="dot"></span> Online'; });
    socket.on('disconnect', () => { $('#meStatus').textContent = 'Reconnecting…'; });
    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') {
        toast('Session expired. Please login again.');
        logout();
      }
    });

    socket.on('presence', (list) => { onlineUsers = list; renderUsers(); });
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:ended', onEnded);
    socket.on('signal', onSignal);
  }

  function renderUsers() {
    const list = $('#userList');
    list.innerHTML = '';
    const others = onlineUsers
      .filter((u) => !me || u.id !== me.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#onlineCount').textContent = others.length;
    $('#emptyState').hidden = others.length > 0;

    for (const u of others) {
      const li = el('li', 'user-item');
      li.appendChild(el('span', 'avatar', initial(u.name)));
      const info = el('div', 'user-info');
      info.appendChild(el('strong', null, u.name));
      const sm = el('small');
      sm.appendChild(el('span', 'dot' + (u.busy ? ' busy' : '')));
      sm.appendChild(document.createTextNode(u.busy ? 'In a call' : 'Available'));
      info.appendChild(sm);
      li.appendChild(info);

      const btn = el('button', 'call-btn');
      btn.innerHTML = '<svg class="i"><use href="#i-video"/></svg>';
      btn.appendChild(document.createTextNode('Call'));
      btn.disabled = u.busy || !!call || !!incoming;
      btn.addEventListener('click', () => startCall(u));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  /* ---------------- Media ---------------- */
  async function getMedia(facingMode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access needs a secure (HTTPS) connection.');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: facingMode || 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        throw new Error('Please allow camera and microphone access to make calls.');
      }
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (_) {
          throw new Error('No camera or microphone found on this device.');
        }
      }
      throw new Error('Could not start camera/microphone.');
    }
  }

  function createPC() {
    const pc = new RTCPeerConnection(iceConfig);
    call.localStream.getTracks().forEach((t) => pc.addTrack(t, call.localStream));

    pc.ontrack = (e) => {
      if (!call || call.pc !== pc) return;
      const rv = $('#remoteVideo');
      if (rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
      $('#remotePlaceholder').classList.add('hide');
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && call && call.pc === pc) {
        socket.emit('signal', { callId: call.id, data: { candidate: e.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (!call || call.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') { startTimer(); }
      else if (s === 'disconnected') { setStatus('Reconnecting…'); }
      else if (s === 'failed') { toast('Connection failed. Please try again.'); hangup(); }
    };
    call.pc = pc;
    return pc;
  }

  function showCallView(peerName, status) {
    $('#peerName').textContent = peerName;
    $('#peerAvatar').textContent = initial(peerName);
    $('#remotePlaceholder').classList.remove('hide');
    $('#remoteVideo').srcObject = null;
    $('#localVideo').srcObject = call.localStream;
    $('#localVideo').classList.remove('nomirror');
    setStatus(status);
    resetControls();
    $('#callView').hidden = false;
  }

  function setStatus(text) { $('#callStatus').textContent = text; }

  function startTimer() {
    if (call.timerId) return;
    call.startedAt = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - call.startedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      setStatus(mm + ':' + ss);
    };
    tick();
    call.timerId = setInterval(tick, 1000);
  }

  function cleanupCall() {
    if (!call) return;
    clearInterval(call.timerId);
    if (call.pc) { try { call.pc.close(); } catch (_) {} }
    if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
    call = null;
    $('#callView').hidden = true;
    $('#remoteVideo').srcObject = null;
    $('#localVideo').srcObject = null;
    renderUsers();
  }

  /* ---------------- Outgoing call ---------------- */
  async function startCall(peer) {
    if (call || incoming) return;
    let stream;
    try {
      stream = await getMedia();
    } catch (err) {
      return toast(err.message);
    }
    call = { id: null, peerId: peer.id, peerName: peer.name, role: 'caller', localStream: stream, pc: null, pendingIce: [], facing: 'user' };
    showCallView(peer.name, 'Calling…');
    renderUsers();

    const r = await emitAck('call:invite', { to: peer.id });
    if (!call) return; // cancelled meanwhile
    if (!r.ok) {
      const msgs = {
        offline: peer.name + ' just went offline.',
        busy: peer.name + ' is on another call.',
        you_busy: 'You are already in a call.',
        timeout: 'Network is slow. Please try again.'
      };
      toast(msgs[r.error] || 'Could not place the call.');
      return cleanupCall();
    }
    call.id = r.callId;
    setStatus('Ringing…');
  }

  async function onAccepted({ callId }) {
    if (!call || call.id !== callId || call.role !== 'caller') return;
    setStatus('Connecting…');
    try {
      const pc = createPC();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { callId, data: { description: pc.localDescription } });
    } catch (e) {
      toast('Could not start the call.');
      hangup();
    }
  }

  /* ---------------- Incoming call ---------------- */
  function onIncoming({ callId, from }) {
    if (call || incoming) {
      // already busy; server normally prevents this
      socket.emit('call:reject', { callId });
      return;
    }
    incoming = { callId, from };
    $('#incName').textContent = from.name;
    $('#incAvatar').textContent = initial(from.name);
    $('#incomingView').hidden = false;
    startRing();
    renderUsers();
  }

  function closeIncoming() {
    incoming = null;
    stopRing();
    $('#incomingView').hidden = true;
    renderUsers();
  }

  $('#rejectBtn').addEventListener('click', () => {
    if (!incoming) return;
    socket.emit('call:reject', { callId: incoming.callId });
    closeIncoming();
  });

  $('#acceptBtn').addEventListener('click', async () => {
    if (!incoming) return;
    const inc = incoming;
    let stream;
    try {
      stream = await getMedia();
    } catch (err) {
      toast(err.message);
      socket.emit('call:reject', { callId: inc.callId });
      return closeIncoming();
    }
    if (!incoming || incoming.callId !== inc.callId) { // caller hung up while we asked for permission
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    closeIncoming();
    call = { id: inc.callId, peerId: inc.from.id, peerName: inc.from.name, role: 'callee', localStream: stream, pc: null, pendingIce: [], facing: 'user' };
    showCallView(inc.from.name, 'Connecting…');
    createPC();
    const r = await emitAck('call:accept', { callId: inc.callId });
    if (!r.ok) {
      toast('The call is no longer available.');
      cleanupCall();
    }
  });

  /* ---------------- Signaling ---------------- */
  async function onSignal({ callId, data }) {
    if (!call || call.id !== callId || !call.pc) return;
    const pc = call.pc;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        for (const c of call.pendingIce) await pc.addIceCandidate(c);
        call.pendingIce = [];
        if (data.description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { callId, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else call.pendingIce.push(data.candidate);
      }
    } catch (e) {
      console.warn('signal error', e);
    }
  }

  function onEnded({ callId, reason }) {
    if (incoming && incoming.callId === callId) {
      const name = incoming.from.name;
      closeIncoming();
      if (reason === 'cancelled' || reason === 'missed' || reason === 'disconnected') toast('Missed call from ' + name);
      return;
    }
    if (!call || call.id !== callId) return;
    const name = call.peerName;
    const messages = {
      rejected: name + ' declined the call.',
      missed: name + ' did not answer.',
      ended: 'Call ended.',
      disconnected: name + ' lost connection.',
      answered_elsewhere: 'Answered on another device.'
    };
    toast(messages[reason] || 'Call ended.');
    cleanupCall();
  }

  function hangup() {
    if (!call) return;
    if (call.id && socket) socket.emit('call:end', { callId: call.id });
    cleanupCall();
  }
  $('#hangBtn').addEventListener('click', hangup);

  /* ---------------- In-call controls ---------------- */
  function resetControls() {
    $('#muteBtn').classList.remove('off');
    $('#camBtn').classList.remove('off');
    $('#muteBtn use').setAttribute('href', '#i-mic');
    $('#camBtn use').setAttribute('href', '#i-cam');
  }

  $('#muteBtn').addEventListener('click', () => {
    if (!call) return;
    const tracks = call.localStream.getAudioTracks();
    if (!tracks.length) return;
    const enable = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enable));
    $('#muteBtn').classList.toggle('off', !enable);
    $('#muteBtn use').setAttribute('href', enable ? '#i-mic' : '#i-mic-off');
  });

  $('#camBtn').addEventListener('click', () => {
    if (!call) return;
    const tracks = call.localStream.getVideoTracks();
    if (!tracks.length) return toast('No camera available.');
    const enable = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enable));
    $('#camBtn').classList.toggle('off', !enable);
    $('#camBtn use').setAttribute('href', enable ? '#i-cam' : '#i-cam-off');
  });

  $('#flipBtn').addEventListener('click', async () => {
    if (!call) return;
    const oldTrack = call.localStream.getVideoTracks()[0];
    if (!oldTrack) return toast('No camera available.');
    const next = call.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } } });
      const newTrack = s.getVideoTracks()[0];
      newTrack.enabled = oldTrack.enabled;
      const sender = call.pc && call.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      call.localStream.removeTrack(oldTrack);
      oldTrack.stop();
      call.localStream.addTrack(newTrack);
      $('#localVideo').srcObject = call.localStream;
      call.facing = next;
      $('#localVideo').classList.toggle('nomirror', next === 'environment');
    } catch (_) {
      toast('Could not switch camera.');
    }
  });

  /* ---------------- Ringtone ---------------- */
  let ringCtx = null;
  let ringTimer = null;
  function startRing() {
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (ringCtx.state === 'suspended') ringCtx.resume();
      const beep = () => {
        const t = ringCtx.currentTime;
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.frequency.value = 480;
        o.connect(g);
        g.connect(ringCtx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.start(t);
        o.stop(t + 0.65);
        if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
      };
      beep();
      ringTimer = setInterval(beep, 2000);
    } catch (_) {}
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  /* ---------------- Boot ---------------- */
  (async function boot() {
    setMode('login');
    if (!token) return show('auth');
    try {
      const data = await api('/api/me');
      me = data.user;
      enterApp();
    } catch (err) {
      if (err.status === 401) { token = ''; localStorage.removeItem('lc_token'); }
      show('auth');
    }
  })();

  window.addEventListener('beforeunload', () => { if (call && call.id && socket) socket.emit('call:end', { callId: call.id }); });
})();
