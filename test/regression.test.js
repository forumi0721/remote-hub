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

test('SFTP lists, transfers and manages files using the saved SSH server', async t => {
  const files = new Map([['/home/test/한글.txt', Buffer.from('data')]]);
  const folders = new Set(['/home/test']);
  const pathModule = require('node:path');
  const transferEvents = new EventEmitter();
  const express = require('express');
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const sshServer = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('sftp', acceptSftp => {
        const sftp = acceptSftp();
        sftp.on('REALPATH', id => sftp.name(id, [{ filename: '/home/test', attrs: {} }]));
        sftp.on('OPENDIR', (id, path) => sftp.handle(id, Buffer.from(path)));
        let listed = false;
        sftp.on('READDIR', (id, handle) => {
          if (listed) return sftp.status(id, 1);
          listed = true;
          const directory = handle.toString();
          const names = [...files.keys()].filter(path => pathModule.posix.dirname(path) === directory);
          if (!names.length) return sftp.status(id, 1);
          sftp.name(id, names.map(path => ({
            filename: pathModule.posix.basename(path),
            attrs: { mode: 0o100644, size: files.get(path).length, atime: 10, mtime: 10 }
          })));
        });
        sftp.on('STAT', (id, path) => {
          if (!files.has(path)) return sftp.status(id, 2);
          sftp.attrs(id, { mode: 0o100644, size: files.get(path).length });
        });
        sftp.on('LSTAT', (id, path) => {
          if (files.has(path)) sftp.attrs(id, { mode: 0o100644, size: files.get(path).length });
          else if (folders.has(path)) sftp.attrs(id, { mode: 0o40755 });
          else sftp.status(id, 2);
        });
        sftp.on('OPEN', (id, path, flags) => {
          if ((flags & 0x20) && files.has(path)) return sftp.status(id, 4);
          if (flags & 0x08) files.set(path, Buffer.alloc(0));
          if (!files.has(path)) return sftp.status(id, 2);
          sftp.handle(id, Buffer.from(path));
        });
        sftp.on('WRITE', (id, handle, offset, data) => {
          const path = handle.toString();
          const content = Buffer.alloc(Math.max(files.get(path).length, offset + data.length));
          files.get(path).copy(content);
          data.copy(content, offset);
          files.set(path, content);
          transferEvents.emit('write', path);
          sftp.status(id, 0);
        });
        sftp.on('READ', (id, handle, offset, length) => {
          const data = files.get(handle.toString()).subarray(offset, offset + length);
          if (data.length) sftp.data(id, data);
          else sftp.status(id, 1);
        });
        sftp.on('MKDIR', (id, path) => {
          folders.add(path);
          sftp.status(id, 0);
        });
        sftp.on('RENAME', (id, from, to) => {
          if (!files.has(from) || files.has(to) || folders.has(to)) return sftp.status(id, 4);
          files.set(to, files.get(from));
          files.delete(from);
          sftp.status(id, 0);
        });
        sftp.on('RMDIR', (id, path) => {
          if ([...files.keys()].some(file => file.startsWith(path + '/'))) return sftp.status(id, 4);
          folders.delete(path);
          sftp.status(id, 0);
        });
        sftp.on('REMOVE', (id, path) => {
          files.delete(path);
          sftp.status(id, 0);
          transferEvents.emit('remove', path);
        });
        sftp.on('CLOSE', id => sftp.status(id, 0));
      });
    }));
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
  t.after(() => sshServer.close());
  config.writeConfig(emptyConfig());
  const target = config.addServer({ name: 'SFTP test', host: '127.0.0.1', protocol: 'ssh', port: sshServer.address().port, username: 'test', password: 'test' });
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/routes/api'));
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => http.close());
  const url = `http://127.0.0.1:${http.address().port}/api/servers/${target.id}/files`;
  assert.equal((await fetch(url + '?path=a&path=b')).status, 400);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: '/home/test',
    entries: [{ name: '한글.txt', type: 'file', size: 4, modifiedAt: 10 }]
  });
  assert.ok(config.getServer(target.id).sshHostKeyFingerprint);
  const writeHeaders = { 'X-RemoteHub-File-Operation': '1' };
  const change = (body, headers = writeHeaders) => fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: '/home/test', ...body })
  });
  assert.equal((await change({ action: 'mkdir', name: '새 폴더' }, {})).status, 403);
  assert.equal((await change({ action: 'mkdir', name: '../escape' })).status, 400);
  assert.equal((await change({ action: 'mkdir', name: '새 폴더' })).status, 204);
  assert.ok(folders.has('/home/test/새 폴더'));

  const upload = (name, body) => fetch(url + '/upload?' + new URLSearchParams({ directory: '/home/test', name }), {
    method: 'PATCH',
    headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' },
    body
  });
  const bytes = Buffer.from([0, 255, 17, 42]);
  assert.equal((await upload('새 파일.bin', bytes)).status, 201);
  assert.equal((await upload('empty.txt', Buffer.alloc(0))).status, 201);
  assert.equal(files.get('/home/test/empty.txt').length, 0);
  assert.equal((await upload('새 파일.bin', Buffer.from('overwrite'))).status, 409);
  assert.deepEqual(files.get('/home/test/새 파일.bin'), bytes);
  assert.ok([...files.keys()].every(path => !path.includes('.remotehub-upload-')));
  assert.equal((await change({ action: 'rename', name: '새 파일.bin', newName: '이름.bin' })).status, 204);
  const download = await fetch(url + '/download?' + new URLSearchParams({ path: '/home/test/이름.bin' }));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.equal((await change({ action: 'delete', name: '이름.bin' }, {})).status, 403);
  assert.equal((await change({ action: 'delete', name: '이름.bin' })).status, 204);
  assert.ok(!files.has('/home/test/이름.bin'));
  const nested = '/home/test/새 폴더/보관.txt';
  files.set(nested, Buffer.from('keep'));
  assert.equal((await change({ action: 'delete', name: '새 폴더' })).status, 409);
  assert.ok(files.has(nested));
  files.delete(nested);
  assert.equal((await change({ action: 'delete', name: '새 폴더' })).status, 204);
  assert.ok(!folders.has('/home/test/새 폴더'));

  const canceledUpload = require('http').request(url + '/upload?' + new URLSearchParams({
    directory: '/home/test', name: 'canceled.bin'
  }), {
    method: 'PATCH',
    headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' }
  });
  canceledUpload.on('error', () => {});
  t.after(() => canceledUpload.destroy());
  const partialWrite = once(transferEvents, 'write', { signal: AbortSignal.timeout(5000) });
  canceledUpload.write(Buffer.alloc(4096));
  const [temporary] = await partialWrite;
  const cleanup = once(transferEvents, 'remove', { signal: AbortSignal.timeout(5000) });
  canceledUpload.destroy();
  assert.deepEqual(await cleanup, [temporary]);
  assert.ok(!files.has(temporary));
  assert.ok(!files.has('/home/test/canceled.bin'));


  const current = config.readConfig();
  config.writeConfig({ ...current, auth: { enabled: true, passwordHash: 'test' } });
  assert.equal((await fetch(url)).status, 401);
  config.writeConfig(current);

});
