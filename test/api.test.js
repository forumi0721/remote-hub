const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 테스트용 임시 config 경로 설정
const TEST_CONFIG_PATH = path.join(__dirname, 'test-config.json');
process.env.CONFIG_PATH = TEST_CONFIG_PATH;

const configManager = require('../src/config');
const apiRoutes = require('../src/routes/api');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

function setupTestApp() {
  if (!fs.existsSync(TEST_CONFIG_PATH)) configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));
  app.use('/api', apiRoutes);
  return app;
}

// 헬퍼: HTTP 요청 실행 (쿠키 포함 지원)
function makeRequest(server, options, body = null, cookies = '') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(cookies ? { 'Cookie': cookies } : {}),
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('1. Config Manager: 단위 테스트', async (t) => {
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  // 초기화 및 기본값 확인
  const cfg = configManager.readConfig();
  assert.equal(cfg.auth.enabled, false);
  assert.equal(Array.isArray(cfg.servers), true);
  assert.equal(cfg.servers.length, 0);

  // 서버 추가
  const created = configManager.addServer({
    name: '단위테스트 서버',
    host: '192.168.0.100',
    port: 5900,
    password: 'secret_password_123',
    description: '단위 테스트 설명'
  });
  assert.ok(created.id);
  assert.equal(created.name, '단위테스트 서버');

  // getSanitizedServers는 패스워드를 마스킹해야 함
  const sanitized = configManager.getSanitizedServers();
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].hasPassword, true);
  assert.equal(sanitized[0].password, undefined);

  // 서버 수정
  const updated = configManager.updateServer(created.id, {
    name: '수정된 서버',
    description: '수정된 설명'
  });
  assert.equal(updated.name, '수정된 서버');
  assert.equal(updated.password, 'secret_password_123'); // 비밀번호 유지

  // 서버 삭제
  const deleted = configManager.deleteServer(created.id);
  assert.equal(deleted, true);
  assert.equal(configManager.getSanitizedServers().length, 0);
});

test('2. REST API & 인증 플로우: 통합 테스트', async (t) => {
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  const app = setupTestApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  // A. 기본 상태 조회
  const res1 = await makeRequest(server, { path: '/api/status' });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.authEnabled, false);
  assert.equal(res1.body.isAuthenticated, false);

  // B. 서버 추가
  const addRes = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: '통합테스트 서버',
    host: '127.0.0.1',
    port: 5900,
    password: 'vnc_pass_abc'
  });
  assert.equal(addRes.status, 201);
  const serverId = addRes.body.id;
  assert.ok(serverId);

  // C. 서버 목록 조회 (비밀번호 노출 안 됨 확인)
  const listRes = await makeRequest(server, { path: '/api/servers' });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].hasPassword, true);
  assert.equal(listRes.body[0].password, undefined);

  // D. 서버 접속 정보 조회 (VNC 패스워드 반환 확인)
  const connRes = await makeRequest(server, { path: `/api/servers/${serverId}/connection` });
  assert.equal(connRes.status, 200);
  assert.equal(connRes.body.password, 'vnc_pass_abc');

  // E. 인증 활성화 (마스터 비밀번호 설정: master1234)
  const setAuthRes = await makeRequest(server, { path: '/api/auth/settings', method: 'PUT' }, {
    enabled: true,
    newPassword: 'master1234'
  });
  assert.equal(setAuthRes.status, 200);
  assert.equal(setAuthRes.body.authEnabled, true);

  // F. 인증되지 않은 세션에서 서버 목록 요청 시 401 차단 확인
  const unauthRes = await makeRequest(server, { path: '/api/servers' });
  assert.equal(unauthRes.status, 401);

  // G. 잘못된 마스터 비밀번호로 로그인 실패 확인
  const failLogin = await makeRequest(server, { path: '/api/auth/login', method: 'POST' }, {
    password: 'wrong_password'
  });
  assert.equal(failLogin.status, 401);

  // H. 올바른 마스터 비밀번호로 로그인 성공 및 쿠키 획득
  const loginRes = await makeRequest(server, { path: '/api/auth/login', method: 'POST' }, {
    password: 'master1234'
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.success);
  const sessionCookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0].split(';')[0] : '';
  assert.ok(sessionCookie.includes('connect.sid'));

  // I. 로그인된 쿠키로 서버 목록 요청 성공 확인
  const authedListRes = await makeRequest(server, { path: '/api/servers' }, null, sessionCookie);
  assert.equal(authedListRes.status, 200);
  assert.equal(authedListRes.body.length, 1);

  // J. 로그아웃 확인
  const logoutRes = await makeRequest(server, { path: '/api/auth/logout', method: 'POST' }, null, sessionCookie);
  assert.equal(logoutRes.status, 200);

  // K. 로그아웃 후 다시 접근 시 401 확인
  const afterLogoutRes = await makeRequest(server, { path: '/api/servers' }, null, sessionCookie);
  assert.equal(afterLogoutRes.status, 401);
});

