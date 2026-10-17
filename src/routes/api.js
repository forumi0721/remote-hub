const express = require('express');
const router = express.Router();
const net = require('net');
const bcrypt = require('bcryptjs');
const configManager = require('../config');
const { closeConnections, closeOtherConnections } = require('../connections');

// 인증 확인 미들웨어
function requireAuth(req, res, next) {
  const config = configManager.readConfig();
  if (!config.auth.enabled) {
    return next();
  }
  if (req.session && req.session.authenticated && req.session.authVersion === config.auth.passwordHash) {
    return next();
  }
  return res.status(401).json({ error: '인증이 필요합니다. 먼저 로그인해 주세요.' });
}

router.use((req, res, next) => {
  if (['POST', 'PUT'].includes(req.method) && req.path !== '/auth/logout' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'JSON 객체가 필요합니다.' });
  next();
});

// 1. 서비스 상태 및 인증 요구 여부
router.get('/status', (req, res) => {
  const config = configManager.readConfig();
  res.json({
    authEnabled: Boolean(config.auth.enabled),
    isAuthenticated: Boolean(req.session && req.session.authenticated && req.session.authVersion === config.auth.passwordHash),
    configPath: configManager.getConfigPath()
  });
});

const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const loginCleanup = setInterval(() => {
  for (const [key, value] of loginAttempts) if (value.until <= Date.now()) loginAttempts.delete(key);
}, 60000);
loginCleanup.unref();
function limitLogin(req, res, next) {
  const key = req.ip;
  let entry = loginAttempts.get(key);
  if (!entry || entry.until <= Date.now()) { entry = { count: 0, until: Date.now() + loginWindowMs }; loginAttempts.set(key, entry); }
  if (entry.count >= 10) { res.set('Retry-After', String(Math.ceil((entry.until - Date.now()) / 1000))); return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' }); }
  entry.count++;
  next();
}

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
function sanitizedServer(server) {
  const { password, privateKey, passphrase, sshHostKeyFingerprint, rdpCertificateFingerprint, ...safe } = server;
  return { ...safe, hasPassword: Boolean(password), hasPrivateKey: Boolean(privateKey) };
}

// 2. 로그인
router.post('/auth/login', limitLogin, (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string') return res.status(400).json({ error: '비밀번호는 문자열이어야 합니다.' });
  const config = configManager.readConfig();

  if (!config.auth.enabled) {
    req.session.authenticated = true;
    return res.json({ success: true, message: '로그인 기능이 비활성화되어 있습니다.' });
  }

  if (!password || !config.auth.passwordHash) {
    return res.status(400).json({ error: '비밀번호를 입력해 주세요.' });
  }

  const isValid = bcrypt.compareSync(password, config.auth.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }

  loginAttempts.delete(req.ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: '로그인 실패' });
    req.session.authenticated = true;
    req.session.authVersion = config.auth.passwordHash;
    res.json({ success: true, message: '로그인되었습니다.' });
  });
});

// 3. 로그아웃
router.post('/auth/logout', (req, res) => {
  const sessionId = req.sessionID;
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: '로그아웃 실패' });
    }
    closeConnections(sessionId);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// 4. 인증 설정 변경 (보호 활성화/비활성화 및 마스터 비밀번호 설정)
router.put('/auth/settings', (req, res) => {
  const { enabled, currentPassword, newPassword } = req.body;
  const config = configManager.readConfig();
  if (typeof enabled !== 'boolean' || [currentPassword, newPassword].some(v => v !== undefined && typeof v !== 'string')) return res.status(400).json({ error: '인증 설정 형식이 올바르지 않습니다.' });

  // 기존에 로그인이 켜져 있었고 현재 세션이 인증되지 않은 경우
  if (config.auth.enabled && (!req.session || !req.session.authenticated || req.session.authVersion !== config.auth.passwordHash)) {
    return res.status(401).json({ error: '설정 변경을 위해 먼저 로그인해야 합니다.' });
  }

  // 기존 비밀번호가 설정되어 있는 상태에서 변경하려는 경우 현재 비밀번호 확인
  if (config.auth.enabled && config.auth.passwordHash) {
    if (!bcrypt.compareSync(currentPassword || '', config.auth.passwordHash)) {
      return res.status(400).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
    }
  }

  if (enabled === true) {
    if (newPassword) {
      const salt = bcrypt.genSaltSync(10);
      config.auth.passwordHash = bcrypt.hashSync(newPassword, salt);
    } else if (!config.auth.passwordHash) {
      return res.status(400).json({ error: '로그인을 활성화하려면 새 마스터 비밀번호를 입력해야 합니다.' });
    }
    config.auth.enabled = true;
    req.session.authenticated = true; // 현재 세션 유지
  } else if (enabled === false) {
    config.auth.enabled = false;
  }

  configManager.writeConfig(config);
  if (enabled) { req.session.authVersion = config.auth.passwordHash; closeOtherConnections(req.sessionID); }
  res.json({
    success: true,
    authEnabled: config.auth.enabled,
    message: '인증 설정이 저장되었습니다.'
  });
});

// 5. 서버 목록 조회
router.get('/servers', requireAuth, (req, res) => {
  const servers = configManager.getSanitizedServers();
  res.json(servers);
});

