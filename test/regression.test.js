const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');
const { Server: SshServer } = require('ssh2');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotehub-test-'));
process.env.CONFIG_PATH = path.join(dir, 'config.json');
const config = require('../src/config');
const { PersistentSshSession, activeSshSessions, handleSshConnection } = require('../src/routes/ssh-proxy');
const { performRDPHandshake } = require('../src/routes/rdp-proxy');
const emptyConfig = () => ({ auth: { enabled: false, passwordHash: '' }, servers: [] });
class MockWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.messages = []; }
  send(data) { this.messages.push(data); this.emit('sent', data); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
}
test.after(() => { for (const sess of activeSshSessions.values()) sess.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });

test('configuration corruption fails closed and preserves file', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, '{broken');
  assert.throws(() => config.readConfig(), { status: 503 });
  assert.throws(() => config.addServer({ name: 'test', host: 'localhost' }), { status: 503 });
  assert.equal(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'), '{broken');
  fs.unlinkSync(process.env.CONFIG_PATH);
  assert.throws(() => config.readConfig(), { status: 503 });
  assert.equal(fs.existsSync(process.env.CONFIG_PATH), false);
  config.writeConfig(emptyConfig());
});

test('server fields reject invalid types, whitespace and ports; trust pins persist', () => {
  config.writeConfig(emptyConfig());
  for (const invalid of [{ name: ' ' }, { host: ' ' }, { group: 1 }, { port: -1 }, { port: 65536 }, { port: '22garbage' }, { port: 1.5 }, { port: null }, { protocol: 'telnet' }, { tags: [1] }]) {
    assert.throws(() => config.addServer({ name: 'test', host: 'localhost', ...invalid }), { status: 400 });
  }
  const server = config.addServer({ name: 'SSH', host: 'localhost', protocol: 'ssh' });
  config.trustRemoteIdentity(server.id, 'sshHostKeyFingerprint', 'abc');
  assert.equal(config.getServer(server.id).sshHostKeyFingerprint, 'abc');
  assert.throws(() => config.trustRemoteIdentity(server.id, 'sshHostKeyFingerprint', 'changed'));
  config.updateServer(server.id, { host: '127.0.0.1' });
  assert.equal(config.getServer(server.id).sshHostKeyFingerprint, undefined);
});

test('cross-server attachment is rejected without touching original session', () => {
  const sess = new PersistentSshSession('key', { id: 'A' });
  sess.isReady = true; sess.sshStream = { destroyed: false };
  activeSshSessions.set('key', sess);
  const ws = new MockWs();
  handleSshConnection(ws, { url: '/ws?sessionKey=key' }, { id: 'B' });
  assert.equal(ws.code, 1008); assert.equal(sess.isDestroyed, false);
  sess.destroy();
});

test('WebSocket errors schedule retention cleanup; reattachment cancels it', async () => {
  const sess = new PersistentSshSession('retention', { id: 'A' });
  sess.retentionTimeoutMs = 30;
  activeSshSessions.set(sess.key, sess);
  const ws = new MockWs(); sess.attachedWs = ws; sess.bindWs(ws);
  ws.emit('error', new Error('test'));
  assert.ok(sess.disconnectTimer);
  const replacement = new MockWs(); sess.attach(replacement);
  assert.equal(sess.disconnectTimer, null);
  ws.emit('message', Buffer.from('{"type":"terminate"}'));
  assert.equal(sess.isDestroyed, false);
  replacement.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(sess.isDestroyed, true);
});

