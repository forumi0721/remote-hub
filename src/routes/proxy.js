const net = require('net');
const configManager = require('../config');

function handleWsConnection(ws, req, serverOverride) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const serverId = parsedUrl.searchParams.get('serverId');

  if (!serverId && !serverOverride) {
    console.warn('[Proxy] WebSocket connection rejected: missing serverId parameter');
    ws.close(1008, 'Missing serverId parameter');
    return;
  }

  const server = serverOverride || configManager.getServer(serverId);
  if (!server) {
    console.warn(`[Proxy] Server not found for ID: ${serverId}`);
    ws.close(1008, 'Server configuration not found');
    return;
  }

  console.log(`[Proxy] Connecting WebSocket to VNC target: ${server.name} (${server.host}:${server.port})`);

  // 대상 VNC TCP 소켓 연결
  const tcpSocket = new net.Socket();
  tcpSocket.setNoDelay(true);

  tcpSocket.connect(server.port, server.host, () => {
    console.log(`[Proxy] TCP connection established to ${server.host}:${server.port}`);
  });

  // 1. TCP -> WebSocket 바이너리 전송
  tcpSocket.on('data', (data) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data, { binary: true }, (err) => {
          if (err) {
            console.error('[Proxy] Error sending to WebSocket:', err.message);
            tcpSocket.destroy();
          }
        });
      }
    } catch (e) {
      console.error('[Proxy] Exception sending to WebSocket:', e.message);
      tcpSocket.destroy();
    }
  });

  // 2. WebSocket -> TCP 전송 (백프레셔 제어 포함)
  ws.on('message', (msg) => {
    try {
      const buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      const drained = tcpSocket.write(buffer);
      if (!drained && ws.pause) {
        ws.pause();
      }
    } catch (e) {
      console.error('[Proxy] Exception sending to TCP:', e.message);
      ws.close(1011, 'TCP write failed');
    }
  });

  tcpSocket.on('drain', () => {
    if (ws.resume) {
      ws.resume();
    }
  });

  // 에러 및 닫힘 이벤트 처리
  tcpSocket.on('error', (err) => {
    console.error(`[Proxy] TCP socket error for ${server.name}:`, err.message);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `VNC Connection Error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    console.log(`[Proxy] TCP socket closed for ${server.name}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'VNC Target disconnected');
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Proxy] WebSocket closed (${code}): ${reason || 'Normal'}`);
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    console.error('[Proxy] WebSocket error:', err.message);
    tcpSocket.destroy();
  });
}

module.exports = {
  handleWsConnection
};
