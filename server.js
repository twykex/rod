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

const CONFIG = require('./src/config');
const { clients, rooms } = require('./src/state');
const ClientState = require('./src/models/ClientState');
const { roomList, initDefaultRooms } = require('./src/services/roomService');
const { disc } = require('./src/services/clientService');
const { handle } = require('./src/handlers/messageHandler');
const apiRoutes = require('./src/routes/api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Initialize default rooms
initDefaultRooms();

wss.on('connection', (ws) => {
  const c = new ClientState(ws, uuidv4());
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  c.send({ type: 'welcome', userId: c.userId, rooms: roomList(), serverTime: Date.now() });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!c.rateOk()) { c.send({ type: 'error', code: 'RATE_LIMIT', message: 'Slow down' }); return; }
    handle(c, m);
  });
  ws.on('close', () => disc(c));
  ws.on('error', () => disc(c));
});

const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { const c = clients.get(ws); if (c) disc(c); return ws.terminate(); }
    ws.isAlive = false; ws.ping();
  });
}, CONFIG.heartbeatMs);
wss.on('close', () => clearInterval(hb));

app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  VoxLink v2.0.0 | port ${PORT} | ${rooms.size} rooms | heartbeat ${CONFIG.heartbeatMs}ms\n`);
});