test('3. WebSocket 프록시 & 인증 차단: 통합 테스트', async (t) => {
  const WebSocket = require('ws');
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  // 기본 서버 1개 추가
  configManager.addServer({
    name: 'WS 테스트 서버',
    host: '127.0.0.1',
    port: 5900
  });
  const servers = configManager.getSanitizedServers();
  const serverId = servers[0].id;

  const app = express();
  const sessionParser = session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false
  });
  app.use(sessionParser);
  app.use('/api', apiRoutes);

  const server = http.createServer(app);
  const wss = new WebSocket.Server({
    noServer: true,
    handleProtocols: (protocols) => protocols.has('binary') ? 'binary' : false
  });

  const { handleWsConnection } = require('../src/routes/proxy');
  wss.on('connection', (ws, req) => handleWsConnection(ws, req));

  server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
      const config = configManager.readConfig();
      if (config.auth.enabled) {
        if (!request.session || !request.session.authenticated) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  });

  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  const port = server.address().port;

  // A. 인증 비활성화 상태: WebSocket 정상 연결 (binary 서브프로토콜)
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=${serverId}`, ['binary']);
    ws.on('open', () => {
      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });

  // B. 존재하지 않는 serverId로 접속 시 에러 코드(1008)로 닫힘 확인
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=invalid-id`, ['binary']);
    ws.on('close', (code) => {
      assert.equal(code, 1008);
      resolve();
    });
  });

  // C. 인증 활성화 시 미인증 클라이언트 WebSocket 핸드셰이크 거부(401) 확인
  configManager.writeConfig({
    auth: { enabled: true, passwordHash: 'dummy' },
    servers: [{ id: serverId, name: 'S', host: '127.0.0.1', port: 5900 }]
  });

  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=${serverId}`, ['binary']);
    ws.on('error', (err) => {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected server response'));
      resolve();
    });
  });
});

test('4. VNC/RDP 프로토콜 기본값 호환성 및 서버 순서 변경(Reorder) 테스트', async (t) => {
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  const app = setupTestApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  // A. 프로토콜 생략 시 기본값 'vnc' 적용 확인 (하위 호환성)
  const vncServer = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: '기존 스타일 VNC 서버',
    host: '10.0.0.1',
    port: 5900
  });
  assert.equal(vncServer.status, 201);
  assert.equal(vncServer.body.protocol, 'vnc');
  assert.equal(vncServer.body.port, 5900);

  // B. RDP 서버 등록 확인 (기본 포트 3389, username, domain)
  const rdpServer = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: '신규 RDP 서버',
    protocol: 'rdp',
    host: '10.0.0.2',
    username: 'Administrator',
    domain: 'WORKGROUP',
    password: 'windows_secret'
  });
  assert.equal(rdpServer.status, 201);
  assert.equal(rdpServer.body.protocol, 'rdp');
  assert.equal(rdpServer.body.port, 3389);
  assert.equal(rdpServer.body.username, 'Administrator');
  assert.equal(rdpServer.body.domain, 'WORKGROUP');

  // C. 세 번째 서버 추가
  const thirdServer = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: '세 번째 VNC 서버',
    host: '10.0.0.3'
  });
  assert.equal(thirdServer.status, 201);

  // D. 서버 목록 조회 및 순서 확인
  const listBefore = await makeRequest(server, { path: '/api/servers' });
  assert.equal(listBefore.status, 200);
  assert.equal(listBefore.body.length, 3);
  assert.equal(listBefore.body[0].id, vncServer.body.id);
  assert.equal(listBefore.body[1].id, rdpServer.body.id);
  assert.equal(listBefore.body[2].id, thirdServer.body.id);

  // E. 순서 변경 요청 (thirdServer -> rdpServer -> vncServer)
  const reorderedIds = [thirdServer.body.id, rdpServer.body.id, vncServer.body.id];
  const reorderRes = await makeRequest(server, { path: '/api/servers/reorder', method: 'PUT' }, {
    serverIds: reorderedIds
  });
  assert.equal(reorderRes.status, 200);
  assert.equal(reorderRes.body.length, 3);
  assert.equal(reorderRes.body[0].id, thirdServer.body.id);
  assert.equal(reorderRes.body[1].id, rdpServer.body.id);
  assert.equal(reorderRes.body[2].id, vncServer.body.id);

  // F. 변경된 순서가 영속적으로 유지되는지 GET으로 재확인
  const listAfter = await makeRequest(server, { path: '/api/servers' });
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body[0].id, thirdServer.body.id);
  assert.equal(listAfter.body[1].id, rdpServer.body.id);
  assert.equal(listAfter.body[2].id, vncServer.body.id);

  // G. RDP 서버 상세/접속 정보 조회 시 username, domain, protocol 정상 반환 확인
  const rdpConn = await makeRequest(server, { path: `/api/servers/${rdpServer.body.id}/connection` });
  assert.equal(rdpConn.status, 200);
  assert.equal(rdpConn.body.protocol, 'rdp');
  assert.equal(rdpConn.body.username, 'Administrator');
  assert.equal(rdpConn.body.domain, 'WORKGROUP');
  assert.equal(rdpConn.body.password, 'windows_secret');
});

test('5. SSH 터미널 서버 등록, Key 인증, 시작 명령(initialCommand) 검증 테스트', async (t) => {
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  const app = setupTestApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  // A. SSH 개인키 인증 및 tmux 시작 명령 서버 등록
  const sshServer = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: 'Linux 배포 서버 (SSH Key)',
    protocol: 'ssh',
    host: '10.0.0.50',
    port: 2222,
    username: 'ubuntu',
    authType: 'key',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK_KEY_DATA\n-----END OPENSSH PRIVATE KEY-----',
    passphrase: 'key_passphrase_xyz',
    initialCommand: 'tmux new -A -s remotehub',
    description: 'tmux 세션 자동 연결'
  });

  assert.equal(sshServer.status, 201);
  assert.equal(sshServer.body.protocol, 'ssh');
  assert.equal(sshServer.body.port, 2222);
  assert.equal(sshServer.body.username, 'ubuntu');
  assert.equal(sshServer.body.authType, 'key');
  assert.equal(sshServer.body.initialCommand, 'tmux new -A -s remotehub');

  // B. 목록 조회 시 개인키 내용 마스킹 확인 (hasPrivateKey = true, privateKey 노출 방지)
  const listRes = await makeRequest(server, { path: '/api/servers' });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  const item = listRes.body[0];
  assert.equal(item.protocol, 'ssh');
  assert.equal(item.hasPrivateKey, true);
  assert.equal(item.privateKey, undefined);
  assert.equal(item.initialCommand, 'tmux new -A -s remotehub');

  // C. 접속 상세 조회 시 접속에 필요한 Key 및 시작 명령 반환 확인
  const connRes = await makeRequest(server, { path: `/api/servers/${sshServer.body.id}/connection` });
  assert.equal(connRes.status, 200);
  assert.equal(connRes.body.authType, 'key');
  assert.equal(connRes.body.privateKey, undefined);
  assert.equal(connRes.body.passphrase, undefined);
  assert.equal(connRes.body.password, undefined);
  assert.equal(sshServer.body.privateKey, undefined);
  assert.equal(sshServer.body.passphrase, undefined);
  assert.equal(connRes.body.hasPrivateKey, true);
  assert.equal(connRes.body.initialCommand, 'tmux new -A -s remotehub');
});

test('6. 서버 그룹(Group) 및 태그(Tags) 등록, 수정, 목록 조회 테스트', async (t) => {
  configManager.writeConfig({ auth: { enabled: false, passwordHash: '' }, servers: [] });

  const app = setupTestApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  // A. 그룹 및 태그(쉼표 구분 문자열) 등록
  const createRes = await makeRequest(server, { path: '/api/servers', method: 'POST' }, {
    name: 'DB 운영 서버',
    protocol: 'ssh',
    host: '10.0.1.10',
    port: 22,
    username: 'root',
    group: '운영 (Production)',
    tags: 'linux, database, postgresql, #prod'
  });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.group, '운영 (Production)');
  assert.deepEqual(createRes.body.tags, ['linux', 'database', 'postgresql', 'prod']);

  // B. 목록 조회 시 group 및 tags 포함 확인
  const listRes = await makeRequest(server, { path: '/api/servers' });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].group, '운영 (Production)');
  assert.deepEqual(listRes.body[0].tags, ['linux', 'database', 'postgresql', 'prod']);

  // C. 서버 정보 수정 (배열 형태 태그 및 그룹 변경)
  const updateRes = await makeRequest(server, { path: `/api/servers/${createRes.body.id}`, method: 'PUT' }, {
    name: 'DB 운영 서버 (Master)',
    protocol: 'ssh',
    host: '10.0.1.10',
    port: 22,
    username: 'root',
    group: 'DB 클러스터',
    tags: ['db', 'master', 'ha']
  });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.group, 'DB 클러스터');
  assert.deepEqual(updateRes.body.tags, ['db', 'master', 'ha']);

  // D. 접속 상세 정보 조회 시 group 및 tags 확인
  const connRes = await makeRequest(server, { path: `/api/servers/${createRes.body.id}/connection` });
  assert.equal(connRes.status, 200);
  assert.equal(connRes.body.group, 'DB 클러스터');
  assert.deepEqual(connRes.body.tags, ['db', 'master', 'ha']);
});

test('7. SSH 영구 세션 조회(GET /api/sessions) 및 명시적 종료(DELETE /api/sessions/:key) 테스트', async (t) => {
  const { activeSshSessions } = require('../src/routes/ssh-proxy');
  const app = setupTestApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));

  t.after(() => {
    server.close();
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      try { fs.unlinkSync(TEST_CONFIG_PATH); } catch (_) {}
    }
  });

  const testKey = 'test_session_key_123';
  let destroyed = false;
  activeSshSessions.set(testKey, {
    key: testKey,
    server: { id: 'srv-test', name: 'Mock Server' },
    createdAt: Date.now(),
    attachedWs: null,
    lastCols: 80,
    lastRows: 24,
    destroy: () => {
      destroyed = true;
      activeSshSessions.delete(testKey);
    }
  });

  // A. 세션 목록 조회 확인
  const listRes = await makeRequest(server, { path: '/api/sessions' });
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.sessions.some(s => s.key === testKey));

  // B. 세션 삭제(DELETE) 요청 확인
  const delRes = await makeRequest(server, { path: `/api/sessions/${testKey}`, method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.success, true);
  assert.equal(destroyed, true);
  assert.equal(activeSshSessions.has(testKey), false);
});




