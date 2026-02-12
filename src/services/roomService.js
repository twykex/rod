const { v4: uuidv4 } = require('uuid');
const { rooms } = require('../state');
const Room = require('../models/Room');
const CONFIG = require('../config');

function makeRoom(name, opts = {}) {
  if (rooms.size >= CONFIG.maxRooms) return null;
  let baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48) || uuidv4().slice(0, 8);
  let id = baseId;
  while (rooms.has(id)) {
    id = baseId + '-' + uuidv4().slice(0, 4);
  }
  const r = new Room(id, name || id, opts);
  rooms.set(id, r); return r;
}

function roomList() { return [...rooms.values()].map(r => r.toJSON(true)); }

function cleanup(r) { if (r.size === 0 && !r.isDefault) rooms.delete(r.id); }

function initDefaultRooms() {
  [{ n: 'General', i: '💬', d: 'Hang out and chat' },
   { n: 'Music Production', i: '🎵', d: 'Hi-fi audio for producers' },
   { n: 'Gaming', i: '🎮', d: 'Low-latency game chat' },
   { n: 'Studio', i: '🎛', d: 'Lossless studio monitoring' }
  ].forEach(x => { const r = makeRoom(x.n, { isDefault: true, description: x.d, icon: x.i }); if (r) CONFIG.defaultRoomIds.push(r.id); });
}

module.exports = { makeRoom, roomList, cleanup, initDefaultRooms };
