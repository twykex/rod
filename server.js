/**
 * VoxLink Server v2.0.0 — High-Fidelity Voice Chat
 *
 * v2 upgrades: room passwords, admin/owner system, text chat, 
 * kick/mute, heartbeat, rate limiting, capacity, connection quality relay
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const CONFIG = {
  maxRooms: 100, defaultCapacity: 25, maxCapacity: 50,
  chatHistorySize: 200, maxMsgLen: 2000, maxNameLen: 32,
  heartbeatMs: 30000, rateLimit: { window: 1000, max: 30 },
  speakThrottleMs: 100, defaultRoomIds: []
};

const rooms = new Map();
const clients = new Map();

class ClientState {
  constructor(ws, userId) {
    this.ws = ws; this.userId = userId;
    this.displayName = `User-${userId.slice(0, 4)}`;
    this.currentRoomId = null; this.isAlive = true;
    this.lastSpeak = 0; this.isMutedByAdmin = false;
    this.audioSettings = {
      sendBitrate: 128, sampleRate: 48000, channelCount: 2,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      noiseGateThreshold: -50, dtx: false, fec: true, packetLoss: 0,
      jitterBuffer: 'adaptive'
    };
    this.connQuality = { rtt: 0, jitter: 0, packetLoss: 0 };
    this._ts = [];
  }
  rateOk() {
    const now = Date.now();
    this._ts = this._ts.filter(t => now - t < CONFIG.rateLimit.window);
    if (this._ts.length >= CONFIG.rateLimit.max) return false;
    this._ts.push(now); return true;
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
}

class Room {
  constructor(id, name, opts = {}) {
    this.id = id; this.name = name;
    this.password = opts.password || null;
    this.capacity = Math.min(opts.capacity || CONFIG.defaultCapacity, CONFIG.maxCapacity);
    this.ownerId = opts.ownerId || null;
    this.createdAt = Date.now();
    this.users = new Map(); this.chat = [];
    this.isDefault = opts.isDefault || false;
    this.description = opts.description || '';
    this.icon = opts.icon || '🎙';
  }
  get size() { return this.users.size; }
  add(c) { this.users.set(c.userId, c); c.currentRoomId = this.id; c.isMutedByAdmin = false; }
  remove(uid) {
    const c = this.users.get(uid);
    if (c) { c.currentRoomId = null; c.isMutedByAdmin = false; }
    this.users.delete(uid);
    if (this.ownerId === uid && this.size > 0) {
      this.ownerId = this.users.keys().next().value;
      this.broadcast({ type: 'room-owner-changed', newOwnerId: this.ownerId });
    }
  }
  broadcast(msg, skip = null) {
    const p = JSON.stringify(msg);
    for (const [uid, c] of this.users) { if (uid !== skip && c.ws.readyState === 1) c.ws.send(p); }
  }
  addChat(uid, name, text) {
    const m = { id: uuidv4().slice(0,8), userId: uid, displayName: name, text: text.slice(0, CONFIG.maxMsgLen), timestamp: Date.now() };
    this.chat.push(m);
    if (this.chat.length > CONFIG.chatHistorySize) this.chat.shift();
    return m;
  }
  toJSON(full = true) {
    const o = { id: this.id, name: this.name, hasPassword: !!this.password, capacity: this.capacity, userCount: this.size, ownerId: this.ownerId, isDefault: this.isDefault, description: this.description, icon: this.icon };
    if (full) o.users = [...this.users.values()].map(c => ({ id: c.userId, displayName: c.displayName, audioSettings: c.audioSettings, connQuality: c.connQuality, isMutedByAdmin: c.isMutedByAdmin }));
    return o;
  }
}

function makeRoom(name, opts = {}) {
  if (rooms.size >= CONFIG.maxRooms) return null;
  let id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48) || uuidv4().slice(0, 8);
  if (rooms.has(id)) id += '-' + uuidv4().slice(0, 4);
  const r = new Room(id, name || id, opts);
  rooms.set(id, r); return r;
}

function roomList() { return [...rooms.values()].map(r => r.toJSON(true)); }
function pushRooms() {
  const p = JSON.stringify({ type: 'room-list', rooms: roomList() });
  for (const [ws] of clients) { if (ws.readyState === 1) ws.send(p); }
}
function cleanup(r) { if (r.size === 0 && !r.isDefault) rooms.delete(r.id); }

[{ n: 'General', i: '💬', d: 'Hang out and chat' },
 { n: 'Music Production', i: '🎵', d: 'Hi-fi audio for producers' },
 { n: 'Gaming', i: '🎮', d: 'Low-latency game chat' },
 { n: 'Studio', i: '🎛', d: 'Lossless studio monitoring' }
].forEach(x => { const r = makeRoom(x.n, { isDefault: true, description: x.d, icon: x.i }); if (r) CONFIG.defaultRoomIds.push(r.id); });

wss.on('connection', (ws) => {
  const c = new ClientState(ws, uuidv4());
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  c.send({ type: 'welcome', userId: c.userId, rooms: roomList(), serverTime: Date.now() });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!c.rateOk()) { c.send({ type: 'error', code: 'RATE_LIMIT', message: 'Slow down' }); return; }
    handle(c, m);
  });
  ws.on('close', () => disc(c));
  ws.on('error', () => disc(c));
});

function disc(c) {
  if (c.currentRoomId) {
    const r = rooms.get(c.currentRoomId);
    if (r) { r.remove(c.userId); r.broadcast({ type: 'user-left', userId: c.userId }); cleanup(r); }
  }
  clients.delete(c.ws); pushRooms();
}

function handle(c, m) {
  switch (m.type) {
    case 'set-name': {
      const n = (m.displayName || '').trim().slice(0, CONFIG.maxNameLen);
      if (!n) break; c.displayName = n;
      if (c.currentRoomId) { const r = rooms.get(c.currentRoomId); if (r) r.broadcast({ type: 'user-updated', userId: c.userId, displayName: c.displayName, audioSettings: c.audioSettings, connQuality: c.connQuality }); }
      pushRooms(); break;
    }
    case 'create-room': {
      const n = (m.name || '').trim().slice(0, 48);
      if (!n) { c.send({ type: 'error', message: 'Name required' }); break; }
      const r = makeRoom(n, { password: m.password || null, capacity: m.capacity || CONFIG.defaultCapacity, ownerId: c.userId, description: m.description || '', icon: m.icon || '🎙' });
      if (!r) { c.send({ type: 'error', message: 'Max rooms reached' }); break; }
      pushRooms(); c.send({ type: 'room-created', roomId: r.id }); break;
    }
    case 'delete-room': {
      const r = rooms.get(m.roomId);
      if (!r || r.isDefault || r.ownerId !== c.userId) break;
      for (const [, u] of r.users) { u.send({ type: 'room-left', reason: 'Room deleted' }); u.currentRoomId = null; }
      rooms.delete(m.roomId); pushRooms(); break;
    }
    case 'edit-room': {
      const r = rooms.get(m.roomId);
      if (!r || r.ownerId !== c.userId) break;
      if (m.name) r.name = m.name.trim().slice(0, 48);
      if (m.description !== undefined) r.description = (m.description || '').slice(0, 200);
      if (m.icon) r.icon = m.icon;
      if (m.password !== undefined) r.password = m.password || null;
      if (m.capacity) r.capacity = Math.min(Math.max(2, m.capacity), CONFIG.maxCapacity);
      pushRooms(); r.broadcast({ type: 'room-edited', room: r.toJSON(false) }); break;
    }
    case 'join-room': {
      const r = rooms.get(m.roomId);
      if (!r) { c.send({ type: 'error', message: 'Room not found' }); break; }
      if (r.password && m.password !== r.password) { c.send({ type: 'error', code: 'WRONG_PASSWORD', message: 'Wrong password' }); break; }
      if (r.size >= r.capacity) { c.send({ type: 'error', code: 'ROOM_FULL', message: 'Room is full' }); break; }
      if (c.currentRoomId) { const old = rooms.get(c.currentRoomId); if (old) { old.remove(c.userId); old.broadcast({ type: 'user-left', userId: c.userId }); cleanup(old); } }
      r.add(c);
      const others = [...r.users.values()].filter(u => u.userId !== c.userId).map(u => ({ id: u.userId, displayName: u.displayName, audioSettings: u.audioSettings, connQuality: u.connQuality, isMutedByAdmin: u.isMutedByAdmin }));
      c.send({ type: 'room-joined', roomId: r.id, roomName: r.name, roomIcon: r.icon, roomDescription: r.description, ownerId: r.ownerId, capacity: r.capacity, users: others, chatHistory: r.chat.slice(-50), audioSettings: c.audioSettings });
      r.broadcast({ type: 'user-joined', userId: c.userId, displayName: c.displayName, audioSettings: c.audioSettings, connQuality: c.connQuality }, c.userId);
      pushRooms(); break;
    }
    case 'leave-room': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId);
      if (r) { r.remove(c.userId); r.broadcast({ type: 'user-left', userId: c.userId }); cleanup(r); }
      c.currentRoomId = null; pushRooms(); c.send({ type: 'room-left' }); break;
    }
    case 'chat-message': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId);
      if (!r) break;
      const t = (m.text || '').trim();
      if (!t) break;
      const cm = r.addChat(c.userId, c.displayName, t);
      r.broadcast({ type: 'chat-message', ...cm }); break;
    }
    case 'update-audio-settings': {
      if (!m.settings) break;
      const s = m.settings;
      if (s.sendBitrate !== undefined) c.audioSettings.sendBitrate = Math.max(6, Math.min(510, +s.sendBitrate || 128));
      if (s.sampleRate !== undefined) c.audioSettings.sampleRate = [8000,12000,16000,24000,48000].includes(s.sampleRate) ? s.sampleRate : 48000;
      if (s.channelCount !== undefined) c.audioSettings.channelCount = s.channelCount === 1 ? 1 : 2;
      ['echoCancellation','noiseSuppression','autoGainControl','dtx','fec'].forEach(k => { if (s[k] !== undefined) c.audioSettings[k] = !!s[k]; });
      if (s.noiseGateThreshold !== undefined) c.audioSettings.noiseGateThreshold = Math.max(-80, Math.min(-10, +s.noiseGateThreshold || -50));
      if (s.packetLoss !== undefined) c.audioSettings.packetLoss = Math.max(0, Math.min(30, +s.packetLoss || 0));
      if (s.jitterBuffer !== undefined) c.audioSettings.jitterBuffer = ['adaptive','fixed-low','fixed-medium','fixed-high'].includes(s.jitterBuffer) ? s.jitterBuffer : 'adaptive';
      if (c.currentRoomId) { const r = rooms.get(c.currentRoomId); if (r) r.broadcast({ type: 'user-audio-settings-changed', userId: c.userId, audioSettings: c.audioSettings }); }
      break;
    }
    case 'request-bitrate': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId); if (!r) break;
      const t = r.users.get(m.targetUserId);
      if (t) t.send({ type: 'bitrate-request', fromUserId: c.userId, requestedBitrate: Math.max(6, Math.min(510, +m.bitrate || 128)) });
      break;
    }
    case 'offer': case 'answer': case 'ice-candidate': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId); if (!r) break;
      const t = r.users.get(m.targetUserId);
      if (t) t.send({ type: m.type, fromUserId: c.userId, payload: m.payload });
      break;
    }
    case 'speaking': {
      if (!c.currentRoomId) break;
      const now = Date.now();
      if (now - c.lastSpeak < CONFIG.speakThrottleMs) break;
      c.lastSpeak = now;
      const r = rooms.get(c.currentRoomId);
      if (r) r.broadcast({ type: 'user-speaking', userId: c.userId, speaking: !!m.speaking, level: Math.max(0, Math.min(100, +m.level || 0)) }, c.userId);
      break;
    }
    case 'connection-quality': {
      c.connQuality = { rtt: Math.max(0, +m.rtt || 0), jitter: Math.max(0, +m.jitter || 0), packetLoss: Math.max(0, Math.min(100, +m.packetLoss || 0)) };
      if (c.currentRoomId) { const r = rooms.get(c.currentRoomId); if (r) r.broadcast({ type: 'user-connection-quality', userId: c.userId, connQuality: c.connQuality }, c.userId); }
      break;
    }
    case 'admin-mute': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId);
      if (!r || r.ownerId !== c.userId) break;
      const t = r.users.get(m.targetUserId);
      if (t) { t.isMutedByAdmin = !t.isMutedByAdmin; r.broadcast({ type: 'user-admin-muted', userId: m.targetUserId, muted: t.isMutedByAdmin }); t.send({ type: 'you-were-muted', muted: t.isMutedByAdmin, by: c.displayName }); }
      break;
    }
    case 'admin-kick': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId);
      if (!r || r.ownerId !== c.userId) break;
      const t = r.users.get(m.targetUserId);
      if (t && t.userId !== c.userId) { t.send({ type: 'room-left', reason: `Kicked by ${c.displayName}` }); r.remove(t.userId); r.broadcast({ type: 'user-left', userId: t.userId, reason: 'kicked' }); pushRooms(); }
      break;
    }
    case 'admin-transfer': {
      if (!c.currentRoomId) break;
      const r = rooms.get(c.currentRoomId);
      if (!r || r.ownerId !== c.userId) break;
      if (r.users.has(m.targetUserId)) { r.ownerId = m.targetUserId; r.broadcast({ type: 'room-owner-changed', newOwnerId: r.ownerId }); pushRooms(); }
      break;
    }
  }
}

const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { const c = clients.get(ws); if (c) disc(c); return ws.terminate(); }
    ws.isAlive = false; ws.ping();
  });
}, CONFIG.heartbeatMs);
wss.on('close', () => clearInterval(hb));

app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', uptime: Math.round(process.uptime()), rooms: rooms.size, connections: wss.clients.size, memMB: Math.round(process.memoryUsage().heapUsed / 1048576) }));
app.get('/api/rooms', (_, res) => res.json(roomList()));
app.get('/api/stats', (_, res) => { let u = 0; rooms.forEach(r => u += r.size); res.json({ rooms: rooms.size, connections: wss.clients.size, usersInRooms: u, uptime: Math.round(process.uptime()) }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  VoxLink v2.0.0 | port ${PORT} | ${rooms.size} rooms | heartbeat ${CONFIG.heartbeatMs}ms\n`);
});
