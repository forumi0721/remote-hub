'use strict';

const { randomUUID } = require('crypto');
const { posix } = require('path');
const { pipeline, finished } = require('stream/promises');
const { Client } = require('ssh2');
const configManager = require('../config');
const { trackConnection } = require('../connections');
const { createSshConnectConfig } = require('../ssh-connect-config');

const MAX_UPLOAD_BYTES = 1024 ** 3;
const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (error, result) => error ? reject(error) : resolve(result));
});

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function remotePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) {
    throw fail(400, '유효한 원격 경로를 입력해 주세요.');
  }
  return value;
}

function childPath(directory, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name) || Buffer.byteLength(name) > 255) {
    throw fail(400, '유효한 파일 또는 폴더 이름을 입력해 주세요.');
  }
  // Keep remote symlink and parent-path resolution on the SSH server.
  return remotePath(directory.endsWith('/') ? directory + name : directory + '/' + name);
}

async function ensureAvailable(sftp, path) {
  try {
    await call(sftp, 'lstat', path);
  } catch (error) {
    if (error.code === 2) return;
    throw error;
  }
  throw fail(409, '같은 이름의 파일 또는 폴더가 이미 있습니다.');
}

function withSftp(operation, { write = false, transfer = false } = {}) {
  return async (req, res) => {
    if (write && req.get('X-RemoteHub-File-Operation') !== '1') {
      return res.status(403).json({ error: '허용되지 않은 파일 작업 요청입니다.' });
    }
    const server = configManager.getServer(req.params.id);
    if (server?.protocol !== 'ssh') return res.status(404).json({ error: 'SSH 서버를 찾을 수 없습니다.' });

    const client = new Client();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      abort();
      client.destroy();
      if (!res.headersSent && !res.destroyed) res.status(504).json({ error: 'SFTP 요청 시간이 초과되었습니다.' });
      else if (!res.writableEnded) res.destroy();
    }, transfer ? 15 * 60 * 1000 : 20000);
    res.once('close', abort);
    if (req.sessionID) trackConnection(req.sessionID, {
      once: res.once.bind(res),
      close: () => res.destroy(),
      terminate: () => res.destroy()
    });
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.on('error', () => { reject(fail(502, 'SSH 서버에 연결할 수 없습니다.')); abort(); });
        client.once('close', () => { reject(fail(502, 'SSH 연결이 종료되었습니다.')); abort(); });
        client.once('ready', () => client.sftp((error, channel) => {
          if (error) reject(fail(502, 'SSH 서버에서 SFTP를 열 수 없습니다.'));
          else {
            channel.on('error', abort);
            resolve(channel);
          }
        }));
        controller.signal.addEventListener('abort', () => reject(fail(502, 'SSH 연결이 종료되었습니다.')), { once: true });
        client.connect(createSshConnectConfig(server, '[SFTP]'));
      });
      controller.signal.throwIfAborted();
      await operation(sftp, req, res, controller.signal);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      const status = error.status || (error.code === 2 ? 404 : error.code === 3 ? 403 : 502);
      res.status(status).json({ error: error.status ? error.message : '원격 파일 작업에 실패했습니다. 경로와 권한을 확인해 주세요.' });
    } finally {
      clearTimeout(timer);
      res.removeListener('close', abort);
      client.destroy();
    }
  };
}

const listRemoteFiles = withSftp(async (sftp, req, res) => {
  const directory = await call(sftp, 'realpath', remotePath(req.query.path ?? '.'));
  const entries = await call(sftp, 'readdir', directory);
  res.json({
    path: directory,
    entries: entries.filter(({ filename }) => filename !== '.' && filename !== '..').map(({ filename, attrs }) => ({
      name: filename,
      type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : attrs.isFile() ? 'file' : 'other',
      size: attrs.size,
      modifiedAt: attrs.mtime,
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid
    }))
  });
});

const downloadRemoteFile = withSftp(async (sftp, req, res, signal) => {
  const file = remotePath(req.query.path);
  const attrs = await call(sftp, 'stat', file);
  if (!attrs.isFile()) throw fail(400, '일반 파일만 다운로드할 수 있습니다.');
  const size = attrs.size;
  if (!Number.isSafeInteger(size) || size < 0) throw fail(502, '원격 파일 크기를 확인할 수 없습니다.');
  const handle = await call(sftp, 'open', file, 'r');
  try {
    res.attachment(posix.basename(file).replace(/[\p{C}]/gu, '_'));
    res.type('application/octet-stream').set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length', String(size));
    if (size === 0) return res.end();
    await pipeline(sftp.createReadStream(file, { handle, autoClose: false, end: size - 1 }), async function* (source) {
      let received = 0;
      for await (const chunk of source) {
        received += chunk.length;
        yield chunk;
      }
      if (received !== size) throw new Error('Remote file size changed during download');
    }, res, { signal });
  } finally {
    await call(sftp, 'close', handle).catch(() => {});
  }
}, { transfer: true });

