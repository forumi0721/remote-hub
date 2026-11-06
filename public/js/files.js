'use strict';

const serverId = new URLSearchParams(location.search).get('id');
const endpoint = serverId ? `/api/servers/${encodeURIComponent(serverId)}/files` : null;
const pathInput = document.getElementById('files-path');
const entries = document.getElementById('files-entries');
const statusText = document.getElementById('files-status');
const parentButton = document.getElementById('files-parent');
const mkdirButton = document.getElementById('files-mkdir');
const fileInput = document.getElementById('files-upload');
const uploadButton = document.getElementById('files-upload-submit');
const nameDialog = document.getElementById('files-name-dialog');
const nameInput = document.getElementById('files-name');
const deleteDialog = document.getElementById('files-delete-dialog');
const transfer = document.getElementById('files-transfer');
const progress = document.getElementById('files-progress');
const progressLabel = document.getElementById('files-progress-label');
const cancelTransfer = document.getElementById('files-cancel-transfer');
const writeHeaders = { 'X-RemoteHub-File-Operation': '1' };
let directory = null;
let busy = false;
let nameOperation;
let deleteOperation;
let uploadController;

function filesUrl(suffix, query) {
  return endpoint + suffix + '?' + new URLSearchParams(query);
}

async function checked(response) {
  if (response.status === 401) {
    location.replace('/');
    throw new Error('다시 로그인해 주세요.');
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(error || `파일 작업에 실패했습니다 (${response.status}).`);
  }
  return response;
}

function syncControls() {
  pathInput.form.querySelector('[type="submit"]').disabled = busy || !endpoint;
  parentButton.disabled = busy || !directory || directory === '/';
  mkdirButton.disabled = fileInput.disabled = busy || !directory;
  uploadButton.disabled = fileInput.disabled || !fileInput.files.length;
  for (const button of entries.querySelectorAll('button')) button.disabled = busy;
  entries.setAttribute('aria-busy', String(busy));
}

async function run(message, work) {
  if (busy || !endpoint) return;
  busy = true;
  statusText.textContent = message;
  syncControls();
  try { await work(); }
  catch (error) { statusText.textContent = error.message; }
  finally {
    busy = false;
    syncControls();
  }
}

function inDirectory(name) {
  return directory.endsWith('/') ? directory + name : directory + '/' + name;
}

function nameButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function openNameDialog(action, name = '') {
  nameOperation = { action, name, directory };
  document.getElementById('files-name-title').textContent = action === 'mkdir' ? '새 폴더' : '이름 변경';
  nameInput.value = name;
  nameDialog.showModal();
  nameInput.select();
}

function openDeleteDialog(item) {
  deleteOperation = { action: 'delete', name: item.name, directory };
  document.getElementById('files-delete-description').textContent =
    `“${item.name}”을(를) 삭제할까요? ${item.type === 'directory' ? '빈 폴더만 삭제할 수 있습니다.' : '삭제한 항목은 복구할 수 없습니다.'}`;
  deleteDialog.returnValue = '';
  deleteDialog.showModal();
}

async function changeFiles(operation) {
  await checked(await apiFetch(endpoint, {
    method: 'POST',
    headers: { ...writeHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(operation)
  }));
  await loadDirectory(operation.directory);
}

deleteDialog.addEventListener('close', () => {
  if (deleteDialog.returnValue !== 'delete') return;
  const operation = deleteOperation;
  run('원격 항목을 삭제하는 중…', () => changeFiles(operation));
});

async function loadDirectory(path) {
  const response = await checked(await apiFetch(filesUrl('', { path })));
  const result = await response.json();
  directory = result.path;
  pathInput.value = directory;
  entries.replaceChildren();
  for (const item of result.entries) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item.name;
    if (item.type === 'directory' || item.type === 'symlink') {
      const open = nameButton(item.name, () => browse(inDirectory(item.name)));
      if (item.type === 'symlink') open.title = '폴더를 가리키는 링크 열기';
      row.append(open);
    } else {
      row.append(name);
    }
    if (item.type === 'file' || item.type === 'symlink') {
      const download = document.createElement('a');
      download.className = 'btn btn-secondary btn-sm';
      download.href = filesUrl('/download', { path: inDirectory(item.name) });
      download.textContent = '다운로드';
      download.setAttribute('aria-label', `${item.name} 다운로드`);
      row.append(download);
    }
    const rename = nameButton('이름 변경', () => openNameDialog('rename', item.name));
    rename.setAttribute('aria-label', `${item.name} 이름 변경`);
    const remove = nameButton('삭제', () => openDeleteDialog(item));
    remove.setAttribute('aria-label', `${item.name} 삭제`);
    row.append(rename, remove);
    entries.append(row);
  }
  statusText.textContent = result.entries.length ? `${result.entries.length}개 항목` : '빈 폴더입니다.';
}