test('real SSH shell preserves split UTF-8, replays and terminates', async t => {
  config.writeConfig(emptyConfig());
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  let shell;
  const sshServer = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', accept => {
      const channel = accept(); channel.on('pty', accept => accept());
      channel.on('window-change', accept => { if (accept) accept(); });
      channel.on('shell', accept => { shell = accept(); shell.on('data', data => shell.write(data)); const bytes = Buffer.from('한글'); shell.write(bytes.subarray(0, 1)); setTimeout(() => shell.write(bytes.subarray(1)), 10); });
    }));
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
  t.after(() => sshServer.close());
  const target = config.addServer({ name: 'loopback', host: '127.0.0.1', protocol: 'ssh', port: sshServer.address().port, username: 'test', password: 'test' });
  const sess = new PersistentSshSession('real-ssh', target); activeSshSessions.set(sess.key, sess);
  t.after(() => sess.destroy());
  const ws = new MockWs(); sess.start(ws);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSH output timeout')), 5000);
    ws.on('sent', () => { if (ws.messages.join('').includes('한글')) { clearTimeout(timeout); resolve(); } });
  });
  assert.ok(!ws.messages.join('').includes('�'));
  assert.ok(config.getServer(target.id).sshHostKeyFingerprint);
  shell.write('\x1b['); shell.write('6n');
  await new Promise(resolve => setTimeout(resolve, 20));
  ws.close();
  const replacement = new MockWs(); sess.attach(replacement);
  assert.equal(replacement.messages[0], JSON.stringify({ type: 'replay-start' }));
  assert.ok(replacement.messages.join('').includes('한글'));
  assert.ok(!replacement.messages.join('').includes('\x1b[6n'));
  replacement.emit('message', Buffer.from('{"type":"terminate"}'));
  assert.equal(sess.isDestroyed, true);
});

test('RDP loopback X.224/TLS handshake pins certificate and clears idle timeout', async t => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const context = tls.createSecureContext({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) });
  const sockets = new Set();
  const targetServer = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write(Buffer.from([3, 0, 0, 4]), () => { const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context }); secure.on('error', () => {}); });
    });
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); targetServer.close(); });
  const target = config.addServer({ name: 'rdp', host: '127.0.0.1', protocol: 'rdp', port: targetServer.address().port });
  const result = await performRDPHandshake(target.host, target.port, Buffer.from([3, 0, 0, 4]), target.id);
  assert.equal(result.certChain.length, 1); assert.ok(config.getServer(target.id).rdpCertificateFingerprint);
  result.tlsSocket.destroy();
  const cfg = config.readConfig(); cfg.servers.find(s => s.id === target.id).rdpCertificateFingerprint = 'changed'; config.writeConfig(cfg);
  await assert.rejects(performRDPHandshake(target.host, target.port, Buffer.from([3, 0, 0, 4]), target.id), /identity changed/);
});

