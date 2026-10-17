// 상태 저장
let serversData = [];
let activeSessionsData = [];
let visibleServerIds = [];
let loading = false;
let currentGroupFilter = 'ALL';
let appStatus = {
  authEnabled: false,
  isAuthenticated: false
};

// 헬퍼: 모달 열기/닫기
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// 1. 앱 초기 상태 확인
async function checkStatus() {
  try {
    const res = await apiFetch('/api/status');
    const status = await res.json();
    if (!res.ok) throw new Error(status.error || '서비스 상태를 확인하지 못했습니다.');
    appStatus = status;

    const btnLogout = document.getElementById('btn-logout');
    if (appStatus.authEnabled && appStatus.isAuthenticated) {
      btnLogout.style.display = 'inline-flex';
    } else {
      btnLogout.style.display = 'none';
    }

    if (appStatus.authEnabled && !appStatus.isAuthenticated) {
      openModal('modal-login');
      return false;
    } else {
      closeModal('modal-login');
      return true;
    }
  } catch (err) {
    renderLoadError(err.message);
    return false;
  }
}

// 2. 서버 목록 로드
function renderLoadError(message) {
  document.getElementById('servers-grid').innerHTML = `<div class="empty-state" role="alert"><h3>서버 목록을 불러오지 못했습니다.</h3><p>${escapeHtml(message)}</p><button class="btn btn-primary" onclick="loadServers()">다시 시도</button></div>`;
  document.getElementById('list-summary').textContent = '연결 상태를 확인하고 다시 시도해 주세요.';
}
async function loadServers() {
  if (loading) return;
  loading = true;
  const refresh = document.getElementById('btn-refresh');
  refresh.disabled = true;
  refresh.textContent = '확인 중…';
  document.getElementById('servers-grid').setAttribute('aria-busy', 'true');
  try {
    if (!await checkStatus()) return;
    const [serversRes, sessionsRes] = await Promise.all([apiFetch('/api/servers'), apiFetch('/api/sessions').catch(() => null)]);
    if (serversRes.status === 401) { openModal('modal-login'); return; }
    const servers = await serversRes.json();
    if (!serversRes.ok || !Array.isArray(servers)) throw new Error(servers.error || '서버 목록을 확인하지 못했습니다.');
    serversData = servers;
    activeSessionsData = [];
    if (sessionsRes?.ok) activeSessionsData = (await sessionsRes.json()).sessions || [];
    updateActiveSessionsBanner();
    updateGroupUI();
    filterAndRenderServers();
    if (!sessionsRes?.ok) showNotice('SSH 세션 상태를 확인하지 못했습니다. 상태 새로고침을 눌러 다시 확인해 주세요.');
  } catch (err) { renderLoadError(err.message); }
  finally {
    loading = false;
    refresh.disabled = false;
    refresh.textContent = '상태 새로고침';
    document.getElementById('servers-grid').setAttribute('aria-busy', 'false');
  }
}

// 활성 세션 요약 배너 업데이트
function updateActiveSessionsBanner() {
  const banner = document.getElementById('active-sessions-banner');
  const bannerText = document.getElementById('active-sessions-summary-text');
  if (!banner) return;

  const activeServerIds = new Set(activeSessionsData.map(s => s.serverId));
  banner.style.display = activeServerIds.size ? 'flex' : 'none';
  bannerText.textContent = `${activeServerIds.size}개 서버에서 SSH 세션 ${activeSessionsData.length}개가 실행 중입니다.`;
}

