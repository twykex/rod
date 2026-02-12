const CONFIG = {
  maxRooms: 100, defaultCapacity: 25, maxCapacity: 50,
  chatHistorySize: 200, maxMsgLen: 2000, maxNameLen: 32,
  heartbeatMs: 30000, rateLimit: { window: 1000, max: 30 },
  speakThrottleMs: 100, defaultRoomIds: []
};

module.exports = CONFIG;
