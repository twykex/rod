const express = require('express');
const { rooms, clients } = require('../state');
const { roomList } = require('../services/roomService');

const router = express.Router();

router.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', uptime: Math.round(process.uptime()), rooms: rooms.size, connections: clients.size, memMB: Math.round(process.memoryUsage().heapUsed / 1048576) }));
router.get('/rooms', (_, res) => res.json(roomList()));
router.get('/stats', (_, res) => { let u = 0; rooms.forEach(r => u += r.size); res.json({ rooms: rooms.size, connections: clients.size, usersInRooms: u, uptime: Math.round(process.uptime()) }); });

module.exports = router;