// 6. 접속 정보 조회: SSH 인증 정보는 백엔드에서만 사용
router.get('/servers/:id/connection', requireAuth, (req, res) => {
  const server = configManager.getServer(req.params.id);
  if (!server) {
    return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  }
  res.json({
    id: server.id,
    name: server.name,
    protocol: server.protocol || 'vnc',
    group: server.group || '',
    tags: server.tags || [],
    host: server.host,
    port: server.port,
    username: server.username || '',
    domain: server.domain || '',
    authType: server.authType || 'password',
    initialCommand: server.initialCommand || '',
    hasPassword: Boolean(server.password && server.password.length > 0),
    hasPrivateKey: Boolean(server.privateKey && server.privateKey.length > 0),
    ...(server.protocol !== 'ssh' ? { password: server.password || '' } : {}),
    description: server.description
  });
});

// 7. 서버 출력 순서 변경 (반드시 :id 라우트보다 위에 위치해야 함)
router.put('/servers/reorder', requireAuth, (req, res) => {
  const { serverIds } = req.body;
  if (!Array.isArray(serverIds)) {
    return res.status(400).json({ error: 'serverIds 배열이 필요합니다.' });
  }

  try {
    const updatedServers = configManager.reorderServers(serverIds);
    res.json(updatedServers);
  } catch (err) {
    res.status(500).json({ error: '서버 순서 변경 실패: ' + err.message });
  }
});

router.use('/servers', (req, res, next) => {
  if (req.method === 'POST' || (req.method === 'PUT' && req.path !== '/reorder')) {
    try { configManager.validateServerData(req.body, req.method === 'POST'); } catch (err) { return next(err); }
  }
  next();
});

// 8. 신규 서버 등록
router.post('/servers', requireAuth, (req, res) => {
  const {
    name, protocol, group, tags, host, port, username, domain,
    authType, password, privateKey, passphrase, initialCommand, description
  } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: '서버 이름과 호스트 주소(IP 또는 도메인)는 필수입니다.' });
  }

  try {
    const created = configManager.addServer({
      name,
      protocol,
      group,
      tags,
      host,
      port,
      username,
      domain,
      authType,
      password: password || '',
      privateKey: privateKey || '',
      passphrase: passphrase || '',
      initialCommand: initialCommand || '',
      description: description || ''
    });
    res.status(201).json(sanitizedServer(created));
  } catch (err) {
    res.status(err.status || 500).json({ error: '서버 추가 실패: ' + err.message });
  }
});

// 9. 서버 수정
router.put('/servers/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const {
    name, protocol, group, tags, host, port, username, domain,
    authType, password, privateKey, passphrase, initialCommand, description
  } = req.body;

  const updated = configManager.updateServer(id, {
    name,
    protocol,
    group,
    tags,
    host,
    port,
    username,
    domain,
    authType,
    password,
    privateKey,
    passphrase,
    initialCommand,
    description
  });

  if (!updated) {
    return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  }

  res.json(sanitizedServer(updated));
});

// 10. 서버 삭제
router.delete('/servers/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const deleted = configManager.deleteServer(id);
  if (!deleted) {
    return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  }
  const { activeSshSessions } = require('./ssh-proxy');
  for (const session of activeSshSessions.values()) if (session.server.id === id) session.destroy();
  res.json({ success: true, message: '서버가 삭제되었습니다.' });
});

// 10. 대상 VNC 포트 TCP 핑 테스트 (헬스 체크)
router.get('/servers/:id/ping', requireAuth, (req, res) => {
  const server = configManager.getServer(req.params.id);
  if (!server) {
    return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  }

  const startTime = Date.now();
  const socket = new net.Socket();
  socket.setTimeout(2000); // 2초 타임아웃

  let responded = false;
  const finish = (online, error = null) => {
    if (responded) return;
    responded = true;
    socket.destroy();
    res.json({
      serverId: server.id,
      online,
      latency: online ? Date.now() - startTime : null,
      error
    });
  };

  socket.connect(server.port, server.host, () => {
    finish(true);
  });

  socket.on('error', (err) => {
    finish(false, err.message);
  });

  socket.on('timeout', () => {
    finish(false, 'Connection timed out (2000ms)');
  });
});

// 12. 현재 실행 중인 백엔드 영구 세션 목록 조회
router.get('/sessions', requireAuth, (req, res) => {
  const { activeSshSessions } = require('./ssh-proxy');
  const sessionsList = [];
  if (activeSshSessions) {
    for (const [key, sess] of activeSshSessions.entries()) {
      sessionsList.push({
        key,
        serverId: sess.server.id,
        serverName: sess.server.name,
        attached: Boolean(sess.attachedWs && sess.attachedWs.readyState === 1),
        createdAt: sess.createdAt,
        lastCols: sess.lastCols,
        lastRows: sess.lastRows
      });
    }
  }
  res.json({
    total: sessionsList.length,
    sessions: sessionsList
  });
});

// 13. 백엔드 영구 세션 명시적 종료
router.delete('/sessions/:key', requireAuth, (req, res) => {
  const { activeSshSessions } = require('./ssh-proxy');
  const { key } = req.params;
  if (activeSshSessions && activeSshSessions.has(key)) {
    const session = activeSshSessions.get(key);
    session.destroy();
    return res.json({ success: true, message: '세션이 완전히 종료되었습니다.' });
  }
  res.json({ success: true, message: '이미 종료되었거나 존재하지 않는 세션입니다.' });
});

router.use((err, req, res, next) => {
  console.error('[API]', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : '요청 처리에 실패했습니다.' });
});

module.exports = router;