// 그룹 UI 갱신 (상단 필터 바 및 모달 datalist)
function updateGroupUI() {
  // 모달 그룹 입력창용 datalist 채우기
  const groupDatalist = document.getElementById('group-datalist');
  const groups = new Set();
  serversData.forEach(s => {
    if (s.group && s.group.trim()) {
      groups.add(s.group.trim());
    }
  });

  if (groupDatalist) {
    groupDatalist.innerHTML = Array.from(groups).sort()
      .map(g => `<option value="${escapeHtml(g)}">`)
      .join('');
  }

  // 상단 그룹 필터 탭 바 렌더링
  const filterBar = document.getElementById('group-filter-bar');
  if (!filterBar) return;

  if (groups.size === 0) {
    filterBar.style.display = 'none';
    filterBar.innerHTML = '';
    return;
  }

  filterBar.style.display = 'flex';

  const groupCounts = Object.create(null);
  let ungroupedCount = 0;
  serversData.forEach(s => {
    const g = s.group ? s.group.trim() : '';
    if (g) {
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    } else {
      ungroupedCount++;
    }
  });

  let html = `
    <button type="button" class="group-filter-btn ${currentGroupFilter === 'ALL' ? 'active' : ''}" data-group="ALL">
      전체 (${serversData.length})
    </button>
  `;

  Array.from(groups).sort().forEach(g => {
    const isActive = currentGroupFilter === g ? 'active' : '';
    html += `
      <button type="button" class="group-filter-btn ${isActive}" data-group="${escapeHtml(g)}">
        📁 ${escapeHtml(g)} (${groupCounts[g] || 0})
      </button>
    `;
  });

  if (ungroupedCount > 0) {
    const isActive = currentGroupFilter === '__UNGROUPED__' ? 'active' : '';
    html += `
      <button type="button" class="group-filter-btn ${isActive}" data-group="__UNGROUPED__">
        기타/미분류 (${ungroupedCount})
      </button>
    `;
  }

  filterBar.innerHTML = html;
  filterBar.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
}

document.getElementById('group-filter-bar').addEventListener('click', event => {
  const button = event.target.closest('[data-group]');
  if (button) selectGroupFilter(button.dataset.group);
});

window.selectGroupFilter = function(groupName) {
  currentGroupFilter = groupName;
  updateGroupUI();
  filterAndRenderServers();
};

window.filterByTag = function(tag) {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = '#' + tag;
    filterAndRenderServers();
  }
};

function filterAndRenderServers() {
  const searchInput = document.getElementById('search-input');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  const filtered = serversData.filter(s => {
    // 1. 그룹 필터링
    if (currentGroupFilter !== 'ALL') {
      if (currentGroupFilter === '__UNGROUPED__') {
        if (s.group && s.group.trim()) return false;
      } else {
        if (!s.group || s.group.trim() !== currentGroupFilter) return false;
      }
    }

    // 2. 검색어 필터링
    if (query) {
      const matchName = s.name && s.name.toLowerCase().includes(query);
      const matchHost = s.host && s.host.toLowerCase().includes(query);
      const matchDesc = s.description && s.description.toLowerCase().includes(query);
      const matchGroup = s.group && s.group.toLowerCase().includes(query);
      const tagQuery = query.startsWith('#') ? query.slice(1).trim() : query;
      const matchTags = Array.isArray(s.tags) && s.tags.some(t => 
        t.toLowerCase().includes(tagQuery)
      );
      if (!matchName && !matchHost && !matchDesc && !matchGroup && !matchTags) {
        return false;
      }
    }

    return true;
  });

  renderServers(filtered);
  filtered.forEach(s => checkServerPing(s.id));
}

let draggedServerId = null;

