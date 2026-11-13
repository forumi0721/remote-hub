'use strict';

const serverId = new URLSearchParams(location.search).get('id');
const endpoint = serverId ? `/api/servers/${encodeURIComponent(serverId)}/files` : null;
const pathInput = document.getElementById('files-path');
const entries = document.getElementById('files-entries');
const statusText = document.getElementById('files-status');
const emptyState = document.getElementById('files-empty');
const countText = document.getElementById('files-count');
const breadcrumbs = document.getElementById('files-breadcrumbs');
const searchInput = document.getElementById('files-search');
const parentButton = document.getElementById('files-parent');
const backButton = document.getElementById('files-back');
const forwardButton = document.getElementById('files-forward');
const refreshButton = document.getElementById('files-refresh');
const mkdirButton = document.getElementById('files-mkdir');
const fileInput = document.getElementById('files-upload');
const uploadButton = document.getElementById('files-upload-submit');
const nameDialog = document.getElementById('files-name-dialog');
const nameInput = document.getElementById('files-name');
const modeInput = document.getElementById('files-mode');
const uidInput = document.getElementById('files-uid');
const gidInput = document.getElementById('files-gid');
const editFields = document.getElementById('files-edit-fields');
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
let directoryEntries = [];
let sortKey = 'name';
let sortDirection = 'asc';
let history = [];
let historyIndex = -1;

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
  backButton.disabled = busy || historyIndex <= 0;
  forwardButton.disabled = busy || historyIndex < 0 || historyIndex >= history.length - 1;
  refreshButton.disabled = busy || !directory;
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

function formatSize(size, type) {
  if (type === 'directory') return '—';
  if (!Number.isFinite(size) || size < 0) return '—';
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function updateBreadcrumbs() {
  breadcrumbs.replaceChildren();
  if (!directory) return;
  const parts = directory.split('/').filter(Boolean);
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'file-crumb';
  root.textContent = parts.length ? '루트' : directory;
  root.addEventListener('click', () => browse('/'));
  breadcrumbs.append(root);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    const separator = document.createElement('span');
    separator.textContent = '/';
    separator.className = 'file-crumb-separator';
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'file-crumb';
    crumb.textContent = part;
    const target = current;
    crumb.addEventListener('click', () => browse(target));
    breadcrumbs.append(separator, crumb);
  }
}

function renderEntries() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const visible = directoryEntries.filter(item => item.name.toLocaleLowerCase().includes(query));
  
  // Sort visible items
  visible.sort((a, b) => {
    // Keep directories first if desired, or sort strictly by column
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    let comparison = 0;
    if (sortKey === 'name') {
      comparison = a.name.localeCompare(b.name, 'ko', { numeric: true });
    } else if (sortKey === 'type') {
      const typeA = a.type === 'directory' ? '폴더' : a.type === 'symlink' ? '링크' : '파일';
      const typeB = b.type === 'directory' ? '폴더' : b.type === 'symlink' ? '링크' : '파일';
      comparison = typeA.localeCompare(typeB, 'ko');
    } else if (sortKey === 'size') {
      const sizeA = Number.isFinite(a.size) ? a.size : -1;
      const sizeB = Number.isFinite(b.size) ? b.size : -1;
      comparison = sizeA - sizeB;
    } else if (sortKey === 'modifiedAt') {
      const dateA = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
      const dateB = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
      comparison = dateA - dateB;
    }
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  // Update sort button indicators in header
  for (const btn of document.querySelectorAll('.file-sort-btn')) {
    const key = btn.dataset.sort;
    const icon = btn.querySelector('.sort-icon');
    if (key === sortKey) {
      btn.classList.add('active-sort');
      if (icon) icon.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼';
    } else {
      btn.classList.remove('active-sort');
      if (icon) icon.textContent = ' ⇅';
    }
  }

  entries.replaceChildren();
  emptyState.hidden = visible.length !== 0;
  countText.textContent = `${visible.length}개`;
  for (const item of visible) {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.tabIndex = 0;
    row.dataset.name = item.name;
    row.dataset.type = item.type;
    const main = document.createElement('div');
    main.className = 'file-name-cell';
    const icon = document.createElement('span');
    icon.className = `file-type-icon ${item.type}`;
    icon.textContent = item.type === 'directory' ? '▰' : item.type === 'symlink' ? '↗' : '▱';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.name;
    main.append(icon, name);
    const type = document.createElement('span');
    type.className = 'file-meta file-meta-center';
    type.textContent = item.type === 'directory' ? '폴더' : item.type === 'symlink' ? '링크' : '파일';
    const size = document.createElement('span');
    size.className = 'file-meta file-meta-center';
    size.textContent = formatSize(item.size, item.type);
    const modified = document.createElement('span');
    modified.className = 'file-meta file-meta-center';
    modified.textContent = formatDate(item.modifiedAt);
    const actions = document.createElement('span');
    actions.className = 'file-row-actions';
    if (item.type === 'file' || item.type === 'symlink') {
      const download = document.createElement('a');
      download.className = 'btn btn-secondary btn-xs';
      download.href = filesUrl('/download', { path: inDirectory(item.name) });
      download.textContent = '다운로드';
      download.setAttribute('aria-label', `${item.name} 다운로드`);
      actions.append(download);
    }
    const edit = nameButton('수정', () => openNameDialog('update', item));
    edit.setAttribute('aria-label', `${item.name} 수정`);
    const remove = nameButton('삭제', () => openDeleteDialog(item));
    remove.setAttribute('aria-label', `${item.name} 삭제`);
    actions.append(edit, remove);
    row.append(main, type, size, modified, actions);
    const open = () => {
      if (item.type === 'directory' || item.type === 'symlink') browse(inDirectory(item.name));
    };
    row.addEventListener('dblclick', open);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') open();
    });
    row.addEventListener('click', event => {
      if (event.target.closest('button, a')) return;
      entries.querySelector('.selected')?.classList.remove('selected');
      row.classList.add('selected');
    });
    entries.append(row);
  }
}

function nameButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function openNameDialog(action, itemOrName = '') {
  if (action === 'update' && typeof itemOrName === 'object') {
    const item = itemOrName;
    nameOperation = { action, name: item.name, directory, item };
    document.getElementById('files-name-title').textContent = '파일/폴더 수정';
    nameInput.value = item.name;
    editFields.hidden = false;
    modeInput.required = false;
    modeInput.value = item.mode ? (item.mode & 0o7777).toString(8) : '';
    uidInput.value = item.uid !== undefined && item.uid !== null ? item.uid : '';
    gidInput.value = item.gid !== undefined && item.gid !== null ? item.gid : '';
  } else {
    const name = typeof itemOrName === 'string' ? itemOrName : '';
    nameOperation = { action, name, directory };
    document.getElementById('files-name-title').textContent = action === 'mkdir' ? '새 폴더' : '이름 변경';
    nameInput.value = name;
    editFields.hidden = true;
    modeInput.value = '';
    uidInput.value = '';
    gidInput.value = '';
  }
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
  directoryEntries = [...result.entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, 'ko');
  });
  updateBreadcrumbs();
  renderEntries();
  statusText.textContent = directoryEntries.length ? `${directoryEntries.length}개 항목` : '빈 폴더입니다.';
}

function browse(path) {
  return run('원격 폴더를 여는 중…', async () => {
    await loadDirectory(path);
    if (history[historyIndex] !== directory) {
      history = history.slice(0, historyIndex + 1);
      history.push(directory);
      historyIndex = history.length - 1;
    }
    syncControls();
  });
}

pathInput.form.addEventListener('submit', event => {
  event.preventDefault();
  browse(pathInput.value);
});
parentButton.addEventListener('click', () => browse(directory.slice(0, directory.lastIndexOf('/')) || '/'));
backButton.addEventListener('click', () => {
  if (historyIndex <= 0) return;
  run('이전 폴더를 여는 중…', async () => {
    historyIndex--;
    await loadDirectory(history[historyIndex]);
    syncControls();
  });
});
forwardButton.addEventListener('click', () => {
  if (historyIndex >= history.length - 1) return;
  run('다음 폴더를 여는 중…', async () => {
    historyIndex++;
    await loadDirectory(history[historyIndex]);
    syncControls();
  });
});
refreshButton.addEventListener('click', () => browse(directory));
mkdirButton.addEventListener('click', () => openNameDialog('mkdir'));
fileInput.addEventListener('change', syncControls);
searchInput.addEventListener('input', renderEntries);
for (const btn of document.querySelectorAll('.file-sort-btn')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    if (sortKey === key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDirection = 'asc';
    }
    renderEntries();
  });
}
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
  const { action, name, directory: target, item } = nameOperation;
  const value = nameInput.value.trim();

  if (action === 'mkdir') {
    nameDialog.close();
    run('원격 파일 작업 중…', () => changeFiles({
      action: 'mkdir', directory: target, name: value
    }));
  } else if (action === 'rename') {
    if (value === name) return nameDialog.close();
    nameDialog.close();
    run('원격 파일 작업 중…', () => changeFiles({
      action: 'rename', directory: target, name, newName: value
    }));
  } else if (action === 'update') {
    const rawMode = modeInput.value.trim();
    const rawUid = uidInput.value.trim();
    const rawGid = gidInput.value.trim();
    const payload = {
      action: 'update',
      directory: target,
      name,
      newName: value !== name ? value : undefined,
      mode: rawMode ? rawMode : undefined,
      uid: rawUid !== '' ? Number(rawUid) : undefined,
      gid: rawGid !== '' ? Number(rawGid) : undefined
    };
    nameDialog.close();
    run('원격 파일 수정 중…', () => changeFiles(payload));
  }
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
    history = [directory];
    historyIndex = 0;
    syncControls();
  });
} else {
  syncControls();
  statusText.textContent = '서버 목록에서 SSH 서버의 파일 메뉴를 선택해 주세요.';
}