test('production HTTP/WS: secret generation, invalid inputs, redaction, deletion, auth and corruption', async t => {
  config.writeConfig(emptyConfig());
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '0', SESSION_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = ''; const timeout = setTimeout(() => reject(new Error('startup timeout: ' + out)), 5000);
    child.stdout.on('data', data => { out += data; const match = out.match(/Listening on: http:\/\/0\.0\.0\.0:(\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('server exited ' + code)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (url, method = 'GET', body, cookie) => {
    const response = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, body: await response.json() };
  };
  assert.ok(fs.readFileSync(path.join(dir, '.session-secret'), 'utf8').length >= 64);
  assert.equal(fs.statSync(path.join(dir, '.session-secret')).mode & 0o777, 0o600);
  for (const payload of [{ name: ' ', host: 'localhost' }, { name: 'test', host: 'localhost', port: -1 }, { name: 'test', host: 'localhost', privateKey: 1 }]) assert.equal((await request('/servers', 'POST', payload)).response.status, 400);
  const created = await request('/servers', 'POST', { name: 'SSH', host: 'localhost', protocol: 'ssh', password: 'secret', privateKey: 'key', passphrase: 'phrase' });
  assert.equal(created.response.status, 201); assert.equal(created.body.password, undefined); assert.equal(created.body.privateKey, undefined);
  const id = created.body.id;
  const connection = await request(`/servers/${id}/connection`); assert.equal(connection.body.password, undefined); assert.equal(connection.body.passphrase, undefined);
  assert.equal((await request(`/servers/${id}`, 'PUT', { group: null })).response.status, 400);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=${id}&sessionKey=delete-me`);
  await once(ws, 'open');
  await request(`/servers/${id}`, 'DELETE');
  assert.equal((await request('/sessions')).body.total, 0); ws.close();
  const enabled = await request('/auth/settings', 'PUT', { enabled: true, newPassword: 'test-password' });
  const cookie = enabled.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/servers')).response.status, 401);
  assert.equal((await request('/auth/settings', 'PUT', { enabled: false }, cookie)).response.status, 400);
  const remoteSockets = new Set();
  const tcpTarget = net.createServer(socket => { remoteSockets.add(socket); socket.on('close', () => remoteSockets.delete(socket)); });
  await new Promise(resolve => tcpTarget.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of remoteSockets) socket.destroy(); tcpTarget.close(); });
  const target = await request('/servers', 'POST', { name: 'auth transports', host: '127.0.0.1', protocol: 'vnc', port: tcpTarget.address().port }, cookie);
  assert.equal(target.response.status, 201);
  const login = await request('/auth/login', 'POST', { password: 'test-password' });
  const otherCookie = login.response.headers.get('set-cookie').split(';')[0];
  const openTransport = async sessionCookie => {
    const transport = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=${target.body.id}`, { headers: { Cookie: sessionCookie } });
    await once(transport, 'open');
    return transport;
  };
  const currentTransport = await openTransport(cookie);
  const otherTransport = await openTransport(otherCookie);
  const revoked = once(otherTransport, 'close');
  assert.equal((await request('/auth/settings', 'PUT', { enabled: true, currentPassword: 'test-password', newPassword: 'new-password' }, cookie)).response.status, 200);
  assert.equal((await revoked)[0], 1008);
  assert.equal((await request('/servers', 'GET', undefined, otherCookie)).response.status, 401);
  assert.equal(currentTransport.readyState, WebSocket.OPEN);
  const loggedOut = once(currentTransport, 'close');
  assert.equal((await request('/auth/logout', 'POST', {}, cookie)).response.status, 200);
  assert.equal((await loggedOut)[0], 1008);
  for (let i = 0; i < 10; i++) assert.equal((await request('/auth/login', 'POST', { password: 'wrong' })).response.status, 401);
  assert.equal((await request('/auth/login', 'POST', { password: 'wrong' })).response.status, 429);
  fs.writeFileSync(process.env.CONFIG_PATH, '{broken');
  assert.equal((await request('/servers')).response.status, 503);
  await new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=missing`);
    client.on('error', err => { try { assert.match(err.message, /503/); resolve(); } catch (e) { reject(e); } });
  });
  assert.equal(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'), '{broken');
});


test('RDCleanPath rejects malformed lengths, duplicate fields and trailing input', () => {
  const { parseRDCleanPathRequest } = require('../src/routes/rdp-proxy');
  const tlv = (tag, content) => Buffer.concat([Buffer.from([tag, content.length]), content]);
  const version = tlv(0xa0, tlv(2, Buffer.from([0x0d, 0x3e])));
  const destination = tlv(0xa2, tlv(0x0c, Buffer.from('localhost:3389')));
  const x224 = tlv(0xa6, tlv(4, Buffer.from([3, 0, 0, 4])));
  const valid = tlv(0x30, Buffer.concat([version, destination, x224]));
  assert.equal(parseRDCleanPathRequest(valid).destination, 'localhost:3389');
  for (const invalid of [Buffer.alloc(0), Buffer.from([0x30, 0x80]), Buffer.from([0x30, 0x84, 0xff, 0xff]), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]), tlv(0x30, Buffer.concat([version, version, destination, x224]))]) assert.throws(() => parseRDCleanPathRequest(invalid));
});

test('RDP handshake rejects malformed and prematurely closed TCP responses', { timeout: 3000 }, async t => {
  for (const response of [Buffer.from([1, 0, 0, 4]), Buffer.from([3, 0])]) {
    const target = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.end(response)); });
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    t.after(() => target.close());
    await assert.rejects(performRDPHandshake('127.0.0.1', target.address().port, Buffer.from([3, 0, 0, 4]), 'unused'), /Invalid X.224|closed/);
  }
});
