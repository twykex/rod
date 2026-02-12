const CONFIG = require('../config');

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

module.exports = ClientState;