const uploadRemoteFile = withSftp(async (sftp, req, res, signal) => {
  if (!req.is('application/octet-stream')) throw fail(415, '파일 바이너리가 필요합니다.');
  const size = req.get('Content-Length');
  if (size === undefined) throw fail(411, '파일 크기가 필요합니다.');
  if (!/^\d+$/.test(size) || Number(size) > MAX_UPLOAD_BYTES) throw fail(413, '최대 업로드 크기는 1 GiB입니다.');
  const directory = remotePath(req.query.directory);
  const destination = childPath(directory, req.query.name);
  await ensureAvailable(sftp, destination);
  signal.throwIfAborted();
  const temporary = childPath(directory, `.remotehub-upload-${randomUUID()}`);
  const handle = await call(sftp, 'open', temporary, 'wx', { mode: 0o600 });
  const output = sftp.createWriteStream(temporary, { handle, autoClose: false });
  let open = true;
  let published = false;
  try {
    signal.throwIfAborted();
    const completion = finished(output, { signal, cleanup: true });
    req.pipe(output);
    await completion;
    if (output.bytesWritten !== Number(size)) throw fail(400, '업로드 크기가 요청과 일치하지 않습니다.');
    await call(sftp, 'close', handle);
    open = false;
    signal.throwIfAborted();
    await call(sftp, 'rename', temporary, destination);
    published = true;
    res.sendStatus(201);
  } finally {
    req.unpipe(output);
    if (!req.destroyed) req.resume();
    if (open) await call(sftp, 'close', handle).catch(() => {});
    if (!published) await call(sftp, 'unlink', temporary).catch(() => {});
  }
}, { write: true, transfer: true });

const changeRemoteFiles = withSftp(async (sftp, req, res) => {
  const { action, directory, name, newName, mode, uid, gid } = req.body;
  const path = childPath(remotePath(directory), name);
  if (action === 'mkdir') {
    await ensureAvailable(sftp, path);
    await call(sftp, 'mkdir', path);
  } else if (action === 'rename') {
    const destination = childPath(directory, newName);
    await ensureAvailable(sftp, destination);
    await call(sftp, 'rename', path, destination);
  } else if (action === 'update') {
    let currentPath = path;
    if (newName && newName !== name) {
      const destination = childPath(directory, newName);
      await ensureAvailable(sftp, destination);
      await call(sftp, 'rename', currentPath, destination);
      currentPath = destination;
    }
    const attrsToUpdate = {};
    if (mode !== undefined && mode !== null && mode !== '') {
      let parsedMode;
      if (typeof mode === 'string') {
        const trimmed = mode.trim();
        if (/^[0-7]{3,4}$/.test(trimmed)) {
          parsedMode = parseInt(trimmed, 8);
        } else {
          throw fail(400, '권한은 3~4자리 8진수(예: 755, 0644)여야 합니다.');
        }
      } else if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0 && mode <= 0o7777) {
        parsedMode = mode;
      } else {
        throw fail(400, '유효한 권한 값을 입력해 주세요.');
      }
      attrsToUpdate.mode = parsedMode;
    }
    const hasUid = uid !== undefined && uid !== null && uid !== '';
    const hasGid = gid !== undefined && gid !== null && gid !== '';
    if (hasUid || hasGid) {
      let parsedUid = null;
      let parsedGid = null;
      if (hasUid) {
        parsedUid = Number(uid);
        if (!Number.isInteger(parsedUid) || parsedUid < 0 || parsedUid > 4294967295) {
          throw fail(400, '유효한 UID를 입력해 주세요.');
        }
      }
      if (hasGid) {
        parsedGid = Number(gid);
        if (!Number.isInteger(parsedGid) || parsedGid < 0 || parsedGid > 4294967295) {
          throw fail(400, '유효한 GID를 입력해 주세요.');
        }
      }
      if (!hasUid || !hasGid) {
        const currentAttrs = await call(sftp, 'stat', currentPath);
        if (!hasUid) parsedUid = currentAttrs.uid;
        if (!hasGid) parsedGid = currentAttrs.gid;
      }
      attrsToUpdate.uid = parsedUid;
      attrsToUpdate.gid = parsedGid;
    }
    if (Object.keys(attrsToUpdate).length > 0) {
      await call(sftp, 'setstat', currentPath, attrsToUpdate);
    }
  } else if (action === 'delete') {
    const attrs = await call(sftp, 'lstat', path);
    if (attrs.isDirectory()) {
      const entries = await call(sftp, 'readdir', path);
      if (entries.some(({ filename }) => filename !== '.' && filename !== '..')) {
        throw fail(409, '파일이 들어 있는 폴더는 삭제할 수 없습니다.');
      }
      await call(sftp, 'rmdir', path);
    } else {
      await call(sftp, 'unlink', path);
    }
  } else throw fail(400, '지원하지 않는 파일 작업입니다.');
  res.sendStatus(204);
}, { write: true });

module.exports = { listRemoteFiles, downloadRemoteFile, uploadRemoteFile, changeRemoteFiles };
