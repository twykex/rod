const { rooms, clients } = require('../state');
const { cleanup } = require('./roomService');
const { pushRooms } = require('./broadcastService');

function disc(c) {
  if (c.currentRoomId) {
    const r = rooms.get(c.currentRoomId);
    if (r) { r.remove(c.userId); r.broadcast({ type: 'user-left', userId: c.userId }); cleanup(r); }
  }
  clients.delete(c.ws); pushRooms();
}

module.exports = { disc };
