const fs = require('fs');
const path = require('path');

// Docker 기본 경로는 /conf.d/remotehub/config.json (기존 /conf.d/novnc-hub/config.json 하위 호환)
// 환경 변수 CONFIG_PATH가 주어지면 우선 사용
let defaultFallbackPath = '/conf.d/remotehub/config.json';
if (!process.env.CONFIG_PATH && fs.existsSync('/conf.d/novnc-hub/config.json') && !fs.existsSync('/conf.d/remotehub/config.json')) {
  defaultFallbackPath = '/conf.d/novnc-hub/config.json';
}
const DEFAULT_PATH = process.env.CONFIG_PATH || defaultFallbackPath;

function getConfigPath() {
  return DEFAULT_PATH;
}

const DEFAULT_CONFIG = {
  auth: {
    enabled: false,
    passwordHash: ''
  },
  servers: []
};

// 디렉터리 및 초기 파일 자동 생성
function ensureConfigExists() {
  const filePath = getConfigPath();
  const dirPath = path.dirname(filePath);

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      console.log(`[Config] Created default config at: ${filePath}`);
    }
  } catch (err) {
    console.error(`[Config] Error ensuring config file at ${filePath}:`, err.message);
    throw err;
  }
}

// 설정 읽기
function readConfig() {
  ensureConfigExists();
  const filePath = getConfigPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      auth: { ...DEFAULT_CONFIG.auth, ...(parsed.auth || {}) },
      servers: Array.isArray(parsed.servers) ? parsed.servers : []
    };
  } catch (err) {
    console.error(`[Config] Failed to read config from ${filePath}:`, err.message);
    return DEFAULT_CONFIG;
  }
}

// 설정 원자적(atomic) 저장
function writeConfig(config) {
  const filePath = getConfigPath();
  const dirPath = path.dirname(filePath);
  const tmpPath = path.join(dirPath, `.config.${Date.now()}.tmp`);

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    console.error(`[Config] Failed to save config to ${filePath}:`, err.message);
    throw err;
  }
}

function parseTags(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
  }
  return [];
}

// 서버 조회 (단일)
function getServer(id) {
  const config = readConfig();
  const server = config.servers.find(s => s.id === id);
  if (!server) return null;
  return {
    ...server,
    protocol: server.protocol || 'vnc',
    group: server.group ? server.group.trim() : '',
    tags: parseTags(server.tags),
    username: server.username || '',
    domain: server.domain || '',
    authType: server.authType || 'password',
    initialCommand: server.initialCommand || ''
  };
}

// 서버 목록 (UI 반환용 - 비밀번호 마스킹 및 평문 노출 방지)
function getSanitizedServers() {
  const config = readConfig();
  return config.servers.map(s => ({
    id: s.id,
    name: s.name,
    protocol: s.protocol || 'vnc',
    group: s.group ? s.group.trim() : '',
    tags: parseTags(s.tags),
    host: s.host,
    port: s.port,
    username: s.username || '',
    domain: s.domain || '',
    authType: s.authType || 'password',
    initialCommand: s.initialCommand || '',
    hasPassword: Boolean(s.password && s.password.length > 0),
    hasPrivateKey: Boolean(s.privateKey && s.privateKey.length > 0),
    description: s.description || '',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }));
}

function getDefaultPort(protocol) {
  if (protocol === 'ssh') return 22;
  if (protocol === 'rdp') return 3389;
  return 5900;
}

