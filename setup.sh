#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# VoxLink — Server Setup Script for Debian 12
# Run as root on a fresh Debian VPS (central US recommended)
# ═══════════════════════════════════════════════════════════════

set -e

echo "╔══════════════════════════════════════════╗"
echo "║      VoxLink Server Setup Script         ║"
echo "╚══════════════════════════════════════════╝"

# ─── System update ────────────────────────────────────────────
echo "[1/7] Updating system..."
apt update && apt upgrade -y

# ─── Install Node.js 20 LTS ──────────────────────────────────
echo "[2/7] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "    Node.js version: $(node -v)"
echo "    npm version: $(npm -v)"

# ─── Create app user ─────────────────────────────────────────
echo "[3/7] Creating voxlink user..."
if ! id "voxlink" &>/dev/null; then
    useradd -m -s /bin/bash voxlink
fi

# ─── Deploy app ───────────────────────────────────────────────
echo "[4/7] Deploying application..."
APP_DIR="/opt/voxlink"
mkdir -p $APP_DIR
cp -r ./* $APP_DIR/
cd $APP_DIR
npm install --production
chown -R voxlink:voxlink $APP_DIR

# ─── Install Caddy (reverse proxy + auto HTTPS) ──────────────
echo "[5/7] Installing Caddy for HTTPS..."
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

# ─── Create systemd service ──────────────────────────────────
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/voxlink.service << 'EOF'
[Unit]
Description=VoxLink Voice Chat Server
After=network.target

[Service]
Type=simple
User=voxlink
WorkingDirectory=/opt/voxlink
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

# Performance tuning
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable voxlink
systemctl start voxlink

# ─── Firewall ────────────────────────────────────────────────
echo "[7/7] Configuring firewall..."
apt install -y ufw
ufw allow ssh
ufw allow 80
ufw allow 443
# WebRTC UDP ports for TURN (if you add a TURN server later)
ufw allow 49152:65535/udp
ufw --force enable

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║             VoxLink Setup Complete!                  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  App running on port 3000                            ║"
echo "║                                                      ║"
echo "║  NEXT STEPS:                                         ║"
echo "║                                                      ║"
echo "║  1. Point your domain DNS to this server's IP        ║"
echo "║                                                      ║"
echo "║  2. Configure Caddy for HTTPS:                       ║"
echo "║     Edit /etc/caddy/Caddyfile:                       ║"
echo "║                                                      ║"
echo "║     yourdomain.com {                                 ║"
echo "║       reverse_proxy localhost:3000                    ║"
echo "║     }                                                ║"
echo "║                                                      ║"
echo "║     Then: systemctl restart caddy                    ║"
echo "║                                                      ║"
echo "║  3. (Optional) Add a TURN server for NAT traversal:  ║"
echo "║     apt install coturn                               ║"
echo "║     See README.md for TURN configuration             ║"
echo "║                                                      ║"
echo "║  Manage: systemctl {start|stop|restart} voxlink      ║"
echo "║  Logs:   journalctl -u voxlink -f                    ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
