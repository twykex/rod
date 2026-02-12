const { clients } = require('../state');
const { roomList } = require('./roomService');

function pushRooms() {
  const p = JSON.stringify({ type: 'room-list', rooms: roomList() });
  for (const [ws] of clients) { if (ws.readyState === 1) ws.send(p); }
}

module.exports = { pushRooms };