function browse(path) {
  return run('원격 폴더를 여는 중…', () => loadDirectory(path));
}

pathInput.form.addEventListener('submit', event => {
  event.preventDefault();
  browse(pathInput.value);
});
parentButton.addEventListener('click', () => browse(directory.slice(0, directory.lastIndexOf('/')) || '/'));
mkdirButton.addEventListener('click', () => openNameDialog('mkdir'));
fileInput.addEventListener('change', syncControls);
function uploadFile(file, directory, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && event.total) progress.value = event.loaded * 100 / event.total;
    });
    xhr.upload.addEventListener('load', () => {
      progress.removeAttribute('value');
      statusText.textContent = '원격 서버에서 파일을 저장하는 중…';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) location.replace('/');
      if (xhr.status === 201) resolve();
      else reject(new Error(xhr.response?.error || `업로드에 실패했습니다 (${xhr.status}).`));
    });
    xhr.addEventListener('error', () => reject(new Error('네트워크 연결이 끊어졌습니다.')));
    xhr.addEventListener('abort', () => reject(signal.reason));
    xhr.addEventListener('loadend', () => signal.removeEventListener('abort', abort));
    xhr.open('PATCH', filesUrl('/upload', { directory, name: file.name }));
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-RemoteHub-File-Operation', writeHeaders['X-RemoteHub-File-Operation']);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

cancelTransfer.addEventListener('click', () => {
  cancelTransfer.disabled = true;
  uploadController?.abort();
});

uploadButton.addEventListener('click', () => {
  const files = [...fileInput.files];
  if (!files.length || !directory) return;
  run('업로드를 시작하는 중…', async () => {
    const target = directory;
    const controller = new AbortController();
    uploadController = controller;
    transfer.hidden = false;
    cancelTransfer.disabled = false;
    let uploaded = 0;
    const failures = [];
    try {
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) break;
        progressLabel.textContent = `업로드 ${index + 1}/${files.length} · ${file.name}`;
        progress.value = 0;
        statusText.textContent = '파일을 전송하는 중…';
        try {
          if (file.size > 1024 ** 3) throw new Error('최대 업로드 크기는 1 GiB입니다.');
          await uploadFile(file, target, controller.signal);
          uploaded++;
        } catch (error) {
          if (controller.signal.aborted) break;
          failures.push(`${file.name} · ${error.message}`);
        }
      }
    } finally {
      uploadController = null;
      transfer.hidden = true;
      fileInput.value = '';
    }
    const summary = [`${files.length}개 중 ${uploaded}개 업로드 완료.`];
    if (controller.signal.aborted) summary.push('남은 전송을 취소했습니다.');
    if (failures.length) summary.push(`${failures.length}개 실패. ${failures.join(' / ')}`);
    try { await loadDirectory(target); }
    catch (error) { summary.push(`목록 새로고침 실패. ${error.message}`); }
    statusText.textContent = summary.join(' ');
  });
});

document.getElementById('files-name-cancel').addEventListener('click', () => nameDialog.close());
nameInput.form.addEventListener('submit', event => {
  event.preventDefault();
  const { action, name, directory: target } = nameOperation;
  const value = nameInput.value;
  if (action === 'rename' && value === name) return nameDialog.close();
  nameDialog.close();
  run('원격 파일 작업 중…', () => changeFiles({
    action, directory: target, name: action === 'mkdir' ? value : name, newName: value
  }));
});

if (endpoint) {
  const terminal = document.getElementById('files-terminal');
  terminal.href = '/viewer.html?' + new URLSearchParams({ id: serverId });
  terminal.hidden = false;
  run('SSH 서버 정보를 불러오는 중…', async () => {
    const info = await (await checked(await apiFetch(endpoint.replace(/\/files$/, '/connection')))).json();
    if (info.protocol !== 'ssh') throw new Error('SSH 서버만 파일 관리를 사용할 수 있습니다.');
    document.getElementById('files-title').textContent = `${info.name} 파일 관리`;
    await loadDirectory('.');
  });
} else {
  syncControls();
  statusText.textContent = '서버 목록에서 SSH 서버의 파일 메뉴를 선택해 주세요.';
}
