const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const configManager = require('./config');
const { trackConnection } = require('./connections');
const apiRoutes = require('./routes/api');
const { handleWsConnection } = require('./routes/proxy');
const { handleRdpConnection } = require('./routes/rdp-proxy');
const { handleSshConnection } = require('./routes/ssh-proxy');

const app = express();
const PORT = process.env.PORT || 8080;

// Keep the generated secret outside source control and stable across restarts.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(path.dirname(configManager.getConfigPath()), '.session-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try { fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  return fs.readFileSync(secretPath, 'utf8').trim();
}
configManager.readConfig();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// 세션 미들웨어 설정 (memorystore: 메모리 누수 방지 및 만료 세션 자동 정리)
const sessionParser = session({
  store: new MemoryStore({
    checkPeriod: 24 * 60 * 60 * 1000 // 24시간마다 만료 세션 정리
  }),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7일 유지
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionParser);

// 1. noVNC 라이브러리 정적 파일 서빙
app.use('/novnc', express.static(path.join(__dirname, '../node_modules/@novnc/novnc')));

// 2. ironrdp-wasm 라이브러리 정적 파일 서빙 (WASM MIME 헤더 명시)
app.use('/ironrdp', express.static(path.join(__dirname, '../node_modules/ironrdp-wasm'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
  }
}));

// 3. xterm.js 및 addon 정적 파일 서빙
app.use('/xterm', express.static(path.join(__dirname, '../node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, '../node_modules/@xterm/addon-fit')));

// 4. 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../public')));

// 5. API 라우트 등록
app.use('/api', apiRoutes);
app.use((err, req, res, next) => {
  console.error('[HTTP]', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

// HTTP 서버 생성
const server = http.createServer(app);

// WebSocket 서버 인스턴스 생성 (noServer 모드)
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    // noVNC는 기본적으로 'binary' 서브프로토콜을 요청함
    if (protocols.has('binary')) {
      return 'binary';
    }
    return false;
  }
});

wss.on('connection', (ws, request) => {
  const parsedUrl = new URL(request.url, 'http://localhost');
  const serverId = parsedUrl.searchParams.get('serverId');

  if (!serverId) {
    console.warn('[Proxy] WebSocket connection rejected: missing serverId parameter');
    ws.close(1008, 'Missing serverId parameter');
    return;
  }

  const targetServer = configManager.getServer(serverId);
  if (!targetServer) {
    console.warn(`[Proxy] Server not found for ID: ${serverId}`);
    ws.close(1008, 'Server configuration not found');
    return;
  }

  const protocol = targetServer.protocol || 'vnc';
  if (protocol === 'ssh') {
    handleSshConnection(ws, request, targetServer);
  } else if (protocol === 'rdp') {
    handleRdpConnection(ws, request, targetServer);
  } else {
    handleWsConnection(ws, request, targetServer);
  }
});

// HTTP Upgrade 이벤트 가로채기 (WebSocket 핸드셰이크)
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch (_) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  // 세션 파싱 후 인증 여부 확인
  sessionParser(request, {}, (err) => {
    try {
      if (err) throw err;
      const config = configManager.readConfig();
      if (config.auth.enabled) {
        if (!request.session || !request.session.authenticated || request.session.authVersion !== config.auth.passwordHash) {
          console.warn('[Proxy] WebSocket rejected: unauthenticated session');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        trackConnection(request.sessionID, ws);
        try { wss.emit('connection', ws, request); }
        catch (err) { console.error('[Proxy]', err.message); ws.close(1011, 'Connection failed'); }
      });
    } catch (err) {
      console.error('[Proxy]', err.message);
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }
  });
});

// 서버 실행
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`  RemoteHub Server is running!`);
  console.log(`  Listening on: http://0.0.0.0:${server.address().port}`);
  console.log(`  Config Path:  ${configManager.getConfigPath()}`);
  console.log(`=========================================`);
});
