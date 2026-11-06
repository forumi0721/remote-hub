'use strict';

const configManager = require('./config');

function createSshConnectConfig(server, logPrefix) {
  const connectConfig = {
    hostHash: 'sha256',
    hostVerifier: fingerprint => {
      try { return configManager.trustRemoteIdentity(server.id, 'sshHostKeyFingerprint', fingerprint); }
      catch (err) { console.error(`${logPrefix} Host verification failed:`, err.message); return false; }
    },
    host: server.host,
    port: server.port || 22,
    username: server.username || 'root',
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3
  };

  if (server.authType === 'key' && server.privateKey) {
    connectConfig.privateKey = server.privateKey;
    if (server.passphrase) {
      connectConfig.passphrase = server.passphrase;
    }
  } else if (server.password) {
    connectConfig.password = server.password;
  }

  return connectConfig;
}

module.exports = { createSshConnectConfig };
