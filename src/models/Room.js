const { v4: uuidv4 } = require('uuid');
const CONFIG = require('../config');

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

module.exports = Room;