// 3. 서버 카드 렌더링
function renderServers(servers) {
  const grid = document.getElementById('servers-grid');
  visibleServerIds = servers.map(s => s.id);
  document.getElementById('list-summary').textContent = `서버 ${serversData.length}개 중 ${servers.length}개 표시 · 상태 확인 ${new Date().toLocaleTimeString('ko-KR')}`;
  if (!servers.length) {
    const filtered = serversData.length > 0;
    grid.innerHTML = `<div class="empty-state"><h3>${filtered ? '검색 결과가 없습니다.' : '등록된 원격 서버가 없습니다.'}</h3><p>${filtered ? '검색어나 그룹 필터를 바꿔 보세요.' : 'VNC, RDP 또는 SSH 서버를 등록해 접속하세요.'}</p><button class="btn btn-primary" onclick="${filtered ? 'clearFilters()' : 'openAddServerModal()'}">${filtered ? '필터 초기화' : '첫 서버 추가'}</button></div>`;
    return;
  }
  let openTabs = [];
  try { const saved = JSON.parse(localStorage.getItem('remotehub_open_tabs') || '[]'); if (Array.isArray(saved)) openTabs = saved; } catch (_) {}
  grid.innerHTML = servers.map((server, index) => {
    const protocol = server.protocol || 'vnc';
    const id = escapeHtml(server.id);
    const endpoint = `${server.host}:${server.port}${server.username ? ` (${server.username})` : ''}`;
    const sessionCount = activeSessionsData.filter(session => session.serverId === server.id).length;
    const previousTab = openTabs.some(tab => tab.serverId === server.id);
    const badge = sessionCount ? `<span class="active-session-badge">SSH 세션 ${sessionCount}개 실행 중</span>` : previousTab ? '<span class="previous-tab-badge">이전에 열었던 탭</span>' : '';
    const connect = sessionCount ? '이어서 접속' : protocol === 'ssh' ? '터미널 접속' : '접속하기';
    return `<article class="server-card" id="card-${id}" draggable="true" data-id="${id}">
      <div>
        <div class="card-header"><div class="card-metadata"><span class="protocol-badge ${protocol}">${protocol}</span>${server.group ? `<span class="group-badge">${escapeHtml(server.group)}</span>` : ''}</div><span class="status-badge checking" id="badge-${id}">확인 중</span></div>
        <h3 class="card-title">${escapeHtml(server.name)}</h3>
        <div class="card-body"><div class="server-endpoint">${escapeHtml(endpoint)}</div>${badge}
          ${server.initialCommand ? `<div class="initial-command" title="시작 명령">${escapeHtml(server.initialCommand)}</div>` : ''}
          ${server.description ? `<p class="server-desc">${escapeHtml(server.description)}</p>` : ''}
          <div class="tags-container">${(server.tags || []).map(tag => `<button type="button" class="tag-badge" data-action="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join('')}</div>
        </div>
      </div>
      <div class="card-footer"><div class="connect-actions"><a href="/viewer.html?id=${encodeURIComponent(server.id)}" class="btn ${sessionCount ? 'btn-continue' : 'btn-primary'} btn-sm">${connect}</a>${sessionCount ? `<a href="/viewer.html?id=${encodeURIComponent(server.id)}&forceNew=1" class="btn btn-secondary btn-sm">새 세션</a>` : ''}</div>
        <details class="card-menu"><summary class="btn btn-secondary btn-sm" aria-label="${escapeHtml(server.name)} 서버 관리">⋯</summary><div class="card-menu-panel">
          <button data-action="edit" data-id="${id}">서버 수정</button>
          <button data-action="up" data-id="${id}" ${index === 0 ? 'disabled' : ''}>위로 이동</button>
          <button data-action="down" data-id="${id}" ${index === servers.length - 1 ? 'disabled' : ''}>아래로 이동</button>
          ${sessionCount ? `<button class="danger-text" data-action="terminate" data-id="${id}">SSH 세션 모두 종료</button>` : ''}
          <button class="danger-text" data-action="delete" data-id="${id}">서버 삭제</button>
        </div></details>
      </div>
    </article>`;
  }).join('');
  setupDragAndDrop();
}
function clearFilters() {
  currentGroupFilter = 'ALL';
  document.getElementById('search-input').value = '';
  updateGroupUI();
  filterAndRenderServers();
}
document.getElementById('servers-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, tag } = button.dataset;
  if (action === 'tag') filterByTag(tag);
  else if (action === 'edit') openEditServerModal(id);
  else if (action === 'delete') deleteServer(id, serversData.find(server => server.id === id)?.name || '');
  else if (action === 'terminate') terminateServerSessions(id);
  else moveServerOrder(id, action === 'up' ? -1 : 1);
  button.closest('details')?.removeAttribute('open');
});

window.terminateServerSessions = async function(serverId) {
  if (!confirm('이 서버에서 실행 중인 백그라운드 세션을 모두 종료하시겠습니까?')) return;
  try {
    const serverSessions = activeSessionsData.filter(sess => sess.serverId === serverId);
    for (const sess of serverSessions) {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(sess.key)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || '세션을 종료하지 못했습니다.');
    }
    try {
      const openTabs = JSON.parse(localStorage.getItem('remotehub_open_tabs') || '[]');
      const filtered = openTabs.filter(t => t.serverId !== serverId);
      localStorage.setItem('remotehub_open_tabs', JSON.stringify(filtered));
    } catch (_) {}

    await loadServers();
  } catch (err) {
    showNotice('세션 종료 실패: ' + err.message);
  }
};

// 드래그 앤 드롭 순서 변경 설정
function setupDragAndDrop() {
  const cards = document.querySelectorAll('.server-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, a, details')) { e.preventDefault(); return; }
      draggedServerId = card.getAttribute('data-id');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedServerId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));
      draggedServerId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = card.getAttribute('data-id');
      if (!draggedServerId || draggedServerId === targetId) return;

      const fromIndex = serversData.findIndex(s => s.id === draggedServerId);
      const toIndex = serversData.findIndex(s => s.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return;

      const newServers = [...serversData];
      const [moved] = newServers.splice(fromIndex, 1);
      newServers.splice(toIndex, 0, moved);

      await saveServerOrder(newServers.map(s => s.id));
    });
  });
}

// 화살표 버튼으로 순서 이동
async function moveServerOrder(id, direction) {
  const visibleIndex = visibleServerIds.indexOf(id);
  const targetId = visibleServerIds[visibleIndex + direction];
  if (visibleIndex < 0 || !targetId) return;
  const from = serversData.findIndex(server => server.id === id);
  const to = serversData.findIndex(server => server.id === targetId);
  const reordered = [...serversData];
  [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
  await saveServerOrder(reordered.map(server => server.id));
}

// 서버 순서 서버에 저장
async function saveServerOrder(serverIds) {
  try {
    const res = await apiFetch('/api/servers/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverIds })
    });

    if (!res.ok) {
      const err = await res.json();
      showNotice('순서 저장 실패: ' + (err.error || '알 수 없는 오류'));
      return;
    }

    serversData = await res.json();
    updateGroupUI();
    filterAndRenderServers();
  } catch (err) {
    console.error('Failed to save server order:', err);
    showNotice('순서 변경 중 오류 발생: ' + err.message);
  }
}

// 4. 각 서버 포트 핑 체크
async function checkServerPing(id) {
  const badge = document.getElementById(`badge-${id}`);
  if (!badge) return;

  try {
    const res = await apiFetch(`/api/servers/${id}/ping`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '상태 확인 실패');
    const checkedAt = new Date().toLocaleTimeString('ko-KR');
    if (data.online) {
      badge.className = 'status-badge online';
      badge.title = `포트 응답 ${data.latency}ms · 확인 ${checkedAt}`;
      badge.innerHTML = `<span class="dot">●</span> ${data.latency}ms`;
    } else {
      badge.className = 'status-badge offline';
      badge.title = `포트 응답 없음 · 확인 ${checkedAt}`;
      badge.textContent = '응답 없음';
    }
  } catch (err) {
    badge.className = 'status-badge offline';
    badge.title = '확인 불가';
    badge.textContent = '확인 실패';
  }
}

function checkAllServersPing() {
  serversData.forEach(s => checkServerPing(s.id));
}

// 프리셋 명령어 채우기 헬퍼
window.setCmdPreset = function(cmd) {
  const input = document.getElementById('server-initial-cmd');
  if (input) input.value = cmd;
};

// 키 파일 읽기 이벤트 리스너
const inputKeyFile = document.getElementById('input-key-file');
if (inputKeyFile) {
  inputKeyFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      document.getElementById('server-private-key').value = evt.target.result;
    };
    reader.readAsText(file);
  });
}

// 프로토콜 폼 변경 핸들러
function handleProtocolChange(protocol) {
  const portInput = document.getElementById('server-port');
  const userGroup = document.getElementById('credential-user-group');
  const userLabel = document.getElementById('label-server-username');
  const domainGroup = document.getElementById('group-server-domain');
  const sshAuthGroup = document.getElementById('ssh-auth-type-group');
  const sshKeyFields = document.getElementById('ssh-key-fields');
  const sshStartupFields = document.getElementById('ssh-startup-fields');
  const pwGroup = document.getElementById('group-server-password');
  const pwLabel = document.getElementById('label-server-password');

  const authType = document.querySelector('input[name="ssh-auth-type"]:checked')?.value || 'password';

  if (protocol === 'ssh') {
    if (portInput.value === '5900' || portInput.value === '3389') {
      portInput.value = '22';
    }
    userGroup.style.display = 'block';
    userLabel.textContent = 'SSH 사용자 이름 (Username)';
    domainGroup.style.display = 'none';
    sshAuthGroup.style.display = 'block';
    sshStartupFields.style.display = 'block';

    if (authType === 'key') {
      pwGroup.style.display = 'none';
      sshKeyFields.style.display = 'block';
    } else {
      pwGroup.style.display = 'block';
      pwLabel.textContent = 'SSH 비밀번호 (선택사항)';
      sshKeyFields.style.display = 'none';
    }
  } else if (protocol === 'rdp') {
    if (portInput.value === '5900' || portInput.value === '22') {
      portInput.value = '3389';
    }
    userGroup.style.display = 'block';
    userLabel.textContent = 'RDP 사용자 이름 (Username)';
    domainGroup.style.display = 'block';
    sshAuthGroup.style.display = 'none';
    sshKeyFields.style.display = 'none';
    sshStartupFields.style.display = 'none';
    pwGroup.style.display = 'block';
    pwLabel.textContent = 'RDP 비밀번호 (선택사항)';
  } else {
    // VNC
    if (portInput.value === '3389' || portInput.value === '22') {
      portInput.value = '5900';
    }
    userGroup.style.display = 'none';
    domainGroup.style.display = 'none';
    sshAuthGroup.style.display = 'none';
    sshKeyFields.style.display = 'none';
    sshStartupFields.style.display = 'none';
    pwGroup.style.display = 'block';
    pwLabel.textContent = 'VNC 비밀번호 (선택사항)';
  }
}

// SSH 인증방식(비밀번호 vs 키) 라디오 이벤트 리스너
document.querySelectorAll('input[name="ssh-auth-type"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const protocol = document.querySelector('input[name="server-protocol"]:checked')?.value;
    if (protocol === 'ssh') {
      handleProtocolChange('ssh');
    }
  });
});

// 5. 서버 추가 모달 열기
function openAddServerModal() {
  document.getElementById('modal-server-title').textContent = '새 원격 서버 추가';
  document.getElementById('server-optional').open = false;
  document.getElementById('server-id').value = '';
  document.getElementById('server-name').value = '';
  document.getElementById('server-host').value = '';
  document.getElementById('server-port').value = '5900';
  document.getElementById('server-username').value = '';
  document.getElementById('server-domain').value = '';
  document.getElementById('server-password').value = '';
  document.getElementById('server-private-key').value = '';
  document.getElementById('server-passphrase').value = '';
  document.getElementById('server-initial-cmd').value = '';
  document.getElementById('server-group').value = '';
  document.getElementById('server-tags').value = '';
  document.getElementById('server-desc').value = '';
  document.getElementById('server-pw-hint').style.display = 'none';
  document.getElementById('server-key-hint').style.display = 'none';

  const radioVnc = document.querySelector('input[name="server-protocol"][value="vnc"]');
  if (radioVnc) radioVnc.checked = true;

  const radioAuthPw = document.querySelector('input[name="ssh-auth-type"][value="password"]');
  if (radioAuthPw) radioAuthPw.checked = true;

  handleProtocolChange('vnc');
  openModal('modal-server');
}

// 6. 서버 수정 모달 열기
function openEditServerModal(id) {
  const server = serversData.find(s => s.id === id);
  if (!server) return;

  const protocol = server.protocol || 'vnc';
  const authType = server.authType || 'password';

  document.getElementById('modal-server-title').textContent = '원격 서버 정보 수정';
  document.getElementById('server-optional').open = Boolean(server.group || server.tags?.length || server.description);
  document.getElementById('server-id').value = server.id;
  document.getElementById('server-name').value = server.name;
  document.getElementById('server-host').value = server.host;
  document.getElementById('server-port').value = server.port;
  document.getElementById('server-username').value = server.username || '';
  document.getElementById('server-domain').value = server.domain || '';
  document.getElementById('server-password').value = '';
  document.getElementById('server-private-key').value = '';
  document.getElementById('server-passphrase').value = '';
  document.getElementById('server-initial-cmd').value = server.initialCommand || '';
  document.getElementById('server-group').value = server.group || '';
  document.getElementById('server-tags').value = (server.tags || []).join(', ');
  document.getElementById('server-desc').value = server.description || '';
  
  const radio = document.querySelector(`input[name="server-protocol"][value="${protocol}"]`);
  if (radio) radio.checked = true;

  const authRadio = document.querySelector(`input[name="ssh-auth-type"][value="${authType}"]`);
  if (authRadio) authRadio.checked = true;

  handleProtocolChange(protocol);

  const pwHint = document.getElementById('server-pw-hint');
  pwHint.style.display = server.hasPassword ? 'block' : 'none';

  const keyHint = document.getElementById('server-key-hint');
  keyHint.style.display = server.hasPrivateKey ? 'block' : 'none';

  openModal('modal-server');
}

// 7. 서버 저장 (추가/수정)
document.getElementById('form-server').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('server-id').value;
  const protocol = document.querySelector('input[name="server-protocol"]:checked')?.value || 'vnc';
  const authType = document.querySelector('input[name="ssh-auth-type"]:checked')?.value || 'password';
  const name = document.getElementById('server-name').value.trim();
  const host = document.getElementById('server-host').value.trim();
  const port = parseInt(document.getElementById('server-port').value, 10);
  const username = document.getElementById('server-username').value.trim();
  const domain = document.getElementById('server-domain').value.trim();
  const password = document.getElementById('server-password').value;
  const privateKey = document.getElementById('server-private-key').value.trim();
  const passphrase = document.getElementById('server-passphrase').value;
  const initialCommand = document.getElementById('server-initial-cmd').value.trim();
  const group = document.getElementById('server-group').value.trim();
  const tags = document.getElementById('server-tags').value.trim();
  const description = document.getElementById('server-desc').value.trim();

  const payload = {
    protocol,
    authType,
    name,
    host,
    port,
    username,
    domain,
    initialCommand,
    group,
    tags,
    description
  };

  // 비밀번호 입력 처리
  if (password || (!id && authType === 'password')) {
    payload.password = password;
  }
  // 개인키 입력 처리
  if (privateKey || (!id && authType === 'key')) {
    payload.privateKey = privateKey;
    payload.passphrase = passphrase;
  } else if (passphrase) {
    payload.passphrase = passphrase;
  }

  const form = e.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  setFormBusy(form, true);
  try {
    let res;
    if (id) {
      res = await apiFetch(`/api/servers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await apiFetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      showNotice(err.error || '저장에 실패했습니다.');
      return;
    }

    closeModal('modal-server');
    showNotice('서버가 저장되었습니다.', false);
    await loadServers();
  } catch (err) {
    showNotice('요청 중 오류가 발생했습니다: ' + err.message);
  } finally { setFormBusy(form, false); }
});

