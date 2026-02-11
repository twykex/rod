# VoxLink v2.0 — High-Fidelity Voice Chat

A web-based voice platform built for maximum audio quality with granular per-user control. Cleaner, simpler, and more technically capable than Discord for voice.

## What's New in v2

### Server
- **Room passwords** — optional password protection per room
- **Admin system** — room creator can mute, kick, and transfer ownership
- **Text chat** — per-room message history (last 200 messages)
- **Room capacity** — configurable 2–50 users per room
- **4 default rooms** — General, Music Production, Gaming, Studio
- **Room customization** — icons, descriptions, passwords
- **Heartbeat** — automatic dead connection cleanup (30s ping/pong)
- **Rate limiting** — 30 messages/sec per client
- **Speaking throttle** — server-side 10 Hz broadcast cap
- **Connection quality relay** — users share RTT/loss data with peers
- **REST API** — `/api/health`, `/api/rooms`, `/api/stats`
- **Input validation** — all settings sanitized server-side

### Client
- **Device selection** — pick input/output audio devices
- **Per-user volume** — 0–200% volume slider per person
- **Per-user receive bitrate** — ask each peer for specific quality
- **Waveform visualizer** — real-time canvas waveform per user tile
- **Push-to-talk** — toggle PTT mode, hold Space to transmit
- **Keyboard shortcuts** — M=mute, D=deafen, S=settings, C=chat, Space=PTT, Esc=leave
- **Text chat panel** — slide-out room chat with history
- **Toast notifications** — join/leave/mute/error alerts
- **Connection quality dots** — green/yellow/red per user
- **Bandwidth estimation** — real-time upload/download display
- **Admin controls** — mute/kick buttons visible to room owner
- **Room owner crown** — visual indicator of who controls the room
- **5 presets** — Voice Chat, Music/HiFi, Low BW, Studio 510k, Podcast
- **Room creation modal** — name, description, icon, password, capacity
- **Password-protected rooms** — modal prompt on join

## Audio Quality Control

| Parameter | Range | Default |
|-----------|-------|---------|
| Send bitrate | 6 – 510 kbps | 128 kbps |
| Receive bitrate | 6 – 510 kbps (per-user) | Sender's rate |
| Sample rate | 8 – 48 kHz | 48 kHz |
| Channels | Mono / Stereo | Stereo |
| Volume per user | 0 – 200% | 100% |
| Noise gate | -80 to -10 dB | -50 dB |
| Echo cancellation | On/Off | On |
| Noise suppression | On/Off | On |
| Auto gain control | On/Off | On |
| DTX | On/Off | Off |
| FEC | On/Off | On |
| Packet loss comp | 0 – 30% | 0% |
| Jitter buffer | Adaptive / Fixed (3 levels) | Adaptive |

## Presets

| Preset | Bitrate | Rate | Ch | Processing | Use Case |
|--------|---------|------|----|------------|----------|
| Voice Chat | 64k | 48kHz | Mono | All ON | Everyday chat |
| Music/HiFi | 320k | 48kHz | Stereo | All OFF | Music listening |
| Low BW | 16k | 16kHz | Mono | All ON | Slow connections |
| Studio 510k | 510k | 48kHz | Stereo | All OFF | Lossless monitoring |
| Podcast | 192k | 48kHz | Mono | Echo+Noise ON | Recording/streaming |

## Architecture

```
Clients ←→ WebRTC P2P (UDP/DTLS audio) ←→ Clients
   ↕                                         ↕
   WebSocket ←→ Node.js Signal Server ←→ WebSocket
                  (rooms, chat, admin)
```

Audio is peer-to-peer. Server only does signaling + room state. Zero audio processing on server.

## Deploy

```bash
ssh root@your-debian-vps
# Upload voxlink/ folder
cd voxlink && chmod +x setup.sh && ./setup.sh
# Configure domain in /etc/caddy/Caddyfile
# systemctl restart caddy
```

Recommended VPS location: **Dallas, TX** or **Kansas City** for coast-to-coast < 50ms.

Minimum specs: 1 vCPU, 512MB RAM (server is very lightweight).

## Development

```bash
npm install
npm start
# http://localhost:3000
```

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status, uptime, memory |
| `GET /api/rooms` | List all rooms with user counts |
| `GET /api/stats` | Aggregate stats |

## Bandwidth Calculator

```
Upload   = sendBitrate × (peers in room - 1)
Download = Σ each peer's sendBitrate (or your requested receive rate)
```

5 users, all at 320k stereo: 1.28 Mbps up + 1.28 Mbps down.

## TURN Server (Optional)

For users behind strict NATs:

```bash
apt install coturn
# See setup.sh output for configuration steps
```

Then add TURN credentials to `rtcCfg` in `index.html`.

## File Structure

```
voxlink/
├── server.js        # v2 signaling server
├── package.json
├── setup.sh         # Debian auto-deploy
├── README.md
└── public/
    └── index.html   # Complete SPA frontend
```

## License

MIT
