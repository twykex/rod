const { rooms } = require('../state');
const { makeRoom, cleanup } = require('../services/roomService');
const { pushRooms } = require('../services/broadcastService');
const CONFIG = require('../config');

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

module.exports = { handle };