// 프로토콜 라디오 버튼 이벤트 등록
document.querySelectorAll('input[name="server-protocol"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    handleProtocolChange(e.target.value);
  });
});

// 8. 서버 삭제
async function deleteServer(id, name) {
  if (!confirm(`정말 "${name}" 서버를 삭제하시겠습니까?`)) {
    return;
  }

  try {
    const res = await apiFetch(`/api/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      showNotice(err.error || '삭제 실패');
      return;
    }
    loadServers();
  } catch (err) {
    showNotice('삭제 중 오류 발생: ' + err.message);
  }
}

// 9. 환경설정 모달 열기
document.getElementById('btn-open-settings').addEventListener('click', async () => {
  if (!await checkStatus()) return;
  const authCheckbox = document.getElementById('setting-auth-enabled');
  const authFields = document.getElementById('auth-fields');
  const groupCurrent = document.getElementById('group-current-password');

  authCheckbox.checked = appStatus.authEnabled;
  authFields.style.display = appStatus.authEnabled ? 'block' : 'none';
  groupCurrent.style.display = appStatus.authEnabled ? 'block' : 'none';

  document.getElementById('setting-current-password').value = '';
  document.getElementById('setting-new-password').value = '';
  document.getElementById('setting-confirm-password').value = '';

  openModal('modal-settings');
});

// 환경설정 체크박스 토글
document.getElementById('setting-auth-enabled').addEventListener('change', (e) => {
  const authFields = document.getElementById('auth-fields');
  authFields.style.display = e.target.checked ? 'block' : 'none';
  document.getElementById('group-current-password').style.display = appStatus.authEnabled ? 'block' : 'none';
});

// 환경설정 폼 제출
document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = document.getElementById('setting-auth-enabled').checked;
  const currentPassword = document.getElementById('setting-current-password').value;
  const newPassword = document.getElementById('setting-new-password').value;
  const confirmPassword = document.getElementById('setting-confirm-password').value;

  if (enabled && newPassword && newPassword !== confirmPassword) {
    showNotice('새 마스터 비밀번호가 일치하지 않습니다.');
    return;
  }

  const form = e.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  setFormBusy(form, true);
  try {
    const res = await apiFetch('/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showNotice(data.error || '설정 저장 실패');
      return;
    }

    showNotice('설정이 저장되었습니다.', false);
    closeModal('modal-settings');
    loadServers();
  } catch (err) {
    showNotice('설정 저장 중 오류: ' + err.message);
  } finally { setFormBusy(form, false); }
});

// 10. 로그인 폼 제출
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errorBox = document.getElementById('login-error');
  errorBox.style.display = 'none';

  const form = e.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  setFormBusy(form, true);
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorBox.textContent = data.error || '로그인 실패';
      errorBox.style.display = 'block';
      return;
    }

    closeModal('modal-login');
    document.getElementById('login-password').value = '';
    loadServers();
  } catch (err) {
    errorBox.textContent = '로그인 요청 중 오류 발생: ' + err.message;
    errorBox.style.display = 'block';
  } finally { setFormBusy(form, false); }
});

// 11. 로그아웃
document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('로그아웃 하시겠습니까?')) return;
  try {
    const response = await apiFetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('로그아웃하지 못했습니다.');
    window.location.reload();
  } catch (err) { showNotice(err.message); }
});

// 12. 검색 필터
let searchTimer;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(filterAndRenderServers, 150);
});

// 유틸: HTML escape
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 이벤트 리스너 등록
document.getElementById('btn-open-add-server').addEventListener('click', openAddServerModal);

document.getElementById('btn-refresh').addEventListener('click', loadServers);
window.addEventListener('focus', () => { if (!document.querySelector('.modal-overlay.active')) loadServers(); });
// 초기 실행
loadServers();