// 서버 추가
function addServer(serverData) {
  const config = readConfig();
  const protocol = ['rdp', 'ssh'].includes(serverData.protocol) ? serverData.protocol : 'vnc';
  const defaultPort = getDefaultPort(protocol);

  const newServer = {
    id: 'srv-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
    name: serverData.name.trim(),
    protocol,
    group: serverData.group ? serverData.group.trim() : '',
    tags: parseTags(serverData.tags),
    host: serverData.host.trim(),
    port: parseInt(serverData.port, 10) || defaultPort,
    username: serverData.username ? serverData.username.trim() : (protocol === 'ssh' ? 'root' : ''),
    domain: serverData.domain ? serverData.domain.trim() : '',
    authType: serverData.authType === 'key' ? 'key' : 'password',
    password: serverData.password || '',
    privateKey: serverData.privateKey ? serverData.privateKey.trim() : '',
    passphrase: serverData.passphrase || '',
    initialCommand: serverData.initialCommand ? serverData.initialCommand.trim() : '',
    description: serverData.description ? serverData.description.trim() : '',
    createdAt: new Date().toISOString()
  };

  config.servers.push(newServer);
  writeConfig(config);
  return newServer;
}

// 서버 수정
function updateServer(id, serverData) {
  const config = readConfig();
  const index = config.servers.findIndex(s => s.id === id);
  if (index === -1) {
    return null;
  }

  const existing = config.servers[index];
  const protocol = serverData.protocol !== undefined 
    ? (['rdp', 'ssh'].includes(serverData.protocol) ? serverData.protocol : 'vnc')
    : (existing.protocol || 'vnc');
  const defaultPort = getDefaultPort(protocol);

  const updated = {
    ...existing,
    name: serverData.name !== undefined ? serverData.name.trim() : existing.name,
    protocol,
    group: serverData.group !== undefined ? serverData.group.trim() : (existing.group || ''),
    tags: serverData.tags !== undefined ? parseTags(serverData.tags) : parseTags(existing.tags),
    host: serverData.host !== undefined ? serverData.host.trim() : existing.host,
    port: serverData.port !== undefined ? parseInt(serverData.port, 10) || defaultPort : existing.port,
    username: serverData.username !== undefined ? serverData.username.trim() : (existing.username || ''),
    domain: serverData.domain !== undefined ? serverData.domain.trim() : (existing.domain || ''),
    authType: serverData.authType !== undefined ? (serverData.authType === 'key' ? 'key' : 'password') : (existing.authType || 'password'),
    initialCommand: serverData.initialCommand !== undefined ? serverData.initialCommand.trim() : (existing.initialCommand || ''),
    description: serverData.description !== undefined ? serverData.description.trim() : existing.description,
    updatedAt: new Date().toISOString()
  };

  if (serverData.password !== undefined) {
    updated.password = serverData.password;
  }
  if (serverData.privateKey !== undefined) {
    updated.privateKey = serverData.privateKey.trim();
  }
  if (serverData.passphrase !== undefined) {
    updated.passphrase = serverData.passphrase;
  }

  config.servers[index] = updated;
  writeConfig(config);
  return updated;
}

// 서버 순서 재정렬
function reorderServers(serverIds) {
  if (!Array.isArray(serverIds)) {
    throw new Error('serverIds must be an array');
  }

  const config = readConfig();
  const serverMap = new Map(config.servers.map(s => [s.id, s]));

  const reordered = [];
  for (const id of serverIds) {
    if (serverMap.has(id)) {
      reordered.push(serverMap.get(id));
      serverMap.delete(id);
    }
  }

  // 전달받은 목록에 누락된 기존 서버가 있다면 뒤에 유지
  for (const remaining of serverMap.values()) {
    reordered.push(remaining);
  }

  config.servers = reordered;
  writeConfig(config);
  return getSanitizedServers();
}

// 서버 삭제
function deleteServer(id) {
  const config = readConfig();
  const prevLen = config.servers.length;
  config.servers = config.servers.filter(s => s.id !== id);
  if (config.servers.length !== prevLen) {
    writeConfig(config);
    return true;
  }
  return false;
}

module.exports = {
  getConfigPath,
  readConfig,
  writeConfig,
  getServer,
  getSanitizedServers,
  addServer,
  updateServer,
  reorderServers,
  deleteServer
};
